import pool from '../db/database.js';

const SKIP_MODULOS = new Set(['auth', 'public']);

export const logActividad = (req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    if (!req.user?.id) return;

    const parts    = req.path.split('/'); // ['', 'api', 'modulo', ...]
    const modulo   = parts[2] ?? 'unknown';
    if (SKIP_MODULOS.has(modulo)) return;

    const duracion  = Date.now() - start;
    const endpoint  = req.path.slice(0, 200);
    const ip        = req.ip ?? req.socket?.remoteAddress ?? null;

    pool.query(
      `INSERT INTO global_actividad (usuario_id, modulo, metodo, endpoint, status_code, duracion_ms, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.user.id, modulo, req.method, endpoint, res.statusCode, duracion, ip]
    ).catch(() => {});

    pool.query(
      `UPDATE global_usuarios SET last_active_at = NOW() WHERE id = $1`,
      [req.user.id]
    ).catch(() => {});
  });

  next();
};
