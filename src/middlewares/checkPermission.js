import pool from '../db/database.js';

export const checkPermission = (modulo, accion) => async (req, res, next) => {
  const { id: usuario_uuid } = req.user;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM permisos p
       JOIN modulos m ON m.id = p.modulo_id
       JOIN acciones a ON a.id = p.accion_id
       WHERE p.usuario_uuid = $1 AND m.nombre = $2 AND a.nombre = $3`,
      [usuario_uuid, modulo, accion]
    );
    if (!rows.length) return res.status(403).json({ error: 'Sin permiso' });
    next();
  } catch (err) {
    next(err);
  }
};
