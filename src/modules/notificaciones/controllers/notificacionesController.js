import pool from '../../../db/database.js';

// Empleados: solo notificaciones de módulos con permiso READ
export const listar = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT n.*
       FROM notificaciones n
       WHERE n.usuario_uuid = $1
         AND n.modulo IN (
           SELECT m.nombre
           FROM permisos p
           JOIN modulos m ON m.id = p.modulo_id
           JOIN acciones a ON a.id = p.accion_id
           WHERE p.usuario_uuid = $1 AND a.nombre = 'READ'
         )
       ORDER BY n.created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

export const marcarLeida = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE notificaciones SET leida = true
       WHERE id = $1 AND usuario_uuid = $2
       RETURNING id`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Notificación no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

export const marcarTodasLeidas = async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE notificaciones SET leida = true
       WHERE usuario_uuid = $1 AND leida = false`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};
