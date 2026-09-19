import { createHash } from 'crypto';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
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
      keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req),
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

// ── Captación pública: por token (no por IP — varios prospectos comparten red de empresa) ──
export const captacionPublicLimiter = isTest
  ? (_req, _res, next) => next()
  : rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 60,
      standardHeaders: true,
      legacyHeaders: false,
      store: makeStore('captacion_pub'),
      keyGenerator: (req) => {
        const token = req.params?.token;
        return token
          ? createHash('sha256').update(token).digest('hex')
          : ipKeyGenerator(req);
      },
      handler: (_req, res) =>
        res.status(429).json({ error: 'Demasiadas solicitudes para este formulario. Intenta en 15 minutos.' }),
    });

// ── Enlace público de presentación: crear prospectos desde un grupo ────────
// Por IP. Es amplio (40 cada 15 min) porque los empleados de una misma empresa comparten IP,
// pero frena a quien intente inundar de prospectos el enlace que se compartió en un grupo.
export const enlacePublicoLimiter = isTest
  ? (_req, _res, next) => next()
  : rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 40,
      standardHeaders: true,
      legacyHeaders: false,
      store: makeStore('captacion_enlace'),
      keyGenerator: (req) => ipKeyGenerator(req),
      handler: (_req, res) =>
        res.status(429).json({ error: 'Demasiados intentos desde esta conexión. Inténtalo de nuevo en unos minutos.' }),
    });

// ── Páginas públicas del sitio (transparencia, etc.): por IP, amplio porque es lectura ──
export const paginaPublicaLimiter = isTest
  ? (_req, _res, next) => next()
  : rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 200,
      standardHeaders: true,
      legacyHeaders: false,
      store: makeStore('pagina_publica'),
      keyGenerator: (req) => ipKeyGenerator(req),
      handler: (_req, res) =>
        res.status(429).json({ error: 'Demasiadas solicitudes. Inténtalo de nuevo en unos minutos.' }),
    });

// ── Baja de avisos por enlace (público): por IP ─────────────────────────────
export const bajaLimiter = isTest
  ? (_req, _res, next) => next()
  : rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 30,
      standardHeaders: true,
      legacyHeaders: false,
      store: makeStore('email_baja'),
      keyGenerator: (req) => ipKeyGenerator(req),
      handler: (_req, res) =>
        res.status(429).json({ error: 'Demasiados intentos. Inténtalo de nuevo en unos minutos.' }),
    });
