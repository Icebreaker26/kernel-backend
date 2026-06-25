import bcrypt from 'bcrypt';
import pool from '../../../db/database.js';
import { cambiarRolSchema, asignarPermisosSchema, resetearPasswordSchema } from '../schemas/adminSchema.js';

const logAdmin = (usuario_uuid, accion, objetivo_tipo, objetivo_id, objetivo_nombre, detalle = null) =>
  pool.query(
    `INSERT INTO admin_logs (usuario_uuid, accion, objetivo_tipo, objetivo_id, objetivo_nombre, detalle)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [usuario_uuid, accion, objetivo_tipo, objetivo_id, objetivo_nombre, detalle]
  ).catch(() => {});

export const listarUsuarios = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, email, rol, is_active, is_approved, created_at
       FROM global_usuarios
       ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

export const aprobarUsuario = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE global_usuarios SET is_approved = true WHERE id = $1 RETURNING id, nombre, email`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    logAdmin(req.user.id, 'APROBAR_USUARIO', 'usuario', rows[0].id, rows[0].nombre);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

export const desactivarUsuario = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE global_usuarios SET is_active = false WHERE id = $1 RETURNING id, nombre, email`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    logAdmin(req.user.id, 'DESACTIVAR_USUARIO', 'usuario', rows[0].id, rows[0].nombre);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

export const reactivarUsuario = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE global_usuarios SET is_active = true WHERE id = $1 RETURNING id, nombre, email`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    logAdmin(req.user.id, 'REACTIVAR_USUARIO', 'usuario', rows[0].id, rows[0].nombre);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

export const cambiarRol = async (req, res, next) => {
  try {
    const { rol } = cambiarRolSchema.parse(req.body);
    const { rows } = await pool.query(
      `UPDATE global_usuarios SET rol = $1 WHERE id = $2 RETURNING id, nombre, email, rol`,
      [rol, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    logAdmin(req.user.id, 'CAMBIAR_ROL', 'usuario', rows[0].id, rows[0].nombre, `Nuevo rol: ${rows[0].rol}`);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

export const asignarPermisosmasivo = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { usuario_uuid, permisos } = asignarPermisosSchema.parse(req.body);

    await client.query('BEGIN');

    // Limpiar permisos actuales del usuario
    await client.query('DELETE FROM permisos WHERE usuario_uuid = $1', [usuario_uuid]);

    for (const { modulo, acciones } of permisos) {
      const { rows: [mod] } = await client.query(
        'SELECT id FROM modulos WHERE nombre = $1', [modulo]
      );
      if (!mod) continue;

      for (const accion of acciones) {
        const { rows: [acc] } = await client.query(
          'SELECT id FROM acciones WHERE nombre = $1', [accion]
        );
        if (!acc) continue;

        await client.query(
          `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [usuario_uuid, mod.id, acc.id]
        );
      }
    }

    await client.query('COMMIT');
    const { rows: [u] } = await pool.query('SELECT nombre FROM global_usuarios WHERE id = $1', [usuario_uuid]);
    logAdmin(req.user.id, 'ASIGNAR_PERMISOS', 'usuario', usuario_uuid, u?.nombre ?? usuario_uuid);
    res.json({ message: 'Permisos asignados correctamente' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

export const listarPermisosUsuario = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.nombre AS modulo, a.nombre AS accion
       FROM permisos p
       JOIN modulos m ON m.id = p.modulo_id
       JOIN acciones a ON a.id = p.accion_id
       WHERE p.usuario_uuid = $1
       ORDER BY m.nombre, a.nombre`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

export const resetearPassword = async (req, res, next) => {
  try {
    const { nueva_password } = resetearPasswordSchema.parse(req.body);
    const hash = await bcrypt.hash(nueva_password, 10);
    const { rows } = await pool.query(
      `UPDATE global_usuarios SET password_hash = $1 WHERE id = $2 RETURNING id, nombre, email`,
      [hash, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    logAdmin(req.user.id, 'RESET_PASSWORD', 'usuario', rows[0].id, rows[0].nombre);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

export const resetearPasswordAsociado = async (req, res, next) => {
  try {
    const { nueva_password } = resetearPasswordSchema.parse(req.body);
    const hash = await bcrypt.hash(nueva_password, 10);
    const { rows } = await pool.query(
      `UPDATE asociados SET password_hash = $1 WHERE codigo = $2 RETURNING codigo, nombre, apellido`,
      [hash, req.params.codigo]
    );
    if (!rows.length) return res.status(404).json({ error: 'Asociado no encontrado' });
    logAdmin(req.user.id, 'RESET_PASSWORD', 'asociado', rows[0].codigo, `${rows[0].nombre} ${rows[0].apellido}`);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

export const listarAdminLogs = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT al.*, u.nombre AS admin_nombre, u.email AS admin_email
       FROM admin_logs al
       JOIN global_usuarios u ON u.id = al.usuario_uuid
       ORDER BY al.created_at DESC
       LIMIT 200`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

export const listarModulos = async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT nombre, descripcion FROM modulos ORDER BY nombre');
    res.json(rows);
  } catch (err) {
    next(err);
  }
};
