import pool from '../../../db/database.js';
import { redisClient } from '../../../config/redis.js';
import logger from '../../../config/logger.js';

// GET /api/seguridad/alertas
export const listarAlertas = async (req, res, next) => {
  try {
    const { estado = 'nueva', regla, limit = 50 } = req.query;
    const conditions = [];
    const params     = [Number(limit)];

    if (estado !== 'todas') { params.push(estado); conditions.push(`sa.estado = $${params.length}`); }
    if (regla)              { params.push(regla);  conditions.push(`sa.regla  = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT sa.*,
             u.nombre  AS usuario_nombre,
             u.email   AS usuario_email,
             r.nombre  AS reconocida_por_nombre
        FROM security_alerts sa
        LEFT JOIN global_usuarios u ON u.id = sa.usuario_uuid
        LEFT JOIN global_usuarios r ON r.id = sa.reconocida_por_uuid
      ${where}
      ORDER BY sa.ultima_vez_at DESC
      LIMIT $1
    `, params);
    res.json(rows);
  } catch (err) { next(err); }
};

// PATCH /api/seguridad/alertas/:id
export const actualizarAlerta = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { estado, nota } = req.body;
    const estadosValidos = ['reconocida', 'resuelta', 'falso_positivo'];
    if (!estadosValidos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

    const { rows: [alerta] } = await pool.query(`
      UPDATE security_alerts
         SET estado              = $1,
             nota                = COALESCE($2, nota),
             reconocida_por_uuid = $3,
             reconocida_at       = NOW()
       WHERE id = $4
      RETURNING *
    `, [estado, nota ?? null, req.user.id, id]);

    if (!alerta) return res.status(404).json({ error: 'Alerta no encontrada' });
    res.json(alerta);
  } catch (err) { next(err); }
};

// GET /api/seguridad/metricas
export const metricas = async (req, res, next) => {
  try {
    const { rows: [snap] } = await pool.query(
      `SELECT datos, calculado_at, duracion_ms FROM security_metrics_snapshot WHERE clave = 'resumen_1h'`
    );
    // Sesiones activas siempre en vivo (no del snapshot)
    const { rows: [sesiones] } = await pool.query(
      `SELECT COUNT(*) AS n FROM global_usuarios WHERE last_active_at > NOW() - INTERVAL '15 minutes' AND is_active = true`
    );
    res.json({
      ...(snap?.datos ?? {}),
      sesiones_activas: Number(sesiones.n),
      calculado_at: snap?.calculado_at ?? null,
    });
  } catch (err) { next(err); }
};

// GET /api/seguridad/login-fallidos
export const loginFallidos = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT u.id, u.nombre, u.email, u.failed_attempts, u.locked_until,
             (u.locked_until IS NOT NULL AND u.locked_until > NOW()) AS bloqueado
        FROM global_usuarios u
       WHERE u.failed_attempts > 0 OR (u.locked_until IS NOT NULL AND u.locked_until > NOW())
       ORDER BY u.failed_attempts DESC
       LIMIT 50
    `);
    res.json(rows);
  } catch (err) { next(err); }
};

// POST /api/seguridad/usuarios/:id/desbloquear
export const desbloquear = async (req, res, next) => {
  try {
    const { id } = req.params;
    await pool.query(
      `UPDATE global_usuarios SET failed_attempts = 0, locked_until = NULL WHERE id = $1`,
      [id]
    );
    logger.info(`[SEGURIDAD] Usuario ${id} desbloqueado por ${req.user.id}`);
    res.json({ ok: true });
  } catch (err) { next(err); }
};

// GET /api/seguridad/intentos-login
export const intentosLogin = async (req, res, next) => {
  try {
    const { email, ip, motivo, limit = 100 } = req.query;
    const conditions = [];
    const params     = [];

    if (email)  { params.push(`%${email}%`);  conditions.push(`ai.email ILIKE $${params.length}`); }
    if (ip)     { params.push(`%${ip}%`);     conditions.push(`ai.ip ILIKE $${params.length}`); }
    if (motivo) { params.push(motivo);         conditions.push(`ai.motivo = $${params.length}`); }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Number(limit));

    const { rows } = await pool.query(`
      SELECT ai.id, ai.email, ai.exitoso, ai.motivo, ai.ip, ai.user_agent, ai.created_at,
             u.nombre AS usuario_nombre
        FROM auth_intentos ai
        LEFT JOIN global_usuarios u ON u.id = ai.usuario_id
      ${where}
      ORDER BY ai.created_at DESC
      LIMIT $${params.length}
    `, params);
    res.json(rows);
  } catch (err) { next(err); }
};

// POST /api/seguridad/usuarios/:id/forzar-logout
export const forzarLogout = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Fuente de verdad: sessions_valid_from en Postgres (funciona sin Redis)
    // +1 segundo para que floor(sessions_valid_from/1000) > iat del token actual,
    // incluso si login y forced-logout ocurren en el mismo segundo de reloj.
    await pool.query(
      `UPDATE global_usuarios SET sessions_valid_from = NOW() + INTERVAL '1 second' WHERE id = $1`,
      [id]
    );

    // Invalidar caché de uvf en Redis si está disponible
    if (redisClient) {
      await redisClient.del(`uvf:${id}`).catch(() => {});
      // También revocar sesiones del zset si existen
      const jtis = await redisClient.zrange(`sessions:${id}`, 0, -1).catch(() => []);
      for (const jti of jtis) {
        await redisClient.set(`jti:${jti}`, '1', 'EX', 8 * 3600).catch(() => {});
      }
      await redisClient.del(`sessions:${id}`).catch(() => {});
    }

    logger.info(`[SEGURIDAD] Logout forzado de usuario ${id} por admin ${req.user.id}`);
    res.json({ ok: true });
  } catch (err) { next(err); }
};
