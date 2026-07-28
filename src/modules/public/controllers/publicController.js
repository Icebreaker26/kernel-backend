import pool from '../../../db/database.js';

export const ganadores = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        s.nombre        AS sorteo_nombre,
        sg.numero,
        sg.mes_premiacion
      FROM sorteo_ganadores sg
      JOIN sorteos s ON s.id = sg.sorteo_id
      ORDER BY sg.mes_premiacion DESC, sg.fecha_premiacion DESC
      LIMIT 50
    `);
    res.json(rows);
  } catch (err) { next(err); }
};
