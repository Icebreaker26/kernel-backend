import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import pool from '../../../db/database.js';
import { env } from '../../../config/env.js';
import { loginSchema, registerSchema } from '../schemas/authSchema.js';
import { notificarAdmins } from '../../../services/notificationService.js';
import { redisClient } from '../../../config/redis.js';

const cookieOpts = () => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge: 8 * 60 * 60 * 1000,
});

const getModulos = async (userId, rol) => {
  if (rol === 'admin') {
    const { rows } = await pool.query(`SELECT nombre FROM modulos ORDER BY nombre`);
    return rows.map((m) => m.nombre);
  }
  const { rows } = await pool.query(
    `SELECT DISTINCT m.nombre FROM permisos p
     JOIN modulos m ON m.id = p.modulo_id
     JOIN acciones a ON a.id = p.accion_id
     WHERE p.usuario_uuid = $1 AND a.nombre = 'READ'`,
    [userId]
  );
  return rows.map((m) => m.nombre);
};

export const login = async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    const { rows } = await pool.query(
      `SELECT id, nombre, email, password_hash, rol, failed_attempts, locked_until
       FROM global_usuarios
       WHERE email = $1 AND is_active = true AND is_approved = true`,
      [email]
    );

    const user = rows[0];

    // F-06: bloqueo por intentos fallidos — respuesta genérica para no confirmar si el email existe
    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(429).json({ error: 'Cuenta bloqueada temporalmente. Intenta en 15 minutos.' });
    }

    const valid = user && await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      if (user) {
        const attempts = (user.failed_attempts || 0) + 1;
        const lock = attempts >= 5
          ? `NOW() + INTERVAL '15 minutes'`
          : 'NULL';
        await pool.query(
          `UPDATE global_usuarios SET failed_attempts = $1, locked_until = ${lock} WHERE id = $2`,
          [attempts, user.id]
        ).catch(() => {});
      }
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // Reset contador en login exitoso
    if (user.failed_attempts > 0) {
      pool.query(
        `UPDATE global_usuarios SET failed_attempts = 0, locked_until = NULL WHERE id = $1`,
        [user.id]
      ).catch(() => {});
    }

    const jti = randomUUID();
    const token = jwt.sign(
      { id: user.id, email: user.email, rol: user.rol, jti },
      env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.cookie('token', token, cookieOpts());

    // Registrar evento de sesión (fire-and-forget)
    const ip = req.ip ?? req.socket?.remoteAddress ?? null;
    pool.query(
      `INSERT INTO global_actividad (usuario_id, modulo, metodo, endpoint, status_code, duracion_ms, ip)
       VALUES ($1, 'auth', 'SESSION', 'login', 200, 0, $2)`,
      [user.id, ip]
    ).catch(() => {});
    pool.query(
      `UPDATE global_usuarios SET last_active_at = NOW() WHERE id = $1`,
      [user.id]
    ).catch(() => {});

    const modulos = await getModulos(user.id, user.rol);
    res.json({ id: user.id, nombre: user.nombre, email: user.email, rol: user.rol, modulos });
  } catch (err) {
    next(err);
  }
};

export const logout = async (req, res) => {
  // F-04: revocar el JWT actual añadiéndolo a la blacklist de Redis
  try {
    const token = req.cookies?.token;
    if (token && redisClient) {
      const payload = jwt.decode(token);
      if (payload?.jti && payload?.exp) {
        const ttl = payload.exp - Math.floor(Date.now() / 1000);
        if (ttl > 0) await redisClient.set(`jti:${payload.jti}`, '1', 'EX', ttl);
      }
    }
  } catch { /* si Redis falla, el logout igual procede */ }

  res.clearCookie('token', cookieOpts());
  res.json({ message: 'Sesión cerrada' });
};

export const register = async (req, res, next) => {
  try {
    const { nombre, email, password, rol } = registerSchema.parse(req.body);

    const { rows: existing } = await pool.query(
      'SELECT id FROM global_usuarios WHERE email = $1', [email]
    );
    if (existing.length) return res.status(409).json({ error: 'No fue posible completar el registro. Verifica los datos o contacta al administrador.' });

    const password_hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
       VALUES ($1, $2, $3, $4, true, false)
       RETURNING id, nombre, email, rol`,
      [nombre, email, password_hash, rol]
    );
    notificarAdmins({
      tipo: 'usuario_pendiente',
      mensaje: `Nuevo usuario registrado: ${nombre} (${email}) — pendiente de aprobación`,
      modulo: 'admin',
    }).catch(() => {});

    res.status(201).json({ ...rows[0], message: 'Registro exitoso. Pendiente de aprobación.' });
  } catch (err) {
    next(err);
  }
};

export const me = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, email, rol, avatar_url FROM global_usuarios WHERE id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });

    const user = rows[0];
    const modulos = await getModulos(user.id, user.rol);
    res.json({ ...user, modulos });
  } catch (err) {
    next(err);
  }
};
