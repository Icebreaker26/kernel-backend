import bcrypt from 'bcrypt';
import pool from '../../../db/database.js';
import { uploadToS3, deleteFromS3, keyFromUrl } from '../../../services/s3Service.js';

export const obtenerPerfil = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, email, rol, avatar_url, created_at
       FROM global_usuarios WHERE id = $1`,
      [req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

export const subirAvatar = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

    const { buffer, mimetype, originalname } = req.file;
    const ext = originalname.split('.').pop().toLowerCase();
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      return res.status(400).json({ error: 'Formato no permitido. Usa JPG, PNG o WebP.' });
    }
    if (buffer.length > 2 * 1024 * 1024) {
      return res.status(400).json({ error: 'La imagen no puede superar 2 MB' });
    }

    // Borrar avatar anterior de S3 si existe
    const { rows: [u] } = await pool.query(
      'SELECT avatar_url FROM global_usuarios WHERE id = $1', [req.user.id]
    );
    if (u?.avatar_url) deleteFromS3(keyFromUrl(u.avatar_url));

    const key = `avatars/${req.user.id}.${ext}`;
    const url = await uploadToS3({ buffer, key, contentType: mimetype });

    const { rows } = await pool.query(
      `UPDATE global_usuarios SET avatar_url = $1, updated_at = NOW()
       WHERE id = $2 RETURNING avatar_url`,
      [url, req.user.id]
    );
    res.json({ avatar_url: rows[0].avatar_url });
  } catch (err) {
    next(err);
  }
};

export const actualizarPerfil = async (req, res, next) => {
  try {
    const { nombre, email } = req.body;

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
    const { password_actual, password_nueva } = req.body;

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
