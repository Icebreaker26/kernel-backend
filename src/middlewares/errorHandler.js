import { ZodError } from 'zod';
import multer from 'multer';
import logger from '../config/logger.js';

export const errorHandler = (err, req, res, next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Datos inválidos', detalles: err.flatten() });
  }

  // Transacción bancaria duplicada (unique index compuesto: cuenta + referencia + fecha + monto)
  if (err.code === '23505' && (err.constraint?.includes('ref_fecha_monto') || err.constraint?.includes('ref_bancaria'))) {
    const match = (err.detail || '').match(/\(referencia_bancaria\)=\((.+?)\)/);
    return res.status(409).json({
      error: 'Transacción duplicada',
      referencia: match?.[1] ?? 'desconocida',
      message: 'Esta transacción ya fue importada anteriormente.',
    });
  }

  // Error general de unique constraint
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Registro duplicado', detalle: err.detail || '' });
  }

  // Archivo inválido o demasiado grande (multer)
  if (err instanceof multer.MulterError || err.message?.includes('.xls')) {
    return res.status(400).json({ error: err.message });
  }

  logger.error(`${req.path} — ${err.message}`, { stack: err.stack });
  const isProd = process.env.NODE_ENV === 'production';
  res.status(err.status || 500).json({
    error: isProd ? 'Error interno del servidor' : (err.message || 'Error interno del servidor'),
  });
};
