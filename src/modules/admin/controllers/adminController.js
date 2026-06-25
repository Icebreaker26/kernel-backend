import pool from '../../../db/database.js';
import { cambiarRolSchema, asignarPermisosSchema } from '../schemas/adminSchema.js';

export const listarUsuarios = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, email, rol, is_active, is_approved, created_at
       FROM global_usuarios
       ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

export const aprobarUsuario = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE global_usuarios SET is_approved = true WHERE id = $1 RETURNING id, nombre, email`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

export const desactivarUsuario = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE global_usuarios SET is_active = false WHERE id = $1 RETURNING id, nombre, email`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

export const cambiarRol = async (req, res, next) => {
  try {
    const { rol } = cambiarRolSchema.parse(req.body);
    const { rows } = await pool.query(
      `UPDATE global_usuarios SET rol = $1 WHERE id = $2 RETURNING id, nombre, email, rol`,
      [rol, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

export const asignarPermisosmasivo = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { usuario_uuid, permisos } = asignarPermisosSchema.parse(req.body);

    await client.query('BEGIN');

    // Limpiar permisos actuales del usuario
    await client.query('DELETE FROM permisos WHERE usuario_uuid = $1', [usuario_uuid]);

    for (const { modulo, acciones } of permisos) {
      const { rows: [mod] } = await client.query(
        'SELECT id FROM modulos WHERE nombre = $1', [modulo]
      );
      if (!mod) continue;

      for (const accion of acciones) {
        const { rows: [acc] } = await client.query(
          'SELECT id FROM acciones WHERE nombre = $1', [accion]
        );
        if (!acc) continue;

        await client.query(
          `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [usuario_uuid, mod.id, acc.id]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ message: 'Permisos asignados correctamente' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

export const listarPermisosUsuario = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.nombre AS modulo, a.nombre AS accion
       FROM permisos p
       JOIN modulos m ON m.id = p.modulo_id
       JOIN acciones a ON a.id = p.accion_id
       WHERE p.usuario_uuid = $1
       ORDER BY m.nombre, a.nombre`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

export const listarModulos = async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT nombre, descripcion FROM modulos ORDER BY nombre');
    res.json(rows);
  } catch (err) {
    next(err);
  }
};
