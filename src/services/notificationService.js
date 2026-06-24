let _io = null;

export const initNotificationService = (io) => {
  _io = io;
};

export const emitirNotificacion = ({ usuario_uuid, tipo, mensaje, modulo }) => {
  if (!_io) return;
  _io.to(usuario_uuid).emit('notificacion', { tipo, mensaje, modulo, fecha: new Date() });
};
