import pool from '../../../db/database.js';

export const listar = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.codigo, e.nombre, e.is_active, e.fecha_ingreso, e.fecha_retiro,
              COUNT(DISTINCT a.codigo) FILTER (WHERE a.is_active = true)          AS asociados_activos,
              COALESCE(SUM(a.valor_aporte) FILTER (WHERE a.is_active = true), 0)  AS sum_aportes,
              COUNT(b.numero) FILTER (WHERE b.estado = 'asignado')                AS bonos_activos,
              COUNT(DISTINCT a.codigo) FILTER (WHERE a.is_active AND a.saldo_aporte > 0) AS mora_count
       FROM empresas e
       LEFT JOIN asociados a ON a.empresa_dsto = e.codigo
       LEFT JOIN boletos b   ON b.asociado_codigo = a.codigo
       GROUP BY e.codigo
       ORDER BY e.nombre`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

export const perfil = async (req, res, next) => {
  try {
    const { codigo } = req.params;

    const { rows: [empresa] } = await pool.query(
      `SELECT codigo, nombre, is_active, fecha_ingreso, fecha_retiro,
              contacto_nombre, contacto_telefono, contacto_email
       FROM empresas WHERE codigo = $1`,
      [codigo]
    );
    if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });

    const { rows: [stats] } = await pool.query(
      `SELECT
         COUNT(*)                              FILTER (WHERE is_active)  AS asociados_activos,
         COUNT(*)                                                        AS asociados_total,
         COALESCE(SUM(valor_aporte)            FILTER (WHERE is_active), 0) AS sum_aportes,
         COALESCE(SUM(ABS(saldo_aporte))       FILTER (WHERE is_active AND saldo_aporte < 0), 0) AS saldo_favor,
         COALESCE(SUM(saldo_aporte)            FILTER (WHERE is_active AND saldo_aporte > 0), 0) AS saldo_pendiente,
         COUNT(*)                              FILTER (WHERE is_active AND saldo_aporte > 0) AS mora_count
       FROM asociados WHERE empresa_dsto = $1`,
      [codigo]
    );

    const { rows: [{ bonos_activos }] } = await pool.query(
      `SELECT COUNT(b.numero) AS bonos_activos
       FROM boletos b
       JOIN asociados a ON a.codigo = b.asociado_codigo
       WHERE a.empresa_dsto = $1 AND b.estado = 'asignado'`,
      [codigo]
    );

    const { rows: asociados } = await pool.query(
      `SELECT codigo, nombre, apellido, movil, ciudad, clase_cuota,
              is_active, valor_aporte, saldo_aporte, portal_activo
       FROM asociados WHERE empresa_dsto = $1 ORDER BY apellido, nombre`,
      [codigo]
    );

    const { rows: notas } = await pool.query(
      `SELECT n.id, n.contenido, n.created_at,
              u.nombre || ' ' || COALESCE(u.apellido, '') AS autor
       FROM empresa_notas n
       LEFT JOIN global_usuarios u ON u.id = n.usuario_uuid
       WHERE n.empresa_codigo = $1 AND n.is_active = true
       ORDER BY n.created_at DESC`,
      [codigo]
    );

    res.json({ empresa, stats: { ...stats, bonos_activos }, asociados, notas });
  } catch (err) {
    next(err);
  }
};

export const actualizarContacto = async (req, res, next) => {
  try {
    const { codigo } = req.params;
    const { contacto_nombre, contacto_telefono, contacto_email } = req.body;

    const { rows: [empresa] } = await pool.query(
      `UPDATE empresas
       SET contacto_nombre = $1, contacto_telefono = $2, contacto_email = $3, updated_at = NOW()
       WHERE codigo = $4
       RETURNING codigo, contacto_nombre, contacto_telefono, contacto_email`,
      [contacto_nombre || null, contacto_telefono || null, contacto_email || null, codigo]
    );
    if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });
    res.json(empresa);
  } catch (err) {
    next(err);
  }
};

export const crearNota = async (req, res, next) => {
  try {
    const { codigo } = req.params;
    const { contenido } = req.body;
    const usuario_uuid = req.user?.id ?? null;

    if (!contenido?.trim()) return res.status(400).json({ error: 'La nota no puede estar vacía' });

    const { rows: [nota] } = await pool.query(
      `INSERT INTO empresa_notas (empresa_codigo, contenido, usuario_uuid)
       VALUES ($1, $2, $3)
       RETURNING id, contenido, created_at`,
      [codigo, contenido.trim(), usuario_uuid]
    );

    let autor = null;
    if (usuario_uuid) {
      const { rows: [u] } = await pool.query(
        `SELECT nombre || ' ' || COALESCE(apellido, '') AS autor FROM global_usuarios WHERE id = $1`,
        [usuario_uuid]
      );
      autor = u?.autor ?? null;
    }

    res.status(201).json({ ...nota, autor });
  } catch (err) {
    next(err);
  }
};

export const eliminarNota = async (req, res, next) => {
  try {
    const { id } = req.params;
    const usuario_uuid = req.user?.id ?? null;

    const { rows: [nota] } = await pool.query(
      `SELECT usuario_uuid FROM empresa_notas WHERE id = $1 AND is_active = true`,
      [id]
    );
    if (!nota) return res.status(404).json({ error: 'Nota no encontrada' });

    // Solo el autor o un admin puede borrar
    const { rows: [user] } = await pool.query(
      `SELECT rol FROM global_usuarios WHERE id = $1`, [usuario_uuid]
    );
    if (nota.usuario_uuid !== usuario_uuid && user?.rol !== 'admin') {
      return res.status(403).json({ error: 'Sin permiso para eliminar esta nota' });
    }

    await pool.query(`UPDATE empresa_notas SET is_active = false WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

export const historial = async (req, res, next) => {
  try {
    const { codigo } = req.params;

    // Genera los últimos 12 meses
    const { rows } = await pool.query(
      `WITH meses AS (
         SELECT generate_series(
           date_trunc('month', NOW()) - interval '11 months',
           date_trunc('month', NOW()),
           interval '1 month'
         ) AS mes
       )
       SELECT
         to_char(m.mes, 'YYYY-MM')                                                AS mes,
         to_char(m.mes, 'Mon YY')                                                 AS label,
         COUNT(a.codigo) FILTER (
           WHERE a.fecha_ingreso <= m.mes + interval '1 month' - interval '1 day'
             AND (a.fecha_retiro IS NULL OR a.fecha_retiro >= m.mes)
             AND a.is_active = true
         )                                                                        AS asociados_activos,
         COALESCE(SUM(a.valor_aporte) FILTER (
           WHERE a.fecha_ingreso <= m.mes + interval '1 month' - interval '1 day'
             AND (a.fecha_retiro IS NULL OR a.fecha_retiro >= m.mes)
             AND a.is_active = true
         ), 0)                                                                    AS aporte_mensual
       FROM meses m
       CROSS JOIN (SELECT * FROM asociados WHERE empresa_dsto = $1) a
       GROUP BY m.mes
       ORDER BY m.mes`,
      [codigo]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
};
