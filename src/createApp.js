import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { readdir } from 'fs/promises';
import { pathToFileURL } from 'url';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { env } from './config/env.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { logActividad } from './middlewares/logActividad.js';
import { globalLimiter } from './middlewares/rateLimiter.js';
import logger from './config/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const createApp = async () => {
  const app = express();
  // F-03: solo confiar en el proxy en producción (nginx); en dev evita IP spoofing vía X-Forwarded-For
  app.set('trust proxy', env.NODE_ENV === 'production' ? 1 : false);

  app.use(helmet());
  const allowedOrigins = [env.FRONTEND_URL, env.PORTAL_URL].filter(Boolean);
  app.use(cors({ origin: allowedOrigins, credentials: true }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(globalLimiter);

  // F-05: CSRF — exigir header X-Requested-With en mutaciones (POST/PUT/PATCH/DELETE)
  // Los ataques CSRF desde otros orígenes no pueden enviar headers custom
  app.use((req, res, next) => {
    const safe = ['GET', 'HEAD', 'OPTIONS'];
    if (safe.includes(req.method)) return next();
    // El endpoint de presigned upload solo muta metadata vía API (no CSRF relevante por S3)
    if (req.headers['x-requested-with'] === 'XMLHttpRequest') return next();
    // Permitir peticiones internas (tests, cron)
    if (env.NODE_ENV === 'test') return next();
    return res.status(403).json({ error: 'Petición no permitida: falta el header X-Requested-With' });
  });

  app.use(logActividad);

  const modulesPath   = join(__dirname, 'modules');
  const moduleFolders = await readdir(modulesPath).catch(() => []);

  for (const folder of moduleFolders) {
    const routeFile = join(modulesPath, folder, 'routes', `${folder}Routes.js`);
    try {
      const { default: router } = await import(pathToFileURL(routeFile).href);
      app.use(`/api/${folder}`, router);
      logger.debug(`Módulo cargado: /api/${folder}`);
    } catch {
      // módulo sin routes — se ignora
    }
  }

  app.use(errorHandler);
  return app;
};
