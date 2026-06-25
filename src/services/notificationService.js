import pool from '../db/database.js';

let _io = null;

export const initNotificationService = (io) => {
  _io = io;
};

const emitir = (notif) => {
  if (!_io) return;
  if (notif.usuario_uuid)    _io.to(`user:${notif.usuario_uuid}`).emit('notificacion', notif);
  if (notif.asociado_codigo) _io.to(`asociado:${notif.asociado_codigo}`).emit('notificacion', notif);
};

// Notificar a un empleado específico
export const notificarUsuario = async (usuario_uuid, { tipo, mensaje, modulo }) => {
  const { rows: [notif] } = await pool.query(
    `INSERT INTO notificaciones (usuario_uuid, tipo, mensaje, modulo)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [usuario_uuid, tipo, mensaje, modulo]
  );
  emitir(notif);
  return notif;
};

// Notificar a un asociado específico
export const notificarAsociado = async (asociado_codigo, { tipo, mensaje, modulo }) => {
  const { rows: [notif] } = await pool.query(
    `INSERT INTO notificaciones (asociado_codigo, tipo, mensaje, modulo)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [asociado_codigo, tipo, mensaje, modulo]
  );
  emitir(notif);
  return notif;
};

// Notificar a todos los usuarios que tienen permiso READ sobre un módulo
export const notificarPorPermiso = async (modulo, { tipo, mensaje }) => {
  const { rows: usuarios } = await pool.query(
    `SELECT DISTINCT p.usuario_uuid
     FROM permisos p
     JOIN modulos m ON m.id = p.modulo_id
     JOIN acciones a ON a.id = p.accion_id
     WHERE m.nombre = $1 AND a.nombre = 'READ'
       AND EXISTS (
         SELECT 1 FROM global_usuarios u
         WHERE u.id = p.usuario_uuid AND u.is_active = true
       )`,
    [modulo]
  );

  for (const { usuario_uuid } of usuarios) {
    await notificarUsuario(usuario_uuid, { tipo, mensaje, modulo });
  }
};

// Notificar a todos los admins activos
export const notificarAdmins = async ({ tipo, mensaje, modulo }) => {
  const { rows } = await pool.query(
    `SELECT id FROM global_usuarios WHERE rol = 'admin' AND is_active = true`
  );
  for (const { id } of rows) {
    await notificarUsuario(id, { tipo, mensaje, modulo });
  }
};
