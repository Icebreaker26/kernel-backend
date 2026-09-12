import Redis from 'ioredis';
import { env } from './env.js';
import logger from './logger.js';

let redisClient = null;

if (env.REDIS_URL) {
  redisClient = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    lazyConnect: true,
  });

  redisClient.on('connect', () => logger.info('Redis conectado'));
  redisClient.on('error',   (err) => logger.error(`Redis error: ${err.message}`));
} else {
  logger.warn(
    '[SEGURIDAD] REDIS_URL no configurado — rate limiters usan MemoryStore. ' +
    'En producción esto permite bypass del rate limit tras reinicios. ' +
    'Configura REDIS_URL para protección completa.'
  );
}

export { redisClient };
