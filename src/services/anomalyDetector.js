import pool from '../db/database.js';
import logger from '../config/logger.js';
import { emitirAlertaSeguridad } from './notificationService.js';

const upsertAlerta = async (alerta) => {
  const { rows: [row] } = await pool.query(
    `INSERT INTO security_alerts
       (regla, tipo, severidad, usuario_uuid, ip, dedupe_key, titulo, detalle, entidad_tipo, entidad_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (dedupe_key) DO UPDATE
       SET ocurrencias   = security_alerts.ocurrencias + 1,
           ultima_vez_at = NOW(),
           detalle       = EXCLUDED.detalle
     RETURNING (xmax = 0) AS es_nueva`,
    [
      alerta.regla, alerta.tipo, alerta.severidad,
      alerta.usuario_uuid ?? null, alerta.ip ?? null,
      alerta.dedupe_key, alerta.titulo,
      JSON.stringify(alerta.detalle ?? {}),
      alerta.entidad_tipo ?? null, alerta.entidad_id ?? null,
    ]
  );
  // Solo emitir por socket si es alerta nueva y severidad alta/crítica
  if (row.es_nueva && ['alta', 'critica'].includes(alerta.severidad)) {
    emitirAlertaSeguridad(alerta);
  }
  return row.es_nueva;
};

// Ventana de detección: últimos 15 min (solapada — cubre borde entre ejecuciones)
const VENTANA = `NOW() - INTERVAL '15 minutes'`;

// ── Regla 1: mismo empleado origina y aprueba una factura ─────────────────────
const detectarOriginaYAprueba = async () => {
  const { rows } = await pool.query(`
    SELECT f.id AS factura_id, f.numero_factura, f.monto,
           p.nombre AS proveedor, u.id AS usuario_uuid, u.nombre AS usuario,
           ARRAY_REMOVE(ARRAY[
             CASE WHEN f.registrado_por        = u.id THEN 'registro'     END,
             CASE WHEN f.aprobado_por          = u.id THEN 'aprobacion'   END,
             CASE WHEN f.verificada_por        = u.id THEN 'verificacion' END,
             CASE WHEN f.autorizada_por        = u.id THEN 'autorizacion' END,
             CASE WHEN f.pagada_por            = u.id THEN 'pago'         END,
             CASE WHEN f.aprobado_gerencia_por = u.id THEN 'gerencia'     END
           ], NULL) AS etapas
      FROM tesoreria_facturas f
      JOIN tesoreria_proveedores p ON p.id = f.proveedor_id
      JOIN global_usuarios u
        ON u.id IN (f.registrado_por, f.aprobado_por, f.verificada_por,
                    f.autorizada_por, f.pagada_por, f.aprobado_gerencia_por)
     WHERE f.updated_at > ${VENTANA}
       AND (
         SELECT COUNT(*) FROM (VALUES
           (f.registrado_por),(f.aprobado_por),(f.verificada_por),
           (f.autorizada_por),(f.pagada_por),(f.aprobado_gerencia_por)
         ) AS t(uid) WHERE t.uid = u.id
       ) >= 2
  `);

  for (const r of rows) {
    const incluyePago = r.etapas.includes('pago') || r.etapas.includes('autorizacion');
    const incluyeOrigen = r.etapas.includes('registro');
    const severidad = (incluyeOrigen && incluyePago) ? 'critica' : 'alta';
    await upsertAlerta({
      regla: 'origina_y_aprueba', tipo: 'Segregación de funciones',
      severidad, usuario_uuid: r.usuario_uuid,
      dedupe_key: `origina_aprueba:${r.factura_id}:${r.usuario_uuid}`,
      titulo: `${r.usuario} participó en múltiples etapas de la factura ${r.numero_factura || r.factura_id.slice(0,8)}`,
      detalle: { factura_id: r.factura_id, numero_factura: r.numero_factura, monto: r.monto, proveedor: r.proveedor, etapas: r.etapas },
      entidad_tipo: 'factura', entidad_id: r.factura_id,
    });
  }
};

// ── Regla 2: cambio de datos bancarios + pago en <72h ────────────────────────
const detectarBancoDespuesDesembolso = async () => {
  const { rows } = await pool.query(`
    SELECT db.id AS cambio_id, db.proveedor_id, p.nombre AS proveedor,
           db.verificado_at, db.solicitado_por, db.verificado_por,
           RIGHT(db.numero_cuenta::text, 4) AS cuenta_final,
           f.id AS factura_id, f.monto, f.fecha_pago,
           EXTRACT(EPOCH FROM (f.fecha_pago::timestamptz - db.verificado_at))/3600 AS horas,
           (db.solicitado_por = db.verificado_por) AS mismo_verificador
      FROM tesoreria_proveedores_datos_bancarios db
      JOIN tesoreria_proveedores p ON p.id = db.proveedor_id
      JOIN tesoreria_facturas f    ON f.proveedor_id = db.proveedor_id
     WHERE db.estado = 'verificado'
       AND f.estado  = 'pagada'
       AND f.fecha_pago IS NOT NULL
       AND f.fecha_pago::timestamptz >= db.verificado_at
       AND f.fecha_pago::timestamptz <  db.verificado_at + INTERVAL '72 hours'
       AND db.verificado_at > NOW() - INTERVAL '7 days'
  `);

  for (const r of rows) {
    const severidad = r.mismo_verificador ? 'critica' : 'alta';
    await upsertAlerta({
      regla: 'banco_desembolso_72h', tipo: 'Cambio de cuenta bancaria + pago',
      severidad, usuario_uuid: r.verificado_por,
      dedupe_key: `banco_72h:${r.cambio_id}:${r.factura_id}`,
      titulo: `Cambio de cuenta bancaria de ${r.proveedor} seguido de pago en ${Math.round(r.horas)}h`,
      detalle: {
        proveedor: r.proveedor, cuenta_final: r.cuenta_final,
        monto: r.monto, horas: Math.round(r.horas),
        mismo_verificador: r.mismo_verificador,
      },
      entidad_tipo: 'factura', entidad_id: r.factura_id,
    });
  }
};

// ── Regla 3: exportación masiva de datos ─────────────────────────────────────
const detectarExportacionMasiva = async () => {
  const { rows } = await pool.query(`
    SELECT usuario_id, COUNT(*) AS n,
           ARRAY_AGG(DISTINCT endpoint) AS endpoints
      FROM global_actividad
     WHERE created_at > ${VENTANA}
       AND status_code BETWEEN 200 AND 299
       AND (endpoint ~* '/(export|exportar|reporte|certificado|descargar)')
     GROUP BY usuario_id
    HAVING COUNT(*) >= 10
  `);

  for (const r of rows) {
    const severidad = r.n >= 25 ? 'alta' : 'media';
    const { rows: [u] } = await pool.query(`SELECT nombre FROM global_usuarios WHERE id = $1`, [r.usuario_id]);
    const ventana = new Date().toISOString().slice(0, 13); // bucket por hora
    await upsertAlerta({
      regla: 'exportacion_masiva', tipo: 'Exportación masiva de datos',
      severidad, usuario_uuid: r.usuario_id,
      dedupe_key: `exportacion:${r.usuario_id}:${ventana}`,
      titulo: `${u?.nombre ?? r.usuario_id} realizó ${r.n} exportaciones en los últimos 15 minutos`,
      detalle: { exportaciones: r.n, endpoints: r.endpoints },
      entidad_tipo: 'usuario', entidad_id: r.usuario_id,
    });
  }
};

// ── Regla 5: password spraying (requiere auth_intentos) ──────────────────────
const detectarPasswordSpraying = async () => {
  // Spraying: una IP contra muchas cuentas distintas
  const { rows: spray } = await pool.query(`
    SELECT ip, COUNT(DISTINCT email) AS cuentas, COUNT(*) AS intentos,
           COUNT(*) FILTER (WHERE motivo = 'no_existe') AS emails_inexistentes
      FROM auth_intentos
     WHERE exitoso = false AND created_at > ${VENTANA}
     GROUP BY ip
    HAVING COUNT(DISTINCT email) >= 5
  `);

  for (const r of spray) {
    const ventana = new Date().toISOString().slice(0, 13);
    await upsertAlerta({
      regla: 'password_spraying', tipo: 'Password spraying',
      severidad: 'alta', ip: r.ip,
      dedupe_key: `spray:${r.ip}:${ventana}`,
      titulo: `IP ${r.ip} intentó acceso contra ${r.cuentas} cuentas distintas`,
      detalle: { cuentas: Number(r.cuentas), intentos: Number(r.intentos), emails_inexistentes: Number(r.emails_inexistentes) },
    });
  }

  // Éxito después de racha de fallos desde misma IP — compromiso probable
  const { rows: burst } = await pool.query(`
    SELECT a.ip, a.usuario_id, a.email,
           COUNT(*) FILTER (WHERE NOT exitoso) AS fallos_previos
      FROM auth_intentos a
     WHERE a.created_at > NOW() - INTERVAL '30 minutes'
       AND a.exitoso = true
       AND EXISTS (
         SELECT 1 FROM auth_intentos b
          WHERE b.ip = a.ip AND b.exitoso = false
            AND b.created_at < a.created_at
            AND b.created_at > NOW() - INTERVAL '30 minutes'
       )
     GROUP BY a.ip, a.usuario_id, a.email
    HAVING COUNT(*) FILTER (WHERE NOT exitoso) >= 5
  `);

  for (const r of burst) {
    const ventana = new Date().toISOString().slice(0, 16);
    await upsertAlerta({
      regla: 'exito_tras_fallos', tipo: 'Login exitoso tras múltiples fallos',
      severidad: 'critica', usuario_uuid: r.usuario_id, ip: r.ip,
      dedupe_key: `exito_fallos:${r.ip}:${r.email}:${ventana}`,
      titulo: `Login exitoso de ${r.email} desde IP con ${r.fallos_previos} fallos previos`,
      detalle: { email: r.email, ip: r.ip, fallos_previos: Number(r.fallos_previos) },
      entidad_tipo: 'usuario', entidad_id: r.usuario_id,
    });
  }
};

// ── Snapshot de métricas para el panel ───────────────────────────────────────
const actualizarSnapshot = async () => {
  const t0 = Date.now();

  const [topUsuarios, topEndpoints, sesionesActivas, alertasNuevas] = await Promise.all([
    pool.query(`
      SELECT u.nombre, u.id, COUNT(*) AS requests
        FROM global_actividad a
        JOIN global_usuarios u ON u.id = a.usuario_id
       WHERE a.created_at > NOW() - INTERVAL '1 hour'
       GROUP BY u.id, u.nombre ORDER BY requests DESC LIMIT 10
    `),
    pool.query(`
      SELECT endpoint, COUNT(*) AS hits
        FROM global_actividad
       WHERE created_at > NOW() - INTERVAL '1 hour'
       GROUP BY endpoint ORDER BY hits DESC LIMIT 5
    `),
    pool.query(`SELECT COUNT(*) AS n FROM global_usuarios WHERE last_active_at > NOW() - INTERVAL '15 minutes' AND is_active = true`),
    pool.query(`SELECT COUNT(*) AS n FROM security_alerts WHERE estado = 'nueva'`),
  ]);

  const datos = {
    top_usuarios:    topUsuarios.rows,
    top_endpoints:   topEndpoints.rows,
    sesiones_activas: Number(sesionesActivas.rows[0].n),
    alertas_nuevas:   Number(alertasNuevas.rows[0].n),
    updated_at:      new Date().toISOString(),
  };

  await pool.query(
    `INSERT INTO security_metrics_snapshot (clave, datos, calculado_at, duracion_ms)
     VALUES ('resumen_1h', $1, NOW(), $2)
     ON CONFLICT (clave) DO UPDATE SET datos=$1, calculado_at=NOW(), duracion_ms=$2`,
    [JSON.stringify(datos), Date.now() - t0]
  );
};

// ── Job principal ─────────────────────────────────────────────────────────────
export const runAnomalyDetector = async () => {
  try {
    await Promise.all([
      detectarOriginaYAprueba(),
      detectarBancoDespuesDesembolso(),
      detectarExportacionMasiva(),
      detectarPasswordSpraying(),
    ]);
  } catch (err) {
    logger.error(`anomalyDetector error: ${err.message}`);
  }

  // Snapshot desfasado 30s para no coincidir con el pico de detección
  setTimeout(async () => {
    try { await actualizarSnapshot(); }
    catch (err) { logger.error(`snapshot error: ${err.message}`); }
  }, 30_000);
};
