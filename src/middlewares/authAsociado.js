import jwt from 'jsonwebtoken';
import pool from '../db/database.js';
import { env } from '../config/env.js';
import { redisClient } from '../config/redis.js';

export const verifyAsociado = async (req, res, next) => {
  const token = req.cookies?.token_asociado;
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (payload.tipo !== 'asociado') return res.status(403).json({ error: 'Acceso no permitido' });

    // Verifica portal activo + sessions_valid_from (revocación por resetPassword o desactivación)
    // Cache en Redis 60s para no golpear la DB en cada request
    let validFrom = null;
    let portalActivo = true;
    const cacheKey = `uvf_a:${payload.id}`;

    if (redisClient) {
      const cached = await redisClient.get(cacheKey).catch(() => null);
      if (cached) {
        const parsed = JSON.parse(cached);
        validFrom = parsed.validFrom;
        portalActivo = parsed.portalActivo;
      }
    }

    if (validFrom === null && portalActivo === true) {
      const { rows } = await pool.query(
        `SELECT portal_activo, is_active, sessions_valid_from
           FROM asociados WHERE codigo = $1`,
        [payload.id]
      );
      if (!rows.length || !rows[0].is_active || !rows[0].portal_activo) {
        return res.status(401).json({ error: 'Sesión revocada. Inicia sesión de nuevo.' });
      }
      validFrom = rows[0].sessions_valid_from ?? null;
      portalActivo = rows[0].portal_activo;
      if (redisClient) {
        await redisClient.set(
          cacheKey,
          JSON.stringify({ validFrom: validFrom ? new Date(validFrom).toISOString() : null, portalActivo }),
          'EX', 60
        ).catch(() => {});
      }
    }

    if (validFrom && payload.iat < Math.floor(new Date(validFrom).getTime() / 1000)) {
      return res.status(401).json({ error: 'Sesión revocada. Inicia sesión de nuevo.' });
    }

    req.asociado = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
};
