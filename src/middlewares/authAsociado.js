import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const verifyAsociado = (req, res, next) => {
  const token = req.cookies?.token_asociado;
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (payload.tipo !== 'asociado') return res.status(403).json({ error: 'Acceso no permitido' });
    req.asociado = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
};
