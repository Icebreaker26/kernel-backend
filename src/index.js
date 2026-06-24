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

const app = express();

app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// Loader dinámico de módulos
const modulesPath = join(__dirname, 'modules');
const moduleFolders = await readdir(modulesPath).catch(() => []);

for (const folder of moduleFolders) {
  const routesDir = join(modulesPath, folder, 'routes');
  const routeFile = join(routesDir, `${folder}Routes.js`);
  try {
    const { default: router } = await import(pathToFileURL(routeFile).href);
    app.use(`/api/${folder}`, router);
    logger.info(`Módulo cargado: /api/${folder}`);
  } catch {
    // archivo no existe — se ignora
  }
}

app.use(errorHandler);

app.listen(env.PORT, () => {
  logger.info(`Servidor corriendo en puerto ${env.PORT} [${env.NODE_ENV}]`);
});

export default app;
