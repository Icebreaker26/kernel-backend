import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { readdir } from 'fs/promises';
import { pathToFileURL } from 'url';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { env } from './config/env.js';
import { errorHandler } from './middlewares/errorHandler.js';
import logger from './config/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const createApp = async () => {
  const app = express();

  app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());

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
