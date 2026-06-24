import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../../../db/database.js';
import { env } from '../../../config/env.js';
import { loginSchema } from '../schemas/authSchema.js';

export const login = async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const { rows } = await pool.query(
      `SELECT id, nombre, email, password_hash, rol
       FROM global_usuarios
       WHERE email = $1 AND is_active = true AND is_approved = true`,
      [email]
    );

    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, rol: user.rol },
      env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.cookie('token', token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
    });

    res.json({ id: user.id, nombre: user.nombre, email: user.email, rol: user.rol });
  } catch (err) {
    next(err);
  }
};

export const logout = (_req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Sesión cerrada' });
};

export const me = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, email, rol FROM global_usuarios WHERE id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};
