import pool from '../../../db/database.js';

export const listar = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.codigo, e.nombre, e.is_active, e.fecha_ingreso, e.fecha_retiro,
              COUNT(a.codigo) FILTER (WHERE a.is_active = true) AS asociados_activos
       FROM empresas e
       LEFT JOIN asociados a ON a.empresa_dsto = e.codigo
       GROUP BY e.codigo
       ORDER BY e.nombre`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};
