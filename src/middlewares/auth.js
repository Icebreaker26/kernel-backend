import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { redisClient } from '../config/redis.js';

// F-04: verifica JWT y comprueba blacklist de jti en Redis (tokens revocados al logout)
export const verifyToken = async (req, res, next) => {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (payload.tipo === 'asociado') return res.status(403).json({ error: 'Token no válido para este contexto' });

    if (payload.jti && redisClient) {
      const revoked = await redisClient.get(`jti:${payload.jti}`).catch(() => null);
      if (revoked) return res.status(401).json({ error: 'Sesión cerrada. Inicia sesión de nuevo.' });
    }

    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
};
