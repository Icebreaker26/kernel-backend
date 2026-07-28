import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export const verifyEmpresa = (req, res, next) => {
  const token = req.cookies?.token_empresa;
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    if (payload.tipo !== 'empresa') return res.status(403).json({ error: 'Acceso no permitido' });
    req.empresa = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
};
