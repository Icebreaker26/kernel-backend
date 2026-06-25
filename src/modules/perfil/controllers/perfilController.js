import bcrypt from 'bcrypt';
import pool from '../../../db/database.js';
import { actualizarPerfilSchema, cambiarPasswordSchema } from '../schemas/perfilSchema.js';

export const obtenerPerfil = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, email, rol, created_at
       FROM global_usuarios WHERE id = $1`,
      [req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

export const actualizarPerfil = async (req, res, next) => {
  try {
    const { nombre, email } = actualizarPerfilSchema.parse(req.body);

    const { rows: existing } = await pool.query(
      'SELECT id FROM global_usuarios WHERE email = $1 AND id != $2',
      [email, req.user.id]
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: 'El email ya está en uso' });
    }

    const { rows } = await pool.query(
      `UPDATE global_usuarios
       SET nombre = $1, email = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, nombre, email, rol`,
      [nombre, email, req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

export const cambiarPassword = async (req, res, next) => {
  try {
    const { password_actual, password_nueva } = cambiarPasswordSchema.parse(req.body);

    const { rows } = await pool.query(
      'SELECT password_hash FROM global_usuarios WHERE id = $1',
      [req.user.id]
    );
    const valida = await bcrypt.compare(password_actual, rows[0].password_hash);
    if (!valida) {
      return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    }

    const hash = await bcrypt.hash(password_nueva, 10);
    await pool.query(
      'UPDATE global_usuarios SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [hash, req.user.id]
    );
    res.json({ message: 'Contraseña actualizada' });
  } catch (err) {
    next(err);
  }
};
