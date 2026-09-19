import jwt from 'jsonwebtoken';
import pool from '../db/database.js';
import { env } from '../config/env.js';
import { redisClient } from '../config/redis.js';

export const verifyEmpresa = async (req, res, next) => {
  const token = req.cookies?.token_empresa;
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (payload.tipo !== 'empresa') return res.status(403).json({ error: 'Acceso no permitido' });

    // Verifica portal activo + sessions_valid_from por email del acceso
    const cacheKey = `uvf_e:${payload.email}`;
    let validFrom = null;
    let portalActivo = true;

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
        `SELECT portal_activo, sessions_valid_from
           FROM empresas_portal_acceso WHERE email = $1`,
        [payload.email]
      );
      if (!rows.length || !rows[0].portal_activo) {
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

    req.empresa = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
};
