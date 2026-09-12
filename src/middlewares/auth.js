import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { redisClient } from '../config/redis.js';
import pool from '../db/database.js';

// F-04: verifica JWT, blacklist jti y sessions_valid_from (forced-logout)
export const verifyToken = async (req, res, next) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (payload.tipo === 'asociado') return res.status(403).json({ error: 'Token no válido para este contexto' });

    // Blacklist por jti (logout individual)
    if (payload.jti && redisClient) {
      const revoked = await redisClient.get(`jti:${payload.jti}`).catch(() => null);
      if (revoked) return res.status(401).json({ error: 'Sesión cerrada. Inicia sesión de nuevo.' });
    }

    // sessions_valid_from: forced-logout global desde el panel de seguridad
    // Cache en Redis 60s para no golpear la DB en cada request
    let validFrom = null;
    const cacheKey = `uvf:${payload.id}`;
    if (redisClient) {
      validFrom = await redisClient.get(cacheKey).catch(() => null);
    }
    if (!validFrom) {
      const { rows } = await pool.query(
        `SELECT sessions_valid_from FROM global_usuarios WHERE id = $1`,
        [payload.id]
      );
      validFrom = rows[0]?.sessions_valid_from ?? null;
      if (validFrom && redisClient) {
        await redisClient.set(cacheKey, new Date(validFrom).toISOString(), 'EX', 60).catch(() => {});
      }
    }
    if (validFrom && payload.iat * 1000 < new Date(validFrom).getTime()) {
      return res.status(401).json({ error: 'Sesión revocada. Inicia sesión de nuevo.' });
    }

    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
};
