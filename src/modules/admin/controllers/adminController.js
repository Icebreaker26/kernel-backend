import bcrypt from 'bcrypt';
import pool from '../../../db/database.js';
import { crearUsuarioSchema, cambiarRolSchema, asignarPermisosSchema, resetearPasswordSchema } from '../schemas/adminSchema.js';
import { emitirAlertaSeguridad } from '../../../services/notificationService.js';

const logAdmin = (usuario_uuid, accion, objetivo_tipo, objetivo_id, objetivo_nombre, detalle = null) =>
  pool.query(
    `INSERT INTO admin_logs (usuario_uuid, accion, objetivo_tipo, objetivo_id, objetivo_nombre, detalle)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [usuario_uuid, accion, objetivo_tipo, objetivo_id, objetivo_nombre, detalle]
  ).catch(() => {});

export const crearUsuario = async (req, res, next) => {
  try {
    const { nombre, email, password, rol } = crearUsuarioSchema.parse(req.body);
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_approved, is_active)
       VALUES ($1, $2, $3, $4, true, true)
       RETURNING id, nombre, email, rol, is_active, is_approved, created_at`,
      [nombre, email, hash, rol]
    );
    await logAdmin(req.user.id, 'CREAR_USUARIO', 'usuario', rows[0].id, nombre);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya existe un usuario con ese email' });
    next(err);
  }
};

export const editarUsuario = async (req, res, next) => {
  try {
    const { nombre, email, rol } = req.body;
    if (!nombre && !email && !rol) return res.status(400).json({ error: 'Nada que actualizar' });

    // Verificar email duplicado si se cambia
    if (email) {
      const { rows: dup } = await pool.query(
        'SELECT id FROM global_usuarios WHERE email = $1 AND id != $2',
        [email, req.params.id]
      );
      if (dup.length) return res.status(409).json({ error: 'El email ya está en uso por otro usuario' });
    }

    const sets   = [];
    const values = [];
    let   n      = 1;
    if (nombre) { sets.push(`nombre = $${n++}`); values.push(nombre); }
    if (email)  { sets.push(`email  = $${n++}`); values.push(email); }
    if (rol)    { sets.push(`rol    = $${n++}`); values.push(rol); }
    sets.push(`updated_at = NOW()`);
    values.push(req.params.id);

    const { rows } = await pool.query(
      `UPDATE global_usuarios SET ${sets.join(', ')} WHERE id = $${n}
       RETURNING id, nombre, email, rol, is_active, is_approved`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    logAdmin(req.user.id, 'EDITAR_USUARIO', 'usuario', rows[0].id, rows[0].nombre,
      [nombre && `nombre:${nombre}`, email && `email:${email}`, rol && `rol:${rol}`].filter(Boolean).join(' | ')
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

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
      `SELECT al.*, u.nombre AS admin_nombre, u.email AS admin_email, u.avatar_url AS admin_avatar_url
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

// ── Centro de Control ─────────────────────────────────────────────────────────

export const resumenUsuarios = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        u.id, u.nombre, u.email, u.rol, u.avatar_url,
        u.is_active, u.is_approved, u.created_at, u.last_active_at,
        COALESCE((
          SELECT COUNT(*)::int FROM global_actividad a
          WHERE a.usuario_id = u.id AND a.created_at >= CURRENT_DATE
        ), 0) AS acciones_hoy,
        COALESCE((
          SELECT ROUND(SUM(a.duracion_ms)::numeric / 60000, 1)
          FROM global_actividad a
          WHERE a.usuario_id = u.id AND a.created_at >= CURRENT_DATE
            AND a.metodo <> 'SESSION'
        ), 0) AS minutos_hoy,
        (
          SELECT a.modulo FROM global_actividad a
          WHERE a.usuario_id = u.id
            AND a.created_at >= NOW() - INTERVAL '7 days'
            AND a.modulo <> 'auth'
          GROUP BY a.modulo ORDER BY COUNT(*) DESC LIMIT 1
        ) AS modulo_principal,
        COALESCE((
          SELECT COUNT(*)::int FROM global_actividad a
          WHERE a.usuario_id = u.id AND a.created_at >= NOW() - INTERVAL '7 days'
            AND a.metodo <> 'SESSION'
        ), 0) AS acciones_semana
      FROM global_usuarios u
      ORDER BY u.last_active_at DESC NULLS LAST
    `);
    res.json(rows);
  } catch (err) { next(err); }
};

export const actividadUsuario = async (req, res, next) => {
  try {
    const { id } = req.params;

    const [heatmap, sesiones, modulos, timeline] = await Promise.all([
      // Heatmap: 12 semanas × 7 días
      pool.query(`
        SELECT
          DATE(created_at AT TIME ZONE 'America/Bogota') AS dia,
          COUNT(*)::int AS acciones
        FROM global_actividad
        WHERE usuario_id = $1
          AND created_at >= NOW() - INTERVAL '84 days'
          AND metodo <> 'SESSION'
        GROUP BY dia ORDER BY dia
      `, [id]),

      // Últimos 20 logins
      pool.query(`
        SELECT created_at, ip
        FROM global_actividad
        WHERE usuario_id = $1 AND metodo = 'SESSION' AND endpoint = 'login'
        ORDER BY created_at DESC LIMIT 20
      `, [id]),

      // Módulos más usados (30 días)
      pool.query(`
        SELECT modulo, COUNT(*)::int AS total
        FROM global_actividad
        WHERE usuario_id = $1
          AND created_at >= NOW() - INTERVAL '30 days'
          AND modulo <> 'auth'
          AND metodo <> 'SESSION'
        GROUP BY modulo ORDER BY total DESC
      `, [id]),

      // Timeline últimas 50 acciones
      pool.query(`
        SELECT modulo, metodo, endpoint, status_code, duracion_ms, created_at
        FROM global_actividad
        WHERE usuario_id = $1 AND metodo <> 'SESSION'
        ORDER BY created_at DESC LIMIT 50
      `, [id]),
    ]);

    res.json({
      heatmap:  heatmap.rows,
      sesiones: sesiones.rows,
      modulos:  modulos.rows,
      timeline: timeline.rows,
    });
  } catch (err) { next(err); }
};

export const adopcionModulos = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        modulo,
        COUNT(DISTINCT usuario_id)::int            AS usuarios_activos,
        COUNT(*)::int                              AS acciones_semana,
        ROUND(COUNT(*)::numeric / 7, 1)            AS promedio_diario,
        COUNT(CASE WHEN status_code >= 400 THEN 1 END)::int AS errores,
        MAX(created_at)                            AS ultimo_uso
      FROM global_actividad
      WHERE created_at >= NOW() - INTERVAL '7 days'
        AND modulo NOT IN ('auth', 'public')
        AND metodo <> 'SESSION'
      GROUP BY modulo
      ORDER BY acciones_semana DESC
    `);
    res.json(rows);
  } catch (err) { next(err); }
};

export const alertasActividad = async (req, res, next) => {
  try {
    const [inactivos, zombies] = await Promise.all([
      pool.query(`
        SELECT u.id, u.nombre, u.email, u.rol, u.last_active_at,
          CASE WHEN u.last_active_at IS NULL THEN NULL
               ELSE ROUND(EXTRACT(EPOCH FROM (NOW() - u.last_active_at))/86400)::int
          END AS dias_inactivo
        FROM global_usuarios u
        WHERE u.is_active = true
          AND (u.last_active_at IS NULL OR u.last_active_at < NOW() - INTERVAL '15 days')
        ORDER BY u.last_active_at ASC NULLS FIRST
        LIMIT 20
      `),
      pool.query(`
        SELECT u.id, u.nombre, u.email, m.nombre AS modulo
        FROM permisos p
        JOIN modulos m ON m.id = p.modulo_id
        JOIN acciones a ON a.id = p.accion_id AND a.nombre = 'READ'
        JOIN global_usuarios u ON u.id = p.usuario_uuid AND u.is_active = true AND u.rol <> 'admin'
        WHERE NOT EXISTS (
          SELECT 1 FROM global_actividad ga
          WHERE ga.usuario_id = u.id
            AND ga.modulo = m.nombre
            AND ga.created_at >= NOW() - INTERVAL '60 days'
        )
        ORDER BY u.nombre, m.nombre
        LIMIT 50
      `),
    ]);

    res.json({
      inactivos: inactivos.rows,
      zombies:   zombies.rows,
    });
  } catch (err) { next(err); }
};

export const togglePermiso = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { modulo, accion } = req.body;
    if (!modulo || !accion) return res.status(400).json({ error: 'modulo y accion son requeridos' });

    const { rows: [mod] } = await pool.query(`SELECT id FROM modulos WHERE nombre = $1`, [modulo]);
    const { rows: [acc] } = await pool.query(`SELECT id FROM acciones WHERE nombre = $1`, [accion]);
    if (!mod || !acc) return res.status(404).json({ error: 'Módulo o acción no encontrado' });

    const { rows: existing } = await pool.query(
      `SELECT id FROM permisos WHERE usuario_uuid = $1 AND modulo_id = $2 AND accion_id = $3`,
      [id, mod.id, acc.id]
    );

    if (existing.length) {
      await pool.query(
        `DELETE FROM permisos WHERE usuario_uuid = $1 AND modulo_id = $2 AND accion_id = $3`,
        [id, mod.id, acc.id]
      );
      await logAdmin(req.user.id, 'QUITAR_PERMISO', 'usuario', id, id, `${modulo}:${accion}`);
      res.json({ activo: false });
    } else {
      await pool.query(
        `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [id, mod.id, acc.id]
      );
      await logAdmin(req.user.id, 'DAR_PERMISO', 'usuario', id, id, `${modulo}:${accion}`);

      // Regla 4 — alerta inmediata si el actor se otorga permisos a sí mismo
      if (req.user.id === id) {
        const alertaAutootorgamiento = {
          regla: 'auto_permiso', tipo: 'Auto-otorgamiento de permiso',
          severidad: 'critica', titulo: `Un usuario se otorgó permisos a sí mismo: ${modulo}:${accion}`,
          usuario_uuid: id, entidad_tipo: 'usuario', entidad_id: id,
        };
        pool.query(
          `INSERT INTO security_alerts (regla,tipo,severidad,usuario_uuid,dedupe_key,titulo,detalle,entidad_tipo,entidad_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (dedupe_key) DO UPDATE SET ocurrencias=security_alerts.ocurrencias+1, ultima_vez_at=NOW()`,
          ['auto_permiso','Auto-otorgamiento de permiso','critica', id,
           `auto_permiso:${id}:${modulo}:${accion}`,
           alertaAutootorgamiento.titulo,
           JSON.stringify({ modulo, accion, actor: req.user.id }), 'usuario', id]
        ).catch(() => {});
        emitirAlertaSeguridad(alertaAutootorgamiento);
      }

      res.json({ activo: true });
    }
  } catch (err) { next(err); }
};
