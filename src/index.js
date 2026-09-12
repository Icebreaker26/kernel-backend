import { createServer } from 'http';
import { Server } from 'socket.io';
import { parse as parseCookie } from 'cookie';
import jwt from 'jsonwebtoken';
import { createApp } from './createApp.js';
import { env } from './config/env.js';
import { initNotificationService } from './services/notificationService.js';
import { startScheduler, startSchedulerTesoreria, startAnomalyDetector } from './services/scheduler.js';
import { startDispatcher } from './services/mailingDispatcher.js';
import logger from './config/logger.js';
import pool from './db/database.js';

const app        = await createApp();
const httpServer = createServer(app);

const allowedOrigins = [env.FRONTEND_URL, env.PORTAL_URL].filter(Boolean);
const io = new Server(httpServer, {
  cors: { origin: allowedOrigins, credentials: true },
});

// F-07: rate limiting de conexiones Socket.io por IP — máx 20 conexiones/min
const socketConnections = new Map();
io.use((socket, next) => {
  const ip = socket.handshake.address;
  const now = Date.now();
  const entry = socketConnections.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 60_000; }
  entry.count++;
  socketConnections.set(ip, entry);
  if (entry.count > 20) return next(new Error('Demasiadas conexiones. Intenta más tarde.'));
  next();
});

// Limpiar entradas expiradas del mapa cada 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of socketConnections) {
    if (now > entry.resetAt) socketConnections.delete(ip);
  }
}, 5 * 60_000);

// Autenticar socket por cookie JWT
io.use((socket, next) => {
  try {
    const cookies = parseCookie(socket.handshake.headers.cookie || '');
    const token   = cookies.token || cookies.token_asociado;
    if (!token) return next(new Error('No autenticado'));

    const payload = jwt.verify(token, env.JWT_SECRET);
    socket.data.payload = payload;
    socket.data.tipo    = cookies.token ? 'usuario' : 'asociado';
    next();
  } catch {
    next(new Error('Token inválido'));
  }
});

io.on('connection', (socket) => {
  const { payload, tipo } = socket.data;
  if (tipo === 'usuario') {
    socket.join(`user:${payload.id}`);
    if (payload.rol === 'admin') socket.join('role:admin');
  } else {
    socket.join(`asociado:${payload.id}`);
  }
});

initNotificationService(io);
startScheduler();
startSchedulerTesoreria();
startAnomalyDetector();
startDispatcher();

// F-09: retención de actividad extendida a 5 años (1825 días) para auditoría
const purgarActividad = () => {
  pool.query(`DELETE FROM global_actividad WHERE created_at < NOW() - INTERVAL '1825 days'`)
    .then(({ rowCount }) => { if (rowCount > 0) logger.info(`Purga actividad: ${rowCount} registros eliminados`); })
    .catch((err) => logger.error('Error purga actividad', err));
  // auth_intentos: retención 90 días (datos más sensibles, ventana más corta)
  pool.query(`DELETE FROM auth_intentos WHERE created_at < NOW() - INTERVAL '90 days'`)
    .catch((err) => logger.error('Error purga auth_intentos', err));
};
purgarActividad();
setInterval(purgarActividad, 7 * 24 * 60 * 60 * 1000);

httpServer.listen(env.PORT, () => {
  logger.info(`Servidor corriendo en puerto ${env.PORT} [${env.NODE_ENV}]`);
});

export default app;
