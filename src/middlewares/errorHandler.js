import { ZodError } from 'zod';
import logger from '../config/logger.js';

export const errorHandler = (err, req, res, next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Datos inválidos', detalles: err.flatten() });
  }

  logger.error({ message: err.message, stack: err.stack, path: req.path });
  res.status(err.status || 500).json({ error: err.message || 'Error interno del servidor' });
};
