import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { parse } from 'csv-parse/sync';
import pool from '../../../db/database.js';
import { env } from '../../../config/env.js';
import { loginAsociadoSchema, importarFilaSchema, solicitarPortalSchema } from '../schemas/asociadosSchema.js';
import { notificarUsuario, notificarAdmins } from '../../../services/notificationService.js';

const cookieOpts = () => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge: 8 * 60 * 60 * 1000,
});

// Genera una contraseña legible sin caracteres ambiguos (0/O, 1/l/I)
const generarPassword = () => {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

// ── Portal: auth ──────────────────────────────────────────────────────────────

export const loginAsociado = async (req, res, next) => {
  try {
    const { codigo, password } = loginAsociadoSchema.parse(req.body);

    const { rows } = await pool.query(
      `SELECT codigo, nombre, apellido, password_hash, portal_activo, primer_login
       FROM asociados WHERE codigo = $1 AND is_active = true`,
      [codigo]
    );

    const asociado = rows[0];

    // Mismo mensaje para usuario no encontrado y contraseña incorrecta — no revelar si existe
    if (!asociado || !asociado.password_hash || !(await bcrypt.compare(password, asociado.password_hash))) {
      return res.status(401).json({ error: 'Código o contraseña incorrectos' });
    }

    if (!asociado.portal_activo) {
      return res.status(403).json({ error: 'Tu acceso al portal no está activado. Contacta a la cooperativa.' });
    }

    const token = jwt.sign(
      { id: asociado.codigo, nombre: asociado.nombre, tipo: 'asociado', primer_login: asociado.primer_login },
      env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.cookie('token_asociado', token, {
      ...cookieOpts(),
    });

    res.json({
      codigo:       asociado.codigo,
      nombre:       asociado.nombre,
      apellido:     asociado.apellido,
      primer_login: asociado.primer_login,
    });
  } catch (err) {
    next(err);
  }
};

export const logoutAsociado = (_req, res) => {
  res.clearCookie('token_asociado', cookieOpts());
  res.json({ message: 'Sesión cerrada' });
};

export const meAsociado = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT codigo, nombre, apellido, direccion, movil,
              clase_cuota, empresa_dsto, nombre_empresa, ciudad, primer_login,
              fecha_nacimiento, fecha_ingreso, fecha_reingreso,
              valor_aporte, saldo_aporte, fecha_credito, fecha_pri_descuento
       FROM asociados WHERE codigo = $1`,
      [req.asociado.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Asociado no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

export const cambiarPasswordAsociado = async (req, res, next) => {
  try {
    const { password_actual, password_nueva } = req.body;
    if (!password_actual || !password_nueva || password_nueva.length < 8) {
      return res.status(400).json({ error: 'Datos inválidos' });
    }

    const { rows } = await pool.query(
      'SELECT password_hash FROM asociados WHERE codigo = $1',
      [req.asociado.id]
    );
    const valida = await bcrypt.compare(password_actual, rows[0].password_hash);
    if (!valida) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

    const hash = await bcrypt.hash(password_nueva, 10);
    await pool.query(
      'UPDATE asociados SET password_hash = $1, primer_login = false, updated_at = NOW() WHERE codigo = $2',
      [hash, req.asociado.id]
    );
    res.json({ message: 'Contraseña actualizada' });
  } catch (err) {
    next(err);
  }
};

// ── Portal: solicitud de acceso ───────────────────────────────────────────────

export const solicitarPortal = async (req, res, next) => {
  try {
    const { codigo } = solicitarPortalSchema.parse(req.body);

    const { rows } = await pool.query(
      `SELECT codigo, nombre, apellido, portal_activo, solicitud_portal_at
       FROM asociados WHERE codigo = $1 AND is_active = true`,
      [codigo]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'No encontramos un asociado con esa cédula. Contacta a la cooperativa.' });
    }

    const asociado = rows[0];

    if (asociado.portal_activo) {
      return res.status(409).json({ error: 'Este asociado ya tiene acceso al portal.' });
    }

    if (asociado.solicitud_portal_at) {
      return res.status(409).json({ error: 'Ya existe una solicitud pendiente para este asociado. La cooperativa te contactará pronto.' });
    }

    await pool.query(
      `UPDATE asociados SET solicitud_portal_at = NOW(), updated_at = NOW() WHERE codigo = $1`,
      [codigo]
    );

    notificarAdmins({
      tipo: 'solicitud_portal',
      mensaje: `${asociado.nombre} ${asociado.apellido} (${codigo}) solicitó acceso al portal`,
      modulo: 'asociados',
    }).catch(() => {});

    res.json({ ok: true, mensaje: 'Solicitud enviada. La cooperativa te contactará pronto con tus credenciales de acceso.' });
  } catch (err) {
    next(err);
  }
};

// ── Admin: activación del portal ──────────────────────────────────────────────

export const activarPortal = async (req, res, next) => {
  try {
    const { codigo } = req.params;

    const { rows } = await pool.query(
      'SELECT codigo, nombre, apellido FROM asociados WHERE codigo = $1',
      [codigo]
    );
    if (!rows.length) return res.status(404).json({ error: 'Asociado no encontrado' });

    const password = generarPassword();
    const hash     = await bcrypt.hash(password, 10);

    await pool.query(
      `UPDATE asociados
       SET password_hash = $1, portal_activo = true, primer_login = true,
           solicitud_portal_at = NULL, updated_at = NOW()
       WHERE codigo = $2`,
      [hash, codigo]
    );

    res.json({
      password,
      nombre:  rows[0].nombre,
      apellido: rows[0].apellido,
      mensaje: 'Portal activado. Entrega esta contraseña al asociado. No se volverá a mostrar.',
    });
  } catch (err) {
    next(err);
  }
};

export const desactivarPortal = async (req, res, next) => {
  try {
    const { codigo } = req.params;
    await pool.query(
      `UPDATE asociados
       SET password_hash = NULL, portal_activo = false, primer_login = false, updated_at = NOW()
       WHERE codigo = $1`,
      [codigo]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

export const rechazarSolicitudPortal = async (req, res, next) => {
  try {
    const { codigo } = req.params;
    await pool.query(
      `UPDATE asociados SET solicitud_portal_at = NULL, updated_at = NOW() WHERE codigo = $1`,
      [codigo]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

// ── Admin: importar CSV ───────────────────────────────────────────────────────

export const importarCSV = async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!req.file) return res.status(400).json({ error: 'No se adjuntó ningún archivo' });

    const registros = parse(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    // Si el CSV trae columna "linea", solo procesar las de linea=1
    const registrosFiltrados = registros.filter((r) => !r.linea || String(r.linea).trim() === '1');

    const errores = [];
    const validos = [];

    for (const fila of registrosFiltrados) {
      const result = importarFilaSchema.safeParse(fila);
      if (!result.success) {
        errores.push({ fila: fila.codigo ?? '?', error: result.error.flatten() });
      } else {
        validos.push(result.data);
      }
    }

    const INSERT_BATCH = 200;
    const codigosCSV   = validos.map((d) => d.codigo);

    await client.query('BEGIN');

    const detalleNuevos = [];
    let nuevos      = 0;
    let actualizados = 0;

    for (let i = 0; i < validos.length; i += INSERT_BATCH) {
      const lote   = validos.slice(i, i + INSERT_BATCH);
      const params = [];
      // 16 campos por fila — password_hash, portal_activo y primer_login no se pasan como param
      const values = lote.map((d, j) => {
        const base = j * 16;
        params.push(
          d.codigo, d.apellido, d.nombre, d.direccion, d.movil,
          d.clase_cuota, d.empresa_dsto, d.nombre_empresa, d.ciudad,
          d.cuota ?? null,           // → valor_aporte
          d.saldo ?? null,           // → saldo_aporte
          d.fecha_credito ?? null,
          d.fecha_pri_decuento ?? null,
          d.fecha_ingreso ?? null,
          d.fecha_reingreso ?? null,
          d.fecha_nacimiento ?? null,
        );
        return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12},$${base+13},$${base+14},$${base+15},$${base+16},NULL,false,false)`;
      }).join(',');

      const { rows } = await client.query(
        `INSERT INTO asociados
           (codigo, apellido, nombre, direccion, movil, clase_cuota, empresa_dsto, nombre_empresa, ciudad,
            valor_aporte, saldo_aporte, fecha_credito, fecha_pri_descuento, fecha_ingreso, fecha_reingreso,
            fecha_nacimiento, password_hash, portal_activo, primer_login)
         VALUES ${values}
         ON CONFLICT (codigo) DO UPDATE SET
           apellido            = EXCLUDED.apellido,
           nombre              = EXCLUDED.nombre,
           direccion           = EXCLUDED.direccion,
           movil               = EXCLUDED.movil,
           clase_cuota         = EXCLUDED.clase_cuota,
           empresa_dsto        = EXCLUDED.empresa_dsto,
           nombre_empresa      = EXCLUDED.nombre_empresa,
           ciudad              = EXCLUDED.ciudad,
           valor_aporte        = COALESCE(EXCLUDED.valor_aporte, asociados.valor_aporte),
           saldo_aporte        = COALESCE(EXCLUDED.saldo_aporte, asociados.saldo_aporte),
           fecha_credito       = COALESCE(EXCLUDED.fecha_credito, asociados.fecha_credito),
           fecha_pri_descuento = COALESCE(EXCLUDED.fecha_pri_descuento, asociados.fecha_pri_descuento),
           fecha_ingreso       = COALESCE(EXCLUDED.fecha_ingreso, asociados.fecha_ingreso),
           fecha_reingreso     = COALESCE(EXCLUDED.fecha_reingreso, asociados.fecha_reingreso),
           fecha_nacimiento    = COALESCE(EXCLUDED.fecha_nacimiento, asociados.fecha_nacimiento),
           is_active           = true,
           fecha_retiro        = NULL,
           updated_at          = now()
         RETURNING codigo, nombre, apellido, nombre_empresa, (xmax = 0) AS es_nuevo`,
        params
      );

      rows.forEach((r) => {
        if (r.es_nuevo) { nuevos++; detalleNuevos.push({ codigo: r.codigo, nombre: r.nombre, apellido: r.apellido, empresa: r.nombre_empresa }); }
        else            { actualizados++; }
      });
    }

    // Retirar asociados que ya no están en el CSV
    const { rows: retiradosRows } = await client.query(
      `UPDATE asociados SET is_active = false, fecha_retiro = now(), updated_at = now()
       WHERE codigo != ALL($1) AND is_active = true
       RETURNING codigo, nombre, apellido, nombre_empresa`,
      [codigosCSV]
    );
    const retirados = retiradosRows.length;
    const detalleRetirados = retiradosRows.map((r) => ({
      codigo: r.codigo, nombre: r.nombre, apellido: r.apellido, empresa: r.nombre_empresa,
    }));

    // Liberar boletos de cualquier asociado inactivo (cubre recién retirados y syncs anteriores)
    // Cancelar solicitudes pendientes
    await client.query(
      `UPDATE solicitudes_bono sb SET estado = 'cancelada', updated_at = NOW()
       FROM asociados a
       WHERE sb.asociado_codigo = a.codigo AND a.is_active = false AND sb.estado = 'pendiente'`
    );

    // Liberar boletos asignados a inactivos
    const { rows: boletosALiberar } = await client.query(
      `UPDATE boletos b
          SET asociado_codigo = NULL, estado = 'libre', fecha_asignacion = NULL
         FROM asociados a
        WHERE b.asociado_codigo = a.codigo
          AND a.is_active = false
          AND b.estado IN ('asignado', 'pendiente_retiro')
        RETURNING b.numero, b.sorteo_id, a.codigo AS codigo_anterior`
    );

    const boletosLiberados = boletosALiberar.length;

    // Registrar en sorteo_logs — un solo INSERT con unnest en lugar de N queries
    if (boletosALiberar.length > 0) {
      await client.query(
        `INSERT INTO sorteo_logs (sorteo_id, numero, accion, asociado_codigo, empleado_uuid, detalle)
         SELECT unnest($1::uuid[]), unnest($2::int[]), 'LIBERACION_POR_RETIRO_CSV',
                unnest($3::text[]), $4, 'Asociado retirado en sincronización de padrón'`,
        [
          boletosALiberar.map((b) => b.sorteo_id),
          boletosALiberar.map((b) => b.numero),
          boletosALiberar.map((b) => b.codigo_anterior),
          req.user.id,
        ]
      );
    }

    // Sincronizar empresas
    const empresasMap = new Map();
    for (const d of validos) {
      if (d.empresa_dsto) empresasMap.set(d.empresa_dsto, d.nombre_empresa || d.empresa_dsto);
    }
    const empresas       = [...empresasMap.entries()];
    const codigosEmpresa = empresas.map(([c]) => c);

    if (empresas.length > 0) {
      const EMP_BATCH = 200;
      for (let i = 0; i < empresas.length; i += EMP_BATCH) {
        const lote   = empresas.slice(i, i + EMP_BATCH);
        const params = [];
        const values = lote.map(([codigo, nombre], j) => {
          params.push(codigo, nombre);
          return `($${j*2+1}, $${j*2+2}, now())`;
        }).join(',');

        await client.query(
          `INSERT INTO empresas (codigo, nombre, fecha_ingreso)
           VALUES ${values}
           ON CONFLICT (codigo) DO UPDATE SET
             nombre        = EXCLUDED.nombre,
             is_active     = true,
             fecha_retiro  = NULL,
             fecha_ingreso = CASE WHEN empresas.is_active = false THEN now() ELSE empresas.fecha_ingreso END,
             updated_at    = now()`,
          params
        );
      }

      await client.query(
        `UPDATE empresas SET is_active = false, fecha_retiro = now(), updated_at = now()
         WHERE codigo != ALL($1) AND is_active = true`,
        [codigosEmpresa]
      );
    }

    // ── Reconciliación línea 15 (cobros externos vs Kernel) ──────────────────────
    let discrepancias = null;

    const filas15 = registros.filter((r) => String(r.linea ?? '').trim() === '15');

    if (filas15.length > 0) {
      const parseCuotaCOP = (str) => {
        const cleaned = String(str ?? '0').trim().replace(/\./g, '').replace(',', '.');
        return parseFloat(cleaned) || 0;
      };

      // Un registro por código — tomar el primero
      const mapa15 = new Map();
      for (const r of filas15) {
        if (!mapa15.has(r.codigo)) {
          mapa15.set(r.codigo, {
            cuota_externa: parseCuotaCOP(r.cuota),
            clase_cuota:   String(r.clase_cuota ?? '2').trim(),
            nombre:        `${(r.nombre ?? '').trim()} ${(r.apellido ?? '').trim()}`.trim(),
            empresa:       (r.nombre_empresa ?? r.empresa_dsto ?? '').trim(),
          });
        }
      }

      // Total mensual en Kernel por asociado — dentro de la transacción, ve boletos ya liberados
      const { rows: boletosKernel } = await client.query(`
        SELECT b.asociado_codigo, SUM(s.precio_boleto)::numeric AS total_mensual
        FROM boletos b
        JOIN sorteos s ON s.id = b.sorteo_id
        WHERE b.estado = 'asignado' AND s.estado = 'activo' AND s.precio_boleto > 0
        GROUP BY b.asociado_codigo
      `);
      const boletosMap        = new Map(boletosKernel.map((r) => [r.asociado_codigo, parseFloat(r.total_mensual)]));
      const codigosActivosSet = new Set(codigosCSV);
      const validosMap        = new Map(validos.map((v) => [v.codigo, v]));

      discrepancias = [];

      // Revisar cada entrada de línea 15
      for (const [codigo, d] of mapa15) {
        const activo       = codigosActivosSet.has(codigo);
        const totalMensual = boletosMap.get(codigo) ?? 0;
        // clase_cuota de línea 1 (Kernel) es la fuente de verdad; línea 15 puede diferir
        const claseKernel  = validosMap.get(codigo)?.clase_cuota ?? d.clase_cuota;
        const factor       = claseKernel === '1' ? 2 : 1;
        const cuotaKernel  = Math.round((totalMensual / factor) * 100) / 100;
        const cuotaExterna = Math.round(d.cuota_externa * 100) / 100;

        if (!activo) {
          discrepancias.push({ tipo: 'COBRO_A_RETIRADO', codigo, nombre: d.nombre, empresa: d.empresa, cuota_externa: cuotaExterna, cuota_kernel: 0 });
        } else if (totalMensual === 0) {
          discrepancias.push({ tipo: 'COBRO_SIN_BOLETO', codigo, nombre: d.nombre, empresa: d.empresa, cuota_externa: cuotaExterna, cuota_kernel: 0 });
        } else if (Math.abs(cuotaExterna - cuotaKernel) > 1) {
          discrepancias.push({ tipo: 'MONTO_INCORRECTO', codigo, nombre: d.nombre, empresa: d.empresa, cuota_externa: cuotaExterna, cuota_kernel: cuotaKernel, diferencia: Math.round((cuotaExterna - cuotaKernel) * 100) / 100 });
        }
      }

      // Activos con boletos en Kernel pero sin línea 15 en el CSV
      for (const [codigo, totalMensual] of boletosMap) {
        if (!mapa15.has(codigo) && codigosActivosSet.has(codigo)) {
          const asocData = validosMap.get(codigo);
          if (asocData) {
            const factor      = asocData.clase_cuota === '1' ? 2 : 1;
            const cuotaKernel = Math.round((totalMensual / factor) * 100) / 100;
            discrepancias.push({ tipo: 'SIN_COBRO_EXTERNO', codigo, nombre: `${asocData.nombre} ${asocData.apellido}`, empresa: asocData.nombre_empresa, cuota_externa: 0, cuota_kernel: cuotaKernel });
          }
        }
      }
    }

    // Auditoría
    const detalle = {
      nuevos:    detalleNuevos,
      retirados: detalleRetirados,
      boletos_liberados: boletosALiberar.map((b) => ({
        numero: b.numero, sorteo_id: b.sorteo_id, codigo: b.codigo_anterior,
      })),
      errores,
      discrepancias,
    };

    await client.query(
      `INSERT INTO sincronizaciones
         (usuario_uuid, archivo, total, nuevos, actualizados, retirados, errores, boletos_liberados, detalle)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [req.user.id, req.file.originalname, registrosFiltrados.length, nuevos, actualizados, retirados,
       errores.length, boletosLiberados, JSON.stringify(detalle)]
    );

    await client.query('COMMIT');

    notificarUsuario(req.user.id, {
      tipo: 'sincronizacion_completada',
      mensaje: `Importación completada: ${nuevos} nuevos, ${actualizados} actualizados, ${retirados} retirados, ${boletosLiberados} boletos liberados`,
      modulo: 'asociados',
    }).catch(() => {});

    res.json({ nuevos, actualizados, retirados, boletos_liberados: boletosLiberados, errores, total: registrosFiltrados.length, discrepancias });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

export const listarPendientesPortal = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT codigo, nombre, apellido, movil, nombre_empresa, solicitud_portal_at
       FROM asociados
       WHERE solicitud_portal_at IS NOT NULL AND portal_activo = false
       ORDER BY solicitud_portal_at ASC`
    );
    res.json(rows);
  } catch (err) { next(err); }
};

export const historialSincronizaciones = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.archivo, s.total, s.nuevos, s.actualizados, s.retirados, s.errores,
              s.boletos_liberados, s.created_at,
              u.nombre AS usuario, u.email AS usuario_email,
              CASE WHEN jsonb_typeof(s.detalle->'discrepancias') = 'array'
                   THEN jsonb_array_length(s.detalle->'discrepancias')
                   ELSE NULL
              END AS discrepancias_count
       FROM sincronizaciones s
       JOIN global_usuarios u ON u.id = s.usuario_uuid
       ORDER BY s.created_at DESC
       LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

export const detalleSincronizacion = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: [row] } = await pool.query(
      `SELECT detalle FROM sincronizaciones WHERE id = $1`,
      [id]
    );
    if (!row) return res.status(404).json({ error: 'Sincronización no encontrada' });
    res.json(row.detalle ?? {});
  } catch (err) {
    next(err);
  }
};

export const listarAsociados = async (req, res, next) => {
  try {
    const { q } = req.query;
    let rows;
    if (q && q.trim()) {
      const term = `%${q.trim().toLowerCase()}%`;
      ({ rows } = await pool.query(
        `SELECT codigo, nombre, apellido, movil, clase_cuota, nombre_empresa, ciudad, is_active, portal_activo, primer_login, solicitud_portal_at
         FROM asociados
         WHERE LOWER(codigo) LIKE $1 OR LOWER(nombre) LIKE $1 OR LOWER(apellido) LIKE $1
            OR LOWER(nombre || ' ' || apellido) LIKE $1
         ORDER BY apellido, nombre
         LIMIT 20`,
        [term]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT codigo, nombre, apellido, movil, clase_cuota, nombre_empresa, ciudad, is_active, portal_activo, primer_login, solicitud_portal_at
         FROM asociados ORDER BY apellido, nombre`
      ));
    }
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

export const perfilAsociado = async (req, res, next) => {
  try {
    const { codigo } = req.params;

    // Datos base
    const { rows: [asociado] } = await pool.query(
      `SELECT codigo, nombre, apellido, direccion, movil, clase_cuota,
              empresa_dsto, nombre_empresa, ciudad, is_active,
              portal_activo, solicitud_portal_at, valor_aporte, valor_aporte_desde, created_at,
              saldo_aporte, fecha_credito, fecha_pri_descuento,
              fecha_ingreso, fecha_reingreso, fecha_nacimiento, fecha_retiro
       FROM asociados WHERE codigo = $1`,
      [codigo]
    );
    if (!asociado) return res.status(404).json({ error: 'Asociado no encontrado' });

    // Bonos activos por sorteo
    const { rows: bonosActivos } = await pool.query(
      `SELECT s.id AS sorteo_id, s.nombre AS sorteo_nombre, s.estado AS sorteo_estado, s.precio_boleto,
              b.numero, b.estado, b.fecha_asignacion
       FROM boletos b
       JOIN sorteos s ON s.id = b.sorteo_id
       WHERE b.asociado_codigo = $1 AND b.estado IN ('asignado','pendiente_retiro','pendiente_adquisicion')
       ORDER BY s.nombre, b.numero`,
      [codigo]
    );

    // Premios ganados
    const { rows: premios } = await pool.query(
      `SELECT sg.numero, sg.mes_premiacion, sg.fecha_premiacion, s.id AS sorteo_id, s.nombre AS sorteo_nombre
       FROM sorteo_ganadores sg
       JOIN sorteos s ON s.id = sg.sorteo_id
       WHERE sg.asociado_codigo = $1
       ORDER BY sg.mes_premiacion DESC`,
      [codigo]
    );

    // Últimos 20 movimientos en sorteos
    const { rows: historial } = await pool.query(
      `SELECT sl.accion, sl.numero, sl.created_at, s.id AS sorteo_id, s.nombre AS sorteo_nombre
       FROM sorteo_logs sl
       JOIN sorteos s ON s.id = sl.sorteo_id
       WHERE sl.asociado_codigo = $1
       ORDER BY sl.created_at DESC
       LIMIT 20`,
      [codigo]
    );

    // Cuotas patronales: últimas 12 facturas donde aparece este asociado
    const { rows: cuotas } = await pool.query(
      `SELECT pf.id AS factura_id, pf.periodo, pf.estado AS factura_estado, pf.fecha_vencimiento,
              pf.empresa_codigo, e.nombre AS empresa_nombre,
              pd.valor_aporte_snapshot, pd.bonos_monto, pd.clase_cuota_snapshot
       FROM patronales_detalle pd
       JOIN patronales_facturas pf ON pf.id = pd.factura_id
       JOIN empresas e ON e.codigo = pf.empresa_codigo
       WHERE pd.asociado_codigo = $1 AND pf.estado != 'anulada'
       ORDER BY pf.periodo DESC
       LIMIT 12`,
      [codigo]
    );

    const { rows: solicitudesPendientes } = await pool.query(
      `SELECT sb.id, sb.sorteo_id, sb.tipo, sb.created_at,
              s.nombre AS sorteo_nombre
       FROM solicitudes_bono sb
       JOIN sorteos s ON s.id = sb.sorteo_id
       WHERE sb.asociado_codigo = $1 AND sb.estado = 'pendiente'
       ORDER BY sb.created_at DESC`,
      [codigo]
    );

    res.json({ asociado, bonosActivos, premios, historial, cuotas, solicitudesPendientes });
  } catch (err) { next(err); }
};

export const listarNotificaciones = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM notificaciones
       WHERE asociado_codigo = $1
       ORDER BY created_at DESC LIMIT 50`,
      [req.asociado.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

export const marcarNotifLeida = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE notificaciones SET leida = true
       WHERE id = $1 AND asociado_codigo = $2 RETURNING id`,
      [req.params.id, req.asociado.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Notificación no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

export const marcarTodasNotifsLeidas = async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE notificaciones SET leida = true
       WHERE asociado_codigo = $1 AND leida = false`,
      [req.asociado.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

export const historialAporte = async (req, res, next) => {
  try {
    const { codigo } = req.params;
    const { rows } = await pool.query(
      `SELECT campo, valor_anterior, valor_nuevo, changed_at
       FROM asociado_historial_aporte
       WHERE asociado_codigo = $1
       ORDER BY changed_at DESC`,
      [codigo]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};
