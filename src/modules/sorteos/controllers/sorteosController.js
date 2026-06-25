import pool from '../../../db/database.js';
import { notificarPorPermiso, notificarAsociado } from '../../../services/notificationService.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const assertSorteoActivo = async (sorteoId) => {
  const { rows } = await pool.query('SELECT estado FROM sorteos WHERE id = $1', [sorteoId]);
  if (!rows[0]) throw Object.assign(new Error('Sorteo no encontrado'), { status: 404 });
  if (rows[0].estado === 'pausado') throw Object.assign(new Error('El sorteo está pausado'), { status: 409 });
};

const insertLog = (client, { sorteoId, numero, accion, asociadoCodigo, empleadoUuid, detalle }) =>
  client.query(
    `INSERT INTO sorteo_logs (sorteo_id, numero, accion, asociado_codigo, empleado_uuid, detalle)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [sorteoId, numero ?? null, accion, asociadoCodigo ?? null, empleadoUuid ?? null, detalle ?? null]
  );

// ── Sorteos CRUD ────────────────────────────────────────────────────────────

export const listarSorteos = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*,
        (SELECT COUNT(*) FROM boletos b WHERE b.sorteo_id = s.id AND b.estado = 'asignado') AS boletos_asignados,
        (SELECT COUNT(*) FROM solicitudes_bono sb WHERE sb.sorteo_id = s.id AND sb.estado = 'pendiente') AS solicitudes_pendientes,
        COALESCE(
          JSON_AGG(se.empresa_codigo) FILTER (WHERE se.empresa_codigo IS NOT NULL),
          '[]'
        ) AS empresas_habilitadas
      FROM sorteos s
      LEFT JOIN sorteo_empresas se ON se.sorteo_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at DESC
    `);
    res.json(rows);
  } catch (err) { next(err); }
};

export const crearSorteo = async (req, res, next) => {
  try {
    const { nombre, descripcion } = req.body;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [sorteo] } = await client.query(
        `INSERT INTO sorteos (nombre, descripcion) VALUES ($1, $2) RETURNING *`,
        [nombre, descripcion ?? null]
      );

      // Pre-poblar los 1000 boletos
      const values = Array.from({ length: 1000 }, (_, i) => `(${i}, '${sorteo.id}')`).join(',');
      await client.query(`INSERT INTO boletos (numero, sorteo_id) VALUES ${values}`);

      await client.query('COMMIT');
      res.status(201).json(sorteo);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
};

export const toggleEstado = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `UPDATE sorteos
       SET estado = CASE WHEN estado = 'activo' THEN 'pausado' ELSE 'activo' END,
           updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Sorteo no encontrado' });
    res.json(rows[0]);
  } catch (err) { next(err); }
};

// ── Empresas por sorteo ─────────────────────────────────────────────────────

export const toggleEmpresa = async (req, res, next) => {
  try {
    const { id: sorteo_id, codigo } = req.params;

    const { rows: existing } = await pool.query(
      'SELECT 1 FROM sorteo_empresas WHERE sorteo_id = $1 AND empresa_codigo = $2',
      [sorteo_id, codigo]
    );

    if (existing.length > 0) {
      await pool.query(
        'DELETE FROM sorteo_empresas WHERE sorteo_id = $1 AND empresa_codigo = $2',
        [sorteo_id, codigo]
      );
      return res.json({ habilitada: false });
    }

    await pool.query(
      'INSERT INTO sorteo_empresas (sorteo_id, empresa_codigo) VALUES ($1,$2)',
      [sorteo_id, codigo]
    );
    res.json({ habilitada: true });
  } catch (err) { next(err); }
};

// ── Boletos ─────────────────────────────────────────────────────────────────

export const listarBoletos = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`
      SELECT b.numero, b.estado, b.fecha_asignacion,
             a.nombre, a.apellido, a.empresa_dsto AS empresa_codigo, a.nombre_empresa
      FROM boletos b
      LEFT JOIN asociados a ON a.codigo = b.asociado_codigo
      WHERE b.sorteo_id = $1
      ORDER BY b.numero
    `, [id]);
    res.json(rows);
  } catch (err) { next(err); }
};

export const asignarDirecto = async (req, res, next) => {
  try {
    const { id: sorteo_id } = req.params;
    const { numero, asociado_codigo } = req.body;
    await assertSorteoActivo(sorteo_id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [boleto] } = await client.query(
        'SELECT estado FROM boletos WHERE numero = $1 AND sorteo_id = $2 FOR UPDATE',
        [numero, sorteo_id]
      );
      if (!boleto) return res.status(404).json({ error: 'Boleto no encontrado' });
      if (boleto.estado !== 'libre') {
        return res.status(409).json({ error: `El número ${numero} no está disponible (estado: ${boleto.estado})` });
      }

      const { rows: [asoc] } = await client.query(
        'SELECT codigo, nombre, apellido, empresa_dsto FROM asociados WHERE codigo = $1 AND is_active = true',
        [asociado_codigo]
      );
      if (!asoc) return res.status(404).json({ error: 'Asociado no encontrado o inactivo' });

      // Verificar empresa habilitada
      const { rows: emp } = await client.query(
        'SELECT 1 FROM sorteo_empresas WHERE sorteo_id = $1 AND empresa_codigo = $2',
        [sorteo_id, asoc.empresa_dsto]
      );
      if (!emp.length) {
        return res.status(409).json({ error: 'La empresa del asociado no está habilitada en este sorteo' });
      }

      await client.query(
        `UPDATE boletos SET asociado_codigo = $1, estado = 'asignado', fecha_asignacion = NOW()
         WHERE numero = $2 AND sorteo_id = $3`,
        [asociado_codigo, numero, sorteo_id]
      );

      await insertLog(client, {
        sorteoId: sorteo_id, numero, accion: 'COMPRA_DIRECTA',
        asociadoCodigo: asociado_codigo, empleadoUuid: req.user.id,
        detalle: `Asignación directa por empleado`,
      });

      await client.query('COMMIT');
      res.status(201).json({ numero, asociado_codigo, estado: 'asignado' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
};

export const retirarDirecto = async (req, res, next) => {
  try {
    const { id: sorteo_id } = req.params;
    const { numero, motivo } = req.body;
    await assertSorteoActivo(sorteo_id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [boleto] } = await client.query(
        'SELECT estado, asociado_codigo FROM boletos WHERE numero = $1 AND sorteo_id = $2 FOR UPDATE',
        [numero, sorteo_id]
      );
      if (!boleto) return res.status(404).json({ error: 'Boleto no encontrado' });
      if (!['asignado', 'pendiente_retiro'].includes(boleto.estado)) {
        return res.status(409).json({ error: `El número ${numero} no tiene un titular asignado` });
      }

      // Cancelar solicitud de retiro pendiente si existe
      await client.query(
        `UPDATE solicitudes_bono SET estado = 'cancelada', updated_at = NOW()
         WHERE sorteo_id = $1 AND numero = $2 AND estado = 'pendiente'`,
        [sorteo_id, numero]
      );

      await client.query(
        `UPDATE boletos SET asociado_codigo = NULL, estado = 'libre', fecha_asignacion = NULL
         WHERE numero = $1 AND sorteo_id = $2`,
        [numero, sorteo_id]
      );

      await insertLog(client, {
        sorteoId: sorteo_id, numero, accion: 'ANULACION_DIRECTA',
        asociadoCodigo: boleto.asociado_codigo, empleadoUuid: req.user.id,
        detalle: motivo ?? 'Retiro directo por empleado',
      });

      await client.query('COMMIT');
      res.json({ numero, estado: 'libre' });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
};

// ── Solicitudes ─────────────────────────────────────────────────────────────

export const listarSolicitudes = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { estado = 'pendiente' } = req.query;
    const { rows } = await pool.query(`
      SELECT sb.*,
             a.nombre, a.apellido, a.nombre_empresa
      FROM solicitudes_bono sb
      JOIN asociados a ON a.codigo = sb.asociado_codigo
      WHERE sb.sorteo_id = $1 AND sb.estado = $2
      ORDER BY sb.created_at ASC
    `, [id, estado]);
    res.json(rows);
  } catch (err) { next(err); }
};

export const aprobarSolicitud = async (req, res, next) => {
  try {
    const { id: sorteo_id, sid } = req.params;
    const { notas } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertSorteoActivo(sorteo_id);

      const { rows: [sol] } = await client.query(
        `SELECT * FROM solicitudes_bono WHERE id = $1 AND sorteo_id = $2 AND estado = 'pendiente' FOR UPDATE`,
        [sid, sorteo_id]
      );
      if (!sol) return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });

      if (sol.tipo === 'adquisicion') {
        await client.query(
          `UPDATE boletos SET estado = 'asignado', fecha_asignacion = NOW()
           WHERE numero = $1 AND sorteo_id = $2`,
          [sol.numero, sorteo_id]
        );
        await insertLog(client, {
          sorteoId: sorteo_id, numero: sol.numero, accion: 'APROBACION',
          asociadoCodigo: sol.asociado_codigo, empleadoUuid: req.user.id,
          detalle: notas ?? 'Solicitud de adquisición aprobada',
        });
      } else {
        await client.query(
          `UPDATE boletos SET asociado_codigo = NULL, estado = 'libre', fecha_asignacion = NULL
           WHERE numero = $1 AND sorteo_id = $2`,
          [sol.numero, sorteo_id]
        );
        await insertLog(client, {
          sorteoId: sorteo_id, numero: sol.numero, accion: 'APROBACION_RETIRO',
          asociadoCodigo: sol.asociado_codigo, empleadoUuid: req.user.id,
          detalle: notas ?? 'Solicitud de retiro aprobada',
        });
      }

      const { rows: [updated] } = await client.query(
        `UPDATE solicitudes_bono
         SET estado = 'aprobada', empleado_uuid = $1, notas = $2, updated_at = NOW()
         WHERE id = $3 RETURNING *`,
        [req.user.id, notas ?? null, sid]
      );

      await client.query('COMMIT');

      const accionTexto = sol.tipo === 'adquisicion' ? 'adquisición' : 'retiro';
      notificarAsociado(sol.asociado_codigo, {
        tipo: 'solicitud_aprobada',
        mensaje: `Tu solicitud de ${accionTexto} del número ${sol.numero} fue aprobada`,
        modulo: 'sorteos',
      }).catch(() => {});

      res.json(updated);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
};

export const rechazarSolicitud = async (req, res, next) => {
  try {
    const { id: sorteo_id, sid } = req.params;
    const { notas } = req.body;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [sol] } = await client.query(
        `SELECT * FROM solicitudes_bono WHERE id = $1 AND sorteo_id = $2 AND estado = 'pendiente' FOR UPDATE`,
        [sid, sorteo_id]
      );
      if (!sol) return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });

      // Revertir estado del boleto
      const estadoAnterior = sol.tipo === 'adquisicion' ? 'libre' : 'asignado';
      await client.query(
        `UPDATE boletos SET estado = $1 WHERE numero = $2 AND sorteo_id = $3`,
        [estadoAnterior, sol.numero, sorteo_id]
      );

      const accion = sol.tipo === 'adquisicion' ? 'RECHAZO' : 'RECHAZO_RETIRO';
      await insertLog(client, {
        sorteoId: sorteo_id, numero: sol.numero, accion,
        asociadoCodigo: sol.asociado_codigo, empleadoUuid: req.user.id,
        detalle: notas ?? 'Solicitud rechazada',
      });

      const { rows: [updated] } = await client.query(
        `UPDATE solicitudes_bono
         SET estado = 'rechazada', empleado_uuid = $1, notas = $2, updated_at = NOW()
         WHERE id = $3 RETURNING *`,
        [req.user.id, notas ?? null, sid]
      );

      await client.query('COMMIT');

      const accionTexto = sol.tipo === 'adquisicion' ? 'adquisición' : 'retiro';
      notificarAsociado(sol.asociado_codigo, {
        tipo: 'solicitud_rechazada',
        mensaje: `Tu solicitud de ${accionTexto} del número ${sol.numero} fue rechazada${notas ? `: ${notas}` : ''}`,
        modulo: 'sorteos',
      }).catch(() => {});

      res.json(updated);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
};

// ── Ganadores ───────────────────────────────────────────────────────────────

export const registrarGanador = async (req, res, next) => {
  try {
    const { id: sorteo_id } = req.params;
    const { numero } = req.body;

    const { rows: [boleto] } = await pool.query(`
      SELECT b.asociado_codigo, a.nombre, a.apellido, a.nombre_empresa
      FROM boletos b
      JOIN asociados a ON a.codigo = b.asociado_codigo
      WHERE b.numero = $1 AND b.sorteo_id = $2 AND b.estado = 'asignado'
    `, [numero, sorteo_id]);

    if (!boleto) {
      return res.status(409).json({ error: `El número ${numero} no tiene titular o no está asignado` });
    }

    const { rows: [ganador] } = await pool.query(
      `INSERT INTO sorteo_ganadores
         (sorteo_id, numero, asociado_codigo, nombre_completo, empresa_en_ese_momento)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        sorteo_id, numero, boleto.asociado_codigo,
        `${boleto.nombre} ${boleto.apellido}`,
        boleto.nombre_empresa,
      ]
    );
    notificarAsociado(boleto.asociado_codigo, {
      tipo: 'ganador_sorteo',
      mensaje: `¡Felicitaciones! Eres ganador del sorteo con el número ${numero}`,
      modulo: 'sorteos',
    }).catch(() => {});

    res.status(201).json(ganador);
  } catch (err) { next(err); }
};

export const listarGanadores = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT * FROM sorteo_ganadores WHERE sorteo_id = $1 ORDER BY fecha_premiacion DESC`,
      [id]
    );
    res.json(rows);
  } catch (err) { next(err); }
};

// ── Logs ────────────────────────────────────────────────────────────────────

export const listarLogs = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(`
      SELECT sl.*, u.nombre AS empleado_nombre
      FROM sorteo_logs sl
      LEFT JOIN global_usuarios u ON u.id = sl.empleado_uuid
      WHERE sl.sorteo_id = $1
      ORDER BY sl.created_at DESC
      LIMIT 500
    `, [id]);
    res.json(rows);
  } catch (err) { next(err); }
};

// ── Estadísticas del sorteo ─────────────────────────────────────────────────

export const estadisticasSorteo = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Ocupación actual
    const { rows: [ocupacion] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE estado = 'libre')::int                  AS libres,
        COUNT(*) FILTER (WHERE estado = 'asignado')::int               AS asignados,
        COUNT(*) FILTER (WHERE estado = 'pendiente_adquisicion')::int  AS pendiente_adquisicion,
        COUNT(*) FILTER (WHERE estado = 'pendiente_retiro')::int       AS pendiente_retiro,
        COUNT(*)::int                                                   AS total
      FROM boletos WHERE sorteo_id = $1
    `, [id]);

    // Snapshot real por día: cuántos boletos estaban activos en cada fecha
    // Para boletos CSV (sin log por boleto): usa updated_at como fecha de asignación
    // Para boletos ya liberados: usa logs de retiro para saber cuándo dejaron de estar activos
    const { rows: snapshot } = await pool.query(`
      WITH boleto_rango AS (
        SELECT
          b.numero,
          -- fecha_asignacion es cuando se asignó el boleto (CSV o directo)
          COALESCE(DATE(b.fecha_asignacion), CURRENT_DATE) AS fecha_desde,
          CASE WHEN b.estado = 'libre' THEN
            COALESCE(
              (SELECT DATE(MAX(sl.created_at))
               FROM sorteo_logs sl
               WHERE sl.sorteo_id = $1 AND sl.numero = b.numero
                 AND sl.accion IN ('ANULACION_DIRECTA','APROBACION_RETIRO','LIBERACION_POR_RETIRO_CSV')),
              CURRENT_DATE
            )
          ELSE NULL END AS fecha_hasta
        FROM boletos b
        WHERE b.sorteo_id = $1
          AND (b.estado != 'libre' OR b.asociado_codigo IS NOT NULL)
      ),
      fechas AS (
        SELECT DISTINCT fecha FROM (
          SELECT DATE(created_at) AS fecha FROM sorteo_logs WHERE sorteo_id = $1
          UNION SELECT DATE(fecha_asignacion) FROM boletos WHERE sorteo_id = $1 AND fecha_asignacion IS NOT NULL
        ) t
        WHERE fecha IS NOT NULL
        ORDER BY fecha
      )
      SELECT
        f.fecha::text AS fecha,
        COUNT(br.numero)::int AS asignados
      FROM fechas f
      LEFT JOIN boleto_rango br ON
        br.fecha_desde IS NOT NULL
        AND br.fecha_desde <= f.fecha
        AND (br.fecha_hasta IS NULL OR br.fecha_hasta > f.fecha)
      GROUP BY f.fecha
      ORDER BY f.fecha
    `, [id]);

    // Movimientos diarios individuales desde logs
    const { rows: movimientos } = await pool.query(`
      SELECT
        DATE(created_at)::text AS fecha,
        COUNT(*) FILTER (WHERE accion IN ('COMPRA_DIRECTA','APROBACION'))::int AS compras,
        COUNT(*) FILTER (WHERE accion IN ('ANULACION_DIRECTA','APROBACION_RETIRO','LIBERACION_POR_RETIRO_CSV'))::int AS retiros
      FROM sorteo_logs
      WHERE sorteo_id = $1
      GROUP BY DATE(created_at)
      ORDER BY DATE(created_at)
    `, [id]);

    const movimientosMap = Object.fromEntries(movimientos.map((m) => [m.fecha, m]));
    const evolucion = snapshot.map((s) => ({
      fecha:     s.fecha,
      asignados: s.asignados,
      compras:   movimientosMap[s.fecha]?.compras ?? 0,
      retiros:   movimientosMap[s.fecha]?.retiros  ?? 0,
    }));

    // Top 10 asociados por boletos activos
    const { rows: topAsociados } = await pool.query(`
      SELECT
        a.nombre || ' ' || a.apellido AS nombre,
        a.codigo,
        COUNT(*) FILTER (WHERE b.estado IN ('asignado','pendiente_retiro'))::int AS boletos
      FROM boletos b
      JOIN asociados a ON a.codigo = b.asociado_codigo
      WHERE b.sorteo_id = $1 AND b.asociado_codigo IS NOT NULL
      GROUP BY a.codigo, a.nombre, a.apellido
      ORDER BY boletos DESC
      LIMIT 10
    `, [id]);

    // Top 10 empresas por boletos activos
    const { rows: porEmpresa } = await pool.query(`
      SELECT
        a.nombre_empresa AS empresa,
        COUNT(*) FILTER (WHERE b.estado IN ('asignado', 'pendiente_retiro'))::int AS boletos
      FROM boletos b
      JOIN asociados a ON a.codigo = b.asociado_codigo
      WHERE b.sorteo_id = $1 AND b.asociado_codigo IS NOT NULL
      GROUP BY a.nombre_empresa
      ORDER BY boletos DESC
      LIMIT 10
    `, [id]);

    // Distribución por ciudad
    const { rows: porCiudad } = await pool.query(`
      SELECT
        COALESCE(a.ciudad, 'Sin ciudad') AS ciudad,
        COUNT(*) FILTER (WHERE b.estado IN ('asignado','pendiente_retiro'))::int AS boletos
      FROM boletos b
      JOIN asociados a ON a.codigo = b.asociado_codigo
      WHERE b.sorteo_id = $1 AND b.asociado_codigo IS NOT NULL
      GROUP BY a.ciudad
      ORDER BY boletos DESC
    `, [id]);

    res.json({ ocupacion, evolucion, porEmpresa, topAsociados, porCiudad });
  } catch (err) { next(err); }
};

// ── Asociados del sorteo ────────────────────────────────────────────────────

export const listarAsociadosSorteo = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Asociados con boletos asignados (cualquier estado no-libre)
    const { rows: asociados } = await pool.query(`
      SELECT
        a.codigo, a.nombre, a.apellido, a.movil, a.ciudad,
        a.nombre_empresa, a.clase_cuota,
        COUNT(b.numero) FILTER (WHERE b.estado = 'asignado')::int          AS boletos_activos,
        ARRAY_AGG(b.numero ORDER BY b.numero) FILTER (WHERE b.estado = 'asignado') AS numeros_activos
      FROM boletos b
      JOIN asociados a ON a.codigo = b.asociado_codigo
      WHERE b.sorteo_id = $1 AND b.asociado_codigo IS NOT NULL
      GROUP BY a.codigo, a.nombre, a.apellido, a.movil, a.ciudad, a.nombre_empresa, a.clase_cuota
      ORDER BY a.apellido, a.nombre
    `, [id]);

    res.json(asociados);
  } catch (err) { next(err); }
};

const VALOR_CUOTA = { '1': 1500, '2': 3000 };

export const reporteParticipantes = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rows } = await pool.query(`
      SELECT
        a.codigo,
        a.nombre,
        a.apellido,
        a.ciudad,
        a.nombre_empresa,
        a.clase_cuota,
        COUNT(b.numero) FILTER (WHERE b.estado = 'asignado')::int AS boletos_activos,
        ARRAY_AGG(b.numero ORDER BY b.numero) FILTER (WHERE b.estado = 'asignado') AS numeros_activos
      FROM boletos b
      JOIN asociados a ON a.codigo = b.asociado_codigo
      WHERE b.sorteo_id = $1 AND b.estado = 'asignado'
      GROUP BY a.codigo, a.nombre, a.apellido, a.ciudad, a.nombre_empresa, a.clase_cuota
      HAVING COUNT(b.numero) FILTER (WHERE b.estado = 'asignado') > 0
      ORDER BY a.apellido, a.nombre
    `, [id]);

    const reporte = rows.map((a) => ({
      cedula:        a.codigo,
      nombre:        a.nombre,
      apellido:      a.apellido,
      nombre_completo: `${a.nombre} ${a.apellido}`,
      ciudad:        a.ciudad ?? '',
      empresa:       a.nombre_empresa ?? '',
      clase_cuota:   a.clase_cuota === '1' ? 'Quincenal' : a.clase_cuota === '2' ? 'Mensual' : a.clase_cuota ?? '',
      valor_cuota:   (VALOR_CUOTA[a.clase_cuota] ?? 0) * a.boletos_activos,
      bonos:         a.boletos_activos,
      numeros:       (a.numeros_activos ?? []).map((n) => String(n).padStart(3, '0')).join(', '),
    }));

    res.json(reporte);
  } catch (err) { next(err); }
};

export const historialAsociadoSorteo = async (req, res, next) => {
  try {
    const { id, codigo } = req.params;
    const { rows } = await pool.query(`
      SELECT sl.numero, sl.accion, sl.detalle, sl.created_at,
             u.nombre AS empleado_nombre
      FROM sorteo_logs sl
      LEFT JOIN global_usuarios u ON u.id = sl.empleado_uuid
      WHERE sl.sorteo_id = $1 AND sl.asociado_codigo = $2
      ORDER BY sl.created_at DESC
    `, [id, codigo]);
    res.json(rows);
  } catch (err) { next(err); }
};

// ── Portal asociados ────────────────────────────────────────────────────────

export const portalActivo = async (req, res, next) => {
  try {
    const codigo = req.asociado.id;

    // Sorteo activo donde la empresa del asociado esté habilitada
    const { rows: [sorteo] } = await pool.query(`
      SELECT s.*
      FROM sorteos s
      JOIN sorteo_empresas se ON se.sorteo_id = s.id
      JOIN asociados a ON a.empresa_dsto = se.empresa_codigo
      WHERE s.estado = 'activo' AND a.codigo = $1
      ORDER BY s.created_at DESC
      LIMIT 1
    `, [codigo]);

    if (!sorteo) return res.json({ sorteo: null, mis_boletos: [], disponibles: [] });

    const { rows: mis_boletos } = await pool.query(`
      SELECT b.numero, b.estado, b.fecha_asignacion,
             sb.id AS solicitud_id, sb.tipo AS solicitud_tipo
      FROM boletos b
      LEFT JOIN solicitudes_bono sb ON sb.sorteo_id = b.sorteo_id
        AND sb.numero = b.numero AND sb.asociado_codigo = $1 AND sb.estado = 'pendiente'
      WHERE b.sorteo_id = $2 AND b.asociado_codigo = $1
      ORDER BY b.numero
    `, [codigo, sorteo.id]);

    const { rows: disponibles } = await pool.query(`
      SELECT numero FROM boletos
      WHERE sorteo_id = $1 AND estado = 'libre'
      ORDER BY numero
    `, [sorteo.id]);

    res.json({ sorteo, mis_boletos, disponibles });
  } catch (err) { next(err); }
};

export const solicitarBono = async (req, res, next) => {
  try {
    const { numero, sorteo_id } = req.body;
    const codigo = req.asociado.id;
    await assertSorteoActivo(sorteo_id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [asoc] } = await client.query(
        'SELECT empresa_dsto FROM asociados WHERE codigo = $1',
        [codigo]
      );

      const { rows: emp } = await client.query(
        'SELECT 1 FROM sorteo_empresas WHERE sorteo_id = $1 AND empresa_codigo = $2',
        [sorteo_id, asoc.empresa_dsto]
      );
      if (!emp.length) {
        return res.status(409).json({ error: 'Tu empresa no está habilitada en este sorteo' });
      }

      const { rows: [boleto] } = await client.query(
        `SELECT estado FROM boletos WHERE numero = $1 AND sorteo_id = $2 FOR UPDATE`,
        [numero, sorteo_id]
      );
      if (!boleto) return res.status(404).json({ error: 'Número no encontrado' });
      if (boleto.estado !== 'libre') {
        return res.status(409).json({ error: `El número ${numero} no está disponible` });
      }

      await client.query(
        `UPDATE boletos SET estado = 'pendiente_adquisicion', asociado_codigo = $1
         WHERE numero = $2 AND sorteo_id = $3`,
        [codigo, numero, sorteo_id]
      );

      const { rows: [sol] } = await client.query(
        `INSERT INTO solicitudes_bono (sorteo_id, numero, asociado_codigo, tipo)
         VALUES ($1,$2,$3,'adquisicion') RETURNING *`,
        [sorteo_id, numero, codigo]
      );

      await insertLog(client, {
        sorteoId: sorteo_id, numero, accion: 'SOLICITUD_ADQUISICION',
        asociadoCodigo: codigo, detalle: 'Solicitud desde portal',
      });

      await client.query('COMMIT');

      notificarPorPermiso('sorteos', {
        tipo: 'solicitud_bono',
        mensaje: `Solicitud de adquisición del número ${numero} recibida`,
      }).catch(() => {});

      res.status(201).json(sol);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
};

export const solicitarRetiro = async (req, res, next) => {
  try {
    const { numero, sorteo_id } = req.body;
    const codigo = req.asociado.id;
    await assertSorteoActivo(sorteo_id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [boleto] } = await client.query(
        `SELECT estado, asociado_codigo FROM boletos
         WHERE numero = $1 AND sorteo_id = $2 FOR UPDATE`,
        [numero, sorteo_id]
      );
      if (!boleto || boleto.asociado_codigo !== codigo) {
        return res.status(404).json({ error: 'No tienes este número asignado' });
      }
      if (boleto.estado !== 'asignado') {
        return res.status(409).json({ error: 'Ya tienes una solicitud pendiente para este número' });
      }

      await client.query(
        `UPDATE boletos SET estado = 'pendiente_retiro' WHERE numero = $1 AND sorteo_id = $2`,
        [numero, sorteo_id]
      );

      const { rows: [sol] } = await client.query(
        `INSERT INTO solicitudes_bono (sorteo_id, numero, asociado_codigo, tipo)
         VALUES ($1,$2,$3,'retiro') RETURNING *`,
        [sorteo_id, numero, codigo]
      );

      await insertLog(client, {
        sorteoId: sorteo_id, numero, accion: 'SOLICITUD_RETIRO',
        asociadoCodigo: codigo, detalle: 'Solicitud desde portal',
      });

      await client.query('COMMIT');

      notificarPorPermiso('sorteos', {
        tipo: 'solicitud_bono',
        mensaje: `Solicitud de retiro del número ${numero} recibida`,
      }).catch(() => {});

      res.status(201).json(sol);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
};

export const cancelarSolicitud = async (req, res, next) => {
  try {
    const { sid } = req.params;
    const codigo = req.asociado.id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [sol] } = await client.query(
        `SELECT * FROM solicitudes_bono
         WHERE id = $1 AND asociado_codigo = $2 AND estado = 'pendiente' FOR UPDATE`,
        [sid, codigo]
      );
      if (!sol) return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });

      // Revertir estado del boleto
      const estadoAnterior = sol.tipo === 'adquisicion' ? 'libre' : 'asignado';
      const asociadoAnterior = sol.tipo === 'adquisicion' ? null : codigo;

      await client.query(
        `UPDATE boletos SET estado = $1, asociado_codigo = $2
         WHERE numero = $3 AND sorteo_id = $4`,
        [estadoAnterior, asociadoAnterior, sol.numero, sol.sorteo_id]
      );

      await client.query(
        `UPDATE solicitudes_bono SET estado = 'cancelada', updated_at = NOW() WHERE id = $1`,
        [sid]
      );

      await insertLog(client, {
        sorteoId: sol.sorteo_id, numero: sol.numero, accion: 'CANCELACION_ASOCIADO',
        asociadoCodigo: codigo, detalle: `Cancelación de solicitud de ${sol.tipo}`,
      });

      await client.query('COMMIT');
      res.json({ cancelada: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
};
