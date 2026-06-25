import { createServer } from 'http';
import { Server } from 'socket.io';
import { parse as parseCookie } from 'cookie';
import jwt from 'jsonwebtoken';
import { createApp } from './createApp.js';
import { env } from './config/env.js';
import { initNotificationService } from './services/notificationService.js';
import logger from './config/logger.js';

const app        = await createApp();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: env.FRONTEND_URL, credentials: true },
});

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

httpServer.listen(env.PORT, () => {
  logger.info(`Servidor corriendo en puerto ${env.PORT} [${env.NODE_ENV}]`);
});

export default app;
