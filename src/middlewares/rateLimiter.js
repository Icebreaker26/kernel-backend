import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { redisClient } from '../config/redis.js';

const isTest = process.env.NODE_ENV === 'test';

// Crea un RedisStore si hay cliente disponible, si no usa MemoryStore por defecto
const makeStore = (prefix) => {
  if (!redisClient) return undefined;
  return new RedisStore({
    sendCommand: (command, ...args) => redisClient.call(command, ...args),
    prefix: `rl:${prefix}:`,
  });
};

// ── Global: todas las rutas de la API ─────────────────────────────────────
// 60 req/min por IP — primer escudo contra enjambres
export const globalLimiter = isTest
  ? (_req, _res, next) => next()
  : rateLimit({
      windowMs: 60 * 1000,
      max: 60,
      standardHeaders: true,
      legacyHeaders: false,
      store: makeStore('global'),
      handler: (_req, res) =>
        res.status(429).json({ error: 'Demasiadas solicitudes. Espera un momento e intenta de nuevo.' }),
    });

// ── Endpoints costosos: estadísticas, coincidencias ───────────────────────
// 5 req/min por usuario autenticado (clave: UUID del JWT — no falsificable)
// Aplicar DESPUÉS de verifyToken en las rutas que lo necesiten
export const costlyEndpointLimiter = isTest
  ? (_req, _res, next) => next()
  : rateLimit({
      windowMs: 60 * 1000,
      max: 5,
      standardHeaders: true,
      legacyHeaders: false,
      store: makeStore('costly'),
      keyGenerator: (req) => req.user?.id ?? req.ip,
      handler: (_req, res) =>
        res.status(429).json({ error: 'Límite de solicitudes para este endpoint. Intenta en un minuto.' }),
    });

// ── Login ─────────────────────────────────────────────────────────────────
export const loginRateLimiter = isTest
  ? (_req, _res, next) => next()
  : rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 10,
      standardHeaders: true,
      legacyHeaders: false,
      store: makeStore('login'),
      handler: (_req, res) =>
        res.status(429).json({ error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en 15 minutos.' }),
    });

// ── Portal / registro ─────────────────────────────────────────────────────
export const solicitarPortalLimiter = isTest
  ? (_req, _res, next) => next()
  : rateLimit({
      windowMs: 60 * 60 * 1000,
      max: 5,
      standardHeaders: true,
      legacyHeaders: false,
      store: makeStore('portal'),
      handler: (_req, res) =>
        res.status(429).json({ error: 'Demasiadas solicitudes. Intenta de nuevo en una hora.' }),
    });

export const registerLimiter = isTest
  ? (_req, _res, next) => next()
  : rateLimit({
      windowMs: 60 * 60 * 1000,
      max: 5,
      standardHeaders: true,
      legacyHeaders: false,
      store: makeStore('register'),
      handler: (_req, res) =>
        res.status(429).json({ error: 'Demasiados intentos. Intenta de nuevo en una hora.' }),
    });
