import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { parse } from 'csv-parse/sync';
import pool from '../../../db/database.js';
import { env } from '../../../config/env.js';
import { loginAsociadoSchema, importarFilaSchema } from '../schemas/asociadosSchema.js';
import { notificarUsuario } from '../../../services/notificationService.js';

// Genera una contraseña legible sin caracteres ambiguos (0/O, 1/l/I)
const generarPassword = () => {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

// ── Portal: auth ──────────────────────────────────────────────────────────────

export const loginAsociado = async (req, res, next) => {
  try {
    const { codigo, password } = loginAsociadoSchema.parse(req.body);

    const { rows } = await pool.query(
      `SELECT codigo, nombre, apellido, password_hash, portal_activo, primer_login
       FROM asociados WHERE codigo = $1 AND is_active = true`,
      [codigo]
    );

    const asociado = rows[0];

    // Mismo mensaje para usuario no encontrado y contraseña incorrecta — no revelar si existe
    if (!asociado || !asociado.password_hash || !(await bcrypt.compare(password, asociado.password_hash))) {
      return res.status(401).json({ error: 'Código o contraseña incorrectos' });
    }

    if (!asociado.portal_activo) {
      return res.status(403).json({ error: 'Tu acceso al portal no está activado. Contacta a la cooperativa.' });
    }

    const token = jwt.sign(
      { id: asociado.codigo, nombre: asociado.nombre, tipo: 'asociado', primer_login: asociado.primer_login },
      env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.cookie('token_asociado', token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
    });

    res.json({
      codigo:       asociado.codigo,
      nombre:       asociado.nombre,
      apellido:     asociado.apellido,
      primer_login: asociado.primer_login,
    });
  } catch (err) {
    next(err);
  }
};

export const logoutAsociado = (_req, res) => {
  res.clearCookie('token_asociado');
  res.json({ message: 'Sesión cerrada' });
};

export const meAsociado = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT codigo, nombre, apellido, direccion, movil,
              clase_cuota, empresa_dsto, nombre_empresa, ciudad, primer_login
       FROM asociados WHERE codigo = $1`,
      [req.asociado.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Asociado no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

export const cambiarPasswordAsociado = async (req, res, next) => {
  try {
    const { password_actual, password_nueva } = req.body;
    if (!password_actual || !password_nueva || password_nueva.length < 8) {
      return res.status(400).json({ error: 'Datos inválidos' });
    }

    const { rows } = await pool.query(
      'SELECT password_hash FROM asociados WHERE codigo = $1',
      [req.asociado.id]
    );
    const valida = await bcrypt.compare(password_actual, rows[0].password_hash);
    if (!valida) return res.status(401).json({ error: 'Contraseña actual incorrecta' });

    const hash = await bcrypt.hash(password_nueva, 10);
    await pool.query(
      'UPDATE asociados SET password_hash = $1, primer_login = false, updated_at = NOW() WHERE codigo = $2',
      [hash, req.asociado.id]
    );
    res.json({ message: 'Contraseña actualizada' });
  } catch (err) {
    next(err);
  }
};

// ── Admin: activación del portal ──────────────────────────────────────────────

export const activarPortal = async (req, res, next) => {
  try {
    const { codigo } = req.params;

    const { rows } = await pool.query(
      'SELECT codigo, nombre, apellido FROM asociados WHERE codigo = $1 AND is_active = true',
      [codigo]
    );
    if (!rows.length) return res.status(404).json({ error: 'Asociado no encontrado' });

    const password = generarPassword();
    const hash     = await bcrypt.hash(password, 10);

    await pool.query(
      `UPDATE asociados
       SET password_hash = $1, portal_activo = true, primer_login = true, updated_at = NOW()
       WHERE codigo = $2`,
      [hash, codigo]
    );

    res.json({
      password,
      nombre:  rows[0].nombre,
      apellido: rows[0].apellido,
      mensaje: 'Portal activado. Entrega esta contraseña al asociado. No se volverá a mostrar.',
    });
  } catch (err) {
    next(err);
  }
};

export const desactivarPortal = async (req, res, next) => {
  try {
    const { codigo } = req.params;
    await pool.query(
      `UPDATE asociados
       SET password_hash = NULL, portal_activo = false, primer_login = false, updated_at = NOW()
       WHERE codigo = $1`,
      [codigo]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

// ── Admin: importar CSV ───────────────────────────────────────────────────────

export const importarCSV = async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!req.file) return res.status(400).json({ error: 'No se adjuntó ningún archivo' });

    const registros = parse(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const errores = [];
    const validos = [];

    for (const fila of registros) {
      const result = importarFilaSchema.safeParse(fila);
      if (!result.success) {
        errores.push({ fila: fila.codigo ?? '?', error: result.error.flatten() });
      } else {
        validos.push(result.data);
      }
    }

    const INSERT_BATCH = 200;
    const codigosCSV   = validos.map((d) => d.codigo);

    await client.query('BEGIN');

    let nuevos      = 0;
    let actualizados = 0;

    for (let i = 0; i < validos.length; i += INSERT_BATCH) {
      const lote   = validos.slice(i, i + INSERT_BATCH);
      const params = [];
      // 9 campos por fila — password_hash, portal_activo y primer_login no se pasan como param
      const values = lote.map((d, j) => {
        const base = j * 9;
        params.push(d.codigo, d.apellido, d.nombre, d.direccion, d.movil,
                    d.clase_cuota, d.empresa_dsto, d.nombre_empresa, d.ciudad);
        return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},NULL,false,false,now())`;
      }).join(',');

      const { rows } = await client.query(
        `INSERT INTO asociados
           (codigo, apellido, nombre, direccion, movil, clase_cuota, empresa_dsto, nombre_empresa, ciudad,
            password_hash, portal_activo, primer_login, fecha_ingreso)
         VALUES ${values}
         ON CONFLICT (codigo) DO UPDATE SET
           apellido       = EXCLUDED.apellido,
           nombre         = EXCLUDED.nombre,
           direccion      = EXCLUDED.direccion,
           movil          = EXCLUDED.movil,
           clase_cuota    = EXCLUDED.clase_cuota,
           empresa_dsto   = EXCLUDED.empresa_dsto,
           nombre_empresa = EXCLUDED.nombre_empresa,
           ciudad         = EXCLUDED.ciudad,
           is_active      = true,
           fecha_retiro   = NULL,
           fecha_ingreso  = CASE WHEN asociados.is_active = false THEN now() ELSE asociados.fecha_ingreso END,
           updated_at     = now()
         RETURNING (xmax = 0) AS es_nuevo`,
        params
      );

      rows.forEach((r) => r.es_nuevo ? nuevos++ : actualizados++);
    }

    // Retirar asociados que ya no están en el CSV
    const { rowCount: retirados } = await client.query(
      `UPDATE asociados SET is_active = false, fecha_retiro = now(), updated_at = now()
       WHERE codigo != ALL($1) AND is_active = true`,
      [codigosCSV]
    );

    // Sincronizar empresas
    const empresasMap = new Map();
    for (const d of validos) {
      if (d.empresa_dsto) empresasMap.set(d.empresa_dsto, d.nombre_empresa || d.empresa_dsto);
    }
    const empresas       = [...empresasMap.entries()];
    const codigosEmpresa = empresas.map(([c]) => c);

    if (empresas.length > 0) {
      const EMP_BATCH = 200;
      for (let i = 0; i < empresas.length; i += EMP_BATCH) {
        const lote   = empresas.slice(i, i + EMP_BATCH);
        const params = [];
        const values = lote.map(([codigo, nombre], j) => {
          params.push(codigo, nombre);
          return `($${j*2+1}, $${j*2+2}, now())`;
        }).join(',');

        await client.query(
          `INSERT INTO empresas (codigo, nombre, fecha_ingreso)
           VALUES ${values}
           ON CONFLICT (codigo) DO UPDATE SET
             nombre        = EXCLUDED.nombre,
             is_active     = true,
             fecha_retiro  = NULL,
             fecha_ingreso = CASE WHEN empresas.is_active = false THEN now() ELSE empresas.fecha_ingreso END,
             updated_at    = now()`,
          params
        );
      }

      await client.query(
        `UPDATE empresas SET is_active = false, fecha_retiro = now(), updated_at = now()
         WHERE codigo != ALL($1) AND is_active = true`,
        [codigosEmpresa]
      );
    }

    // Auditoría
    await client.query(
      `INSERT INTO sincronizaciones (usuario_uuid, archivo, total, nuevos, actualizados, retirados, errores)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.user.id, req.file.originalname, registros.length, nuevos, actualizados, retirados, errores.length]
    );

    await client.query('COMMIT');

    notificarUsuario(req.user.id, {
      tipo: 'sincronizacion_completada',
      mensaje: `Importación completada: ${nuevos} nuevos, ${actualizados} actualizados, ${retirados} retirados`,
      modulo: 'asociados',
    }).catch(() => {});

    res.json({ nuevos, actualizados, retirados, errores, total: registros.length });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

export const historialSincronizaciones = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.archivo, s.total, s.nuevos, s.actualizados, s.retirados, s.errores, s.created_at,
              u.nombre AS usuario, u.email AS usuario_email
       FROM sincronizaciones s
       JOIN global_usuarios u ON u.id = s.usuario_uuid
       ORDER BY s.created_at DESC
       LIMIT 100`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

export const listarAsociados = async (req, res, next) => {
  try {
    const { q } = req.query;
    let rows;
    if (q && q.trim()) {
      const term = `%${q.trim().toLowerCase()}%`;
      ({ rows } = await pool.query(
        `SELECT codigo, nombre, apellido, movil, clase_cuota, nombre_empresa, ciudad, is_active, portal_activo, primer_login
         FROM asociados
         WHERE LOWER(codigo) LIKE $1 OR LOWER(nombre) LIKE $1 OR LOWER(apellido) LIKE $1
            OR LOWER(nombre || ' ' || apellido) LIKE $1
         ORDER BY apellido, nombre
         LIMIT 20`,
        [term]
      ));
    } else {
      ({ rows } = await pool.query(
        `SELECT codigo, nombre, apellido, movil, clase_cuota, nombre_empresa, ciudad, is_active, portal_activo, primer_login
         FROM asociados ORDER BY apellido, nombre`
      ));
    }
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

export const listarNotificaciones = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM notificaciones
       WHERE asociado_codigo = $1
       ORDER BY created_at DESC LIMIT 50`,
      [req.asociado.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};

export const marcarNotifLeida = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE notificaciones SET leida = true
       WHERE id = $1 AND asociado_codigo = $2 RETURNING id`,
      [req.params.id, req.asociado.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Notificación no encontrada' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

export const marcarTodasNotifsLeidas = async (req, res, next) => {
  try {
    await pool.query(
      `UPDATE notificaciones SET leida = true
       WHERE asociado_codigo = $1 AND leida = false`,
      [req.asociado.id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};
