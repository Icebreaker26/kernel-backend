import rateLimit from 'express-rate-limit';

const isTest = process.env.NODE_ENV === 'test';

export const loginRateLimiter = isTest
  ? (_req, _res, next) => next()
  : rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).json({
          error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.',
        });
      },
    });
