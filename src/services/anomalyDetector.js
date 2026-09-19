import pool from '../db/database.js';
import logger from '../config/logger.js';
import { emitirAlertaSeguridad } from './notificationService.js';
import { cuarentenaDirigida } from './lockdownService.js';

const upsertAlerta = async (alerta) => {
  const { rows: [row] } = await pool.query(
    `INSERT INTO security_alerts
       (regla, tipo, severidad, usuario_uuid, ip, dedupe_key, titulo, detalle, entidad_tipo, entidad_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (dedupe_key) DO UPDATE
       SET ocurrencias   = security_alerts.ocurrencias + 1,
           ultima_vez_at = NOW(),
           detalle       = EXCLUDED.detalle
     RETURNING id, (xmax = 0) AS es_nueva`,
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
  return { es_nueva: row.es_nueva, id: row.id };
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
    HAVING COUNT(DISTINCT email) >= 8
        OR (COUNT(DISTINCT email) >= 5 AND COUNT(*) FILTER (WHERE motivo = 'no_existe') >= 3)
  `);

  for (const r of spray) {
    // solo emitir alta si hay emails inexistentes (atacante con lista) — evita falsos positivos de NAT corporativo
    const severidad = Number(r.emails_inexistentes) >= 3 ? 'alta' : 'media';
    const ventana = new Date().toISOString().slice(0, 13);
    await upsertAlerta({
      regla: 'password_spraying', tipo: 'Password spraying',
      severidad, ip: r.ip,
      dedupe_key: `spray:${r.ip}:${ventana}`,
      titulo: `IP ${r.ip} intentó acceso contra ${r.cuentas} cuentas distintas`,
      detalle: { cuentas: Number(r.cuentas), intentos: Number(r.intentos), emails_inexistentes: Number(r.emails_inexistentes) },
    });
  }

  // Éxito después de racha de fallos desde misma IP — compromiso probable
  // FIX: la query anterior tenía WHERE exitoso=true pero HAVING COUNT(*) FILTER (WHERE NOT exitoso)
  // que es siempre 0 → nunca disparaba. Ahora se usa CTE + JOIN contra la tabla de fallos.
  const { rows: burst } = await pool.query(`
    WITH exitos AS (
      SELECT id, ip, usuario_id, email, created_at
        FROM auth_intentos
       WHERE exitoso = true
         AND created_at > NOW() - INTERVAL '30 minutes'
    )
    SELECT e.ip, e.usuario_id, e.email, e.created_at,
           COUNT(*)                                         AS fallos_previos,
           COUNT(DISTINCT f.email)                         AS cuentas_atacadas,
           COUNT(*) FILTER (WHERE f.email <> e.email)      AS fallos_otras_cuentas,
           COUNT(*) FILTER (WHERE f.motivo = 'no_existe')  AS emails_inexistentes
      FROM exitos e
      JOIN auth_intentos f
        ON f.ip = e.ip
       AND f.exitoso = false
       AND f.created_at < e.created_at
       AND f.created_at >= e.created_at - INTERVAL '30 minutes'
     GROUP BY e.id, e.ip, e.usuario_id, e.email, e.created_at
    HAVING COUNT(DISTINCT f.email) >= 3
       AND COUNT(*) FILTER (WHERE f.email <> e.email) >= 4
  `);

  for (const r of burst) {
    // critica si hay emails inexistentes (atacante trabajando desde lista), alta si no
    const severidad = Number(r.emails_inexistentes) >= 2 ? 'critica' : 'alta';
    const ventana = new Date().toISOString().slice(0, 16);
    const { es_nueva, id: alerta_id } = await upsertAlerta({
      regla: 'exito_tras_fallos', tipo: 'Login exitoso tras múltiples fallos',
      severidad, usuario_uuid: r.usuario_id, ip: r.ip,
      dedupe_key: `exito_fallos:${r.ip}:${r.email}:${ventana}`,
      titulo: `Login exitoso de ${r.email} desde IP con ${r.fallos_previos} fallos previos (${r.cuentas_atacadas} cuentas tanteadas)`,
      detalle: {
        email: r.email, ip: r.ip,
        fallos_previos: Number(r.fallos_previos),
        cuentas_atacadas: Number(r.cuentas_atacadas),
        fallos_otras_cuentas: Number(r.fallos_otras_cuentas),
        emails_inexistentes: Number(r.emails_inexistentes),
      },
      entidad_tipo: 'usuario', entidad_id: r.usuario_id,
    });

    // L3: cuarentena dirigida — solo en alerta nueva para no re-activar en cada ciclo
    // critica → 60 min (atacante con lista confirmada), alta → 30 min
    if (es_nueva) {
      const duracion_min = severidad === 'critica' ? 60 : 30;
      await cuarentenaDirigida({
        usuario_uuid: r.usuario_id ?? null,
        ip: r.ip ?? null,
        motivo: `exito_tras_fallos: ${r.email} — ${r.cuentas_atacadas} cuentas tanteadas desde esta IP`,
        alerta_ids: alerta_id ? [alerta_id] : [],
        duracion_min,
      }).catch((err) => logger.error('cuarentenaDirigida error', err));
    }
  }
};

// ── Regla 6: spray lento — misma IP, muchas cuentas distintas en 24h ─────────
// Complementa detectarPasswordSpraying (ventana 15 min).
// Un atacante paciente puede espaciar intentos para evadir la ventana corta.
const detectarSprayLento = async () => {
  const { rows } = await pool.query(`
    SELECT ip,
           COUNT(DISTINCT email)                        AS cuentas,
           COUNT(*)                                     AS intentos,
           COUNT(*) FILTER (WHERE motivo = 'no_existe') AS emails_inexistentes
      FROM auth_intentos
     WHERE exitoso = false
       AND created_at > NOW() - INTERVAL '24 hours'
     GROUP BY ip
    HAVING COUNT(DISTINCT email) >= 15
  `);

  for (const r of rows) {
    const severidad = Number(r.emails_inexistentes) >= 5 ? 'alta' : 'media';
    const ventana   = new Date().toISOString().slice(0, 10); // bucket por día
    await upsertAlerta({
      regla: 'spray_lento', tipo: 'Password spraying (ventana 24h)',
      severidad, ip: r.ip,
      dedupe_key: `spray_lento:${r.ip}:${ventana}`,
      titulo: `IP ${r.ip} intentó acceso contra ${r.cuentas} cuentas distintas en 24h`,
      detalle: {
        cuentas: Number(r.cuentas),
        intentos: Number(r.intentos),
        emails_inexistentes: Number(r.emails_inexistentes),
      },
    });
  }
};

// ── Regla 7: portal spray — misma IP contra muchas cuentas de portal en 15 min ─
const detectarSprayPortal = async () => {
  const { rows } = await pool.query(`
    SELECT ip,
           contexto,
           COUNT(DISTINCT identificador)               AS cuentas,
           COUNT(*)                                    AS intentos
      FROM auth_intentos
     WHERE exitoso  = false
       AND contexto IN ('asociado', 'empresa')
       AND created_at > NOW() - INTERVAL '15 minutes'
     GROUP BY ip, contexto
    HAVING COUNT(DISTINCT identificador) >= 5
        OR COUNT(*) >= 15
  `);

  for (const r of rows) {
    const severidad = Number(r.cuentas) >= 8 ? 'alta' : 'media';
    const ventana   = new Date().toISOString().slice(0, 16);
    await upsertAlerta({
      regla: 'reset_masivo_portal', tipo: 'Spray de credenciales en portal',
      severidad, ip: r.ip,
      dedupe_key: `portal_spray:${r.ip}:${r.contexto}:${ventana}`,
      titulo: `IP ${r.ip} intentó ${r.intentos} accesos en portal ${r.contexto} contra ${r.cuentas} cuentas`,
      detalle: {
        contexto: r.contexto,
        cuentas: Number(r.cuentas),
        intentos: Number(r.intentos),
      },
    });
  }
};

// ── Regla 8: actividad financiera fuera de horario laboral ────────────────────
// Mutaciones en módulos financieros fuera de L-V 06:00-21:00 hora Bogotá (UTC-5, sin DST)
const detectarActividadFueraHorario = async () => {
  const { rows } = await pool.query(`
    SELECT a.usuario_id, u.nombre AS usuario, a.endpoint, a.metodo,
           a.created_at,
           EXTRACT(DOW  FROM a.created_at AT TIME ZONE 'America/Bogota') AS dow,
           EXTRACT(HOUR FROM a.created_at AT TIME ZONE 'America/Bogota') AS hora
      FROM global_actividad a
      JOIN global_usuarios u ON u.id = a.usuario_id
     WHERE a.created_at > ${VENTANA}
       AND a.metodo IN ('POST', 'PUT', 'DELETE', 'PATCH')
       AND a.status_code BETWEEN 200 AND 299
       AND a.endpoint ~* '/(facturas|movimientos|conciliar|causar|pagos?|aporte|proveedores|extracto)'
       AND (
         -- Fin de semana
         EXTRACT(DOW FROM a.created_at AT TIME ZONE 'America/Bogota') IN (0, 6)
         OR
         -- Fuera de horario en día hábil
         EXTRACT(HOUR FROM a.created_at AT TIME ZONE 'America/Bogota') < 6
         OR
         EXTRACT(HOUR FROM a.created_at AT TIME ZONE 'America/Bogota') >= 21
       )
  `);

  for (const r of rows) {
    const esFinDeSemana = [0, 6].includes(Number(r.dow));
    const severidad     = esFinDeSemana ? 'alta' : 'media';
    const ventana       = new Date(r.created_at).toISOString().slice(0, 16);
    await upsertAlerta({
      regla: 'actividad_fuera_horario', tipo: 'Actividad financiera fuera de horario',
      severidad, usuario_uuid: r.usuario_id,
      dedupe_key: `fuera_horario:${r.usuario_id}:${r.endpoint}:${ventana}`,
      titulo: `${r.usuario} ejecutó ${r.metodo} ${r.endpoint} a las ${String(Math.floor(Number(r.hora))).padStart(2,'0')}:xx${esFinDeSemana ? ' (fin de semana)' : ''}`,
      detalle: {
        endpoint: r.endpoint,
        method: r.metodo,
        hora: Number(r.hora),
        fin_de_semana: esFinDeSemana,
        created_at: r.created_at,
      },
      entidad_tipo: 'usuario', entidad_id: r.usuario_id,
    });
  }
};

// ── Regla 9: fraccionamiento de pagos ────────────────────────────────────────
// Múltiples facturas al mismo proveedor en 24h, cada una bajo el umbral de gerencia,
// pero la suma supera dicho umbral → sospecha de evasión del flujo de aprobación.
const detectarFraccionamiento = async () => {
  const { rows } = await pool.query(`
    WITH umbral AS (
      SELECT monto_umbral FROM tesoreria_config_umbrales WHERE tipo_operacion = 'egreso_proveedor'
    )
    SELECT f.proveedor_id, p.nombre AS proveedor,
           COUNT(*)        AS num_facturas,
           SUM(f.monto)    AS total,
           MAX(u.monto_umbral) AS umbral_unitario,
           ARRAY_AGG(f.id) AS factura_ids,
           (ARRAY_AGG(f.registrado_por))[1] AS registrado_por
      FROM tesoreria_facturas f
      JOIN tesoreria_proveedores p ON p.id = f.proveedor_id
      CROSS JOIN umbral u
     WHERE f.created_at > NOW() - INTERVAL '24 hours'
       AND f.estado NOT IN ('rechazada')
       AND f.monto < u.monto_umbral
     GROUP BY f.proveedor_id, p.nombre
    HAVING COUNT(*) >= 2
       AND SUM(f.monto) > MAX(u.monto_umbral)
  `);

  for (const r of rows) {
    const ventana = new Date().toISOString().slice(0, 10);
    await upsertAlerta({
      regla: 'fraccionamiento_umbral', tipo: 'Fraccionamiento de pagos',
      severidad: 'alta', usuario_uuid: r.registrado_por ?? null,
      dedupe_key: `fraccionamiento:${r.proveedor_id}:${ventana}`,
      titulo: `${r.num_facturas} facturas a ${r.proveedor} suman ${Number(r.total).toLocaleString('es-CO')} (umbral: ${Number(r.umbral_unitario).toLocaleString('es-CO')})`,
      detalle: {
        proveedor: r.proveedor,
        num_facturas: Number(r.num_facturas),
        total: Number(r.total),
        umbral_unitario: Number(r.umbral_unitario),
        factura_ids: r.factura_ids,
      },
      entidad_tipo: 'proveedor', entidad_id: r.proveedor_id,
    });
  }
};

// ── Snapshot de métricas para el panel ───────────────────────────────────────
const actualizarSnapshot = async () => {
  const t0 = Date.now();

  const [topUsuarios, topEndpoints, sesionesActivas, alertasNuevas, lockdownsActivos] = await Promise.all([
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
    pool.query(`SELECT COUNT(*) AS n FROM security_lockdown WHERE reset_at IS NULL AND (expira_at IS NULL OR expira_at > NOW())`),
  ]);

  const datos = {
    top_usuarios:     topUsuarios.rows,
    top_endpoints:    topEndpoints.rows,
    sesiones_activas:  Number(sesionesActivas.rows[0].n),
    alertas_nuevas:    Number(alertasNuevas.rows[0].n),
    lockdowns_activos: Number(lockdownsActivos.rows[0].n),
    updated_at:       new Date().toISOString(),
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
      detectarSprayLento(),
      detectarSprayPortal(),
      detectarActividadFueraHorario(),
      detectarFraccionamiento(),
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
