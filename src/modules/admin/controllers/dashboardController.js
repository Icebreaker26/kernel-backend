import pool from '../../../db/database.js';

export const metricas = async (req, res, next) => {
  try {
    const { rows: [data] } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM asociados WHERE is_active = true)::int                          AS asociados_activos,
        (SELECT COUNT(*) FROM asociados)::int                                                 AS asociados_total,
        (SELECT COUNT(*) FROM sorteos WHERE estado = 'activo')::int                           AS sorteos_activos,
        (SELECT COUNT(*) FROM solicitudes_bono WHERE estado = 'pendiente')::int               AS solicitudes_pendientes,
        (SELECT COUNT(*) FROM global_usuarios WHERE is_approved = false AND is_active = true)::int AS usuarios_pendientes
    `);
    res.json(data);
  } catch (err) {
    next(err);
  }
};
