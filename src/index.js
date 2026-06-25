import { createApp } from './createApp.js';
import { env } from './config/env.js';
import logger from './config/logger.js';

const app = await createApp();

app.listen(env.PORT, () => {
  logger.info(`Servidor corriendo en puerto ${env.PORT} [${env.NODE_ENV}]`);
});

export default app;
