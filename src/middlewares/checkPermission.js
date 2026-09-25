import pool from '../db/database.js';

// `accion` puede ser una lista: basta con tener cualquiera de ellas (p. ej. ['WRITE', 'VALIDAR'])
export const checkPermission = (modulo, accion) => async (req, res, next) => {
  if (req.user.rol === 'admin') return next();

  const { id: usuario_uuid } = req.user;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM permisos p
       JOIN modulos m ON m.id = p.modulo_id
       JOIN acciones a ON a.id = p.accion_id
       WHERE p.usuario_uuid = $1 AND m.nombre = $2 AND a.nombre = ANY($3::text[])`,
      [usuario_uuid, modulo, [].concat(accion)]
    );
    if (!rows.length) return res.status(403).json({ error: 'Sin permiso' });
    next();
  } catch (err) {
    next(err);
  }
};
