import pool from '../../../db/database.js';

export const listar = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.codigo, e.nombre, e.is_active, e.fecha_ingreso, e.fecha_retiro,
              COUNT(DISTINCT a.codigo) FILTER (WHERE a.is_active = true)   AS asociados_activos,
              COALESCE(SUM(a.valor_aporte) FILTER (WHERE a.is_active = true), 0) AS sum_aportes,
              COUNT(b.numero) FILTER (WHERE b.estado = 'asignado')         AS bonos_activos
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
      `SELECT codigo, nombre, is_active, fecha_ingreso, fecha_retiro FROM empresas WHERE codigo = $1`,
      [codigo]
    );
    if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });

    const { rows: [stats] } = await pool.query(
      `SELECT
         COUNT(*)                              FILTER (WHERE is_active)  AS asociados_activos,
         COUNT(*)                                                        AS asociados_total,
         COALESCE(SUM(valor_aporte)            FILTER (WHERE is_active), 0) AS sum_aportes,
         COALESCE(SUM(ABS(saldo_aporte))       FILTER (WHERE is_active AND saldo_aporte < 0), 0) AS saldo_favor,
         COALESCE(SUM(saldo_aporte)            FILTER (WHERE is_active AND saldo_aporte > 0), 0) AS saldo_pendiente
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

    res.json({ empresa, stats: { ...stats, bonos_activos }, asociados });
  } catch (err) {
    next(err);
  }
};
