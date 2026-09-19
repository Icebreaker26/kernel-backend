import crypto from 'crypto';
import pool from '../../../db/database.js';
import logger from '../../../config/logger.js';
import { notificarPorPermiso } from '../../../services/notificationService.js';
import { enviarConfirmacionPqrs, enviarRespuestaPqrs } from '../../../services/emailService.js';
import {
  TIPOS, VERSION_HABEAS_DATA, crearPqrsSchema, consultaSchema, estadoSchema, asignarSchema, responderSchema, notaSchema,
} from '../schemas/pqrsSchema.js';

// Plazo para responder, en días hábiles (lunes a viernes). Es una estimación: no descuenta festivos.
// Confirmar con Control Interno el plazo que corresponde a cada tipo de solicitud.
const PLAZO_DIAS_HABILES = 15;

const sumarDiasHabiles = (desde, dias) => {
  const f = new Date(desde);
  let n = 0;
  while (n < dias) {
    f.setDate(f.getDate() + 1);
    if (f.getDay() !== 0 && f.getDay() !== 6) n += 1;
  }
  return f;
};
const isoFecha = (f) => f.toISOString().slice(0, 10);

const hashCodigo = (c) => crypto.createHash('sha256').update(String(c)).digest('hex');
// Sin caracteres ambiguos (0/O, 1/I): el código se lee y se escribe a mano
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const generarCodigo = () => Array.from({ length: 8 }, () => ALFABETO[crypto.randomInt(ALFABETO.length)]).join('');

const evento = (pqrsId, tipo, autor, detalle = null) => pool.query(
  `INSERT INTO pqrs_eventos (pqrs_id, tipo, autor_uuid, detalle) VALUES ($1,$2,$3,$4)`, [pqrsId, tipo, autor, detalle]);

// ── Público ───────────────────────────────────────────────────────────────────

export const pubConfig = (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ tipos: TIPOS, version_habeas_data: VERSION_HABEAS_DATA, plazo_dias_habiles: PLAZO_DIAS_HABILES });
};

export const pubCrear = async (req, res, next) => {
  try {
    const data = crearPqrsSchema.parse(req.body);

    // Robot: respondemos como si hubiera funcionado, pero no se guarda nada
    if (data.sitio_web) {
      return res.status(201).json({ radicado: `PQRS-${new Date().getFullYear()}-000000`, codigo: generarCodigo(), correo_enviado: false });
    }
    if (data.version_habeas_data !== VERSION_HABEAS_DATA) {
      return res.status(400).json({ error: 'El texto de la autorización cambió: recarga la página', code: 'HABEAS_VERSION' });
    }

    const codigo = generarCodigo();
    const vence = sumarDiasHabiles(new Date(), PLAZO_DIAS_HABILES);
    const { rows: [p] } = await pool.query(
      `INSERT INTO pqrs (radicado, codigo_hash, tipo, nombre, email, telefono, empresa, asunto, mensaje,
                         acepta_habeas_data, habeas_data_version, ip, vence_at)
       VALUES ('PQRS-' || to_char(NOW(), 'YYYY') || '-' || lpad(nextval('pqrs_radicado_seq')::text, 6, '0'),
               $1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11)
       RETURNING id, radicado, vence_at`,
      [hashCodigo(codigo), data.tipo, data.nombre, data.email, data.telefono || null, data.empresa || null,
       data.asunto, data.mensaje, data.version_habeas_data, req.ip, isoFecha(vence)]
    );
    await evento(p.id, 'creada', null, TIPOS[data.tipo]);

    // Avisar a quienes gestionan PQRS (sin datos personales en la notificación)
    notificarPorPermiso('pqrs', { tipo: 'pqrs', mensaje: `Nueva ${TIPOS[data.tipo].toLowerCase()} recibida (${p.radicado})` })
      .catch((err) => logger.error(`pqrs: no se pudo notificar ${p.radicado}: ${err.message}`));

    // El correo de confirmación no debe hacer perder la solicitud si falla: el código se muestra también en pantalla
    let correoEnviado = true;
    try {
      await enviarConfirmacionPqrs({ email: data.email, nombre: data.nombre, radicado: p.radicado, codigo, vence: p.vence_at, tipo: TIPOS[data.tipo] });
    } catch (err) {
      correoEnviado = false;
      logger.warn(`pqrs: no se pudo enviar la confirmación de ${p.radicado}: ${err.message}`);
    }

    res.status(201).json({ radicado: p.radicado, codigo, vence: p.vence_at, correo_enviado: correoEnviado });
  } catch (err) { next(err); }
};

// Estado y respuesta de una solicitud, para quien tiene el radicado y el código de seguimiento
export const pubConsultar = async (req, res, next) => {
  try {
    const { radicado, codigo } = consultaSchema.parse(req.body);
    const { rows: [p] } = await pool.query(
      `SELECT id, radicado, codigo_hash, tipo, estado, asunto, vence_at, created_at, respuesta, respondida_at
         FROM pqrs WHERE radicado = $1 AND is_active`, [radicado]);
    const a = Buffer.from(hashCodigo(codigo));
    const b = Buffer.from(p?.codigo_hash || hashCodigo('sin-registro'));
    // Misma respuesta si el radicado no existe o el código no coincide: no se revela cuál falló
    if (!p || !crypto.timingSafeEqual(a, b)) return res.status(404).json({ error: 'No encontramos una solicitud con ese radicado y código' });

    const respondida = p.estado === 'respondida' || p.estado === 'cerrada';
    res.set('Cache-Control', 'no-store');
    res.json({
      radicado: p.radicado, tipo: p.tipo, tipo_nombre: TIPOS[p.tipo], estado: p.estado, asunto: p.asunto,
      radicada_at: p.created_at, vence_at: p.vence_at,
      respuesta: respondida ? p.respuesta : null, respondida_at: respondida ? p.respondida_at : null,
    });
  } catch (err) { next(err); }
};

// ── Gestión (Control Interno) ─────────────────────────────────────────────────

const SQL_PQRS = `
  SELECT p.id, p.radicado, p.tipo, p.estado, p.nombre, p.email, p.telefono, p.empresa, p.asunto, p.mensaje,
         p.vence_at, p.respuesta, p.respondida_at, p.cerrada_at, p.created_at, p.updated_at, p.asignado_a,
         (p.vence_at < CURRENT_DATE AND p.estado IN ('recibida', 'en_revision')) AS vencida,
         u.nombre AS asignado_nombre, r.nombre AS respondida_por_nombre
    FROM pqrs p
    LEFT JOIN global_usuarios u ON u.id = p.asignado_a
    LEFT JOIN global_usuarios r ON r.id = p.respondida_por`;

export const listar = async (req, res, next) => {
  try {
    const { estado, tipo, q, asignado, vencidas } = req.query;
    const pagina = Math.max(1, Number(req.query.pagina) || 1);
    const limite = Math.min(100, Math.max(1, Number(req.query.limite) || 20));
    const cond = ['p.is_active'];
    const val = [];
    const add = (sql, v) => { val.push(v); cond.push(sql.replace('$$', `$${val.length}`)); };
    if (estado && ['recibida', 'en_revision', 'respondida', 'cerrada'].includes(estado)) add('p.estado = $$', estado);
    if (tipo && TIPOS[tipo]) add('p.tipo = $$', tipo);
    if (asignado === 'yo') add('p.asignado_a = $$', req.user.id);
    if (asignado === 'sin') cond.push('p.asignado_a IS NULL');
    if (vencidas === '1') cond.push(`p.vence_at < CURRENT_DATE AND p.estado IN ('recibida', 'en_revision')`);
    if (q && String(q).trim()) {
      val.push(`%${String(q).trim()}%`);
      cond.push(`(p.radicado ILIKE $${val.length} OR p.nombre ILIKE $${val.length} OR p.asunto ILIKE $${val.length} OR p.email ILIKE $${val.length})`);
    }
    const where = cond.join(' AND ');

    const [{ rows: items }, { rows: [{ total }] }, { rows: [resumen] }] = await Promise.all([
      pool.query(`${SQL_PQRS} WHERE ${where} ORDER BY p.created_at DESC LIMIT ${limite} OFFSET ${(pagina - 1) * limite}`, val),
      pool.query(`SELECT COUNT(*)::int AS total FROM pqrs p WHERE ${where}`, val),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE estado = 'recibida')::int    AS recibida,
                COUNT(*) FILTER (WHERE estado = 'en_revision')::int AS en_revision,
                COUNT(*) FILTER (WHERE estado = 'respondida')::int  AS respondida,
                COUNT(*) FILTER (WHERE estado = 'cerrada')::int     AS cerrada,
                COUNT(*) FILTER (WHERE vence_at < CURRENT_DATE AND estado IN ('recibida', 'en_revision'))::int AS vencidas
           FROM pqrs WHERE is_active`),
    ]);
    // En la lista no viaja el mensaje completo
    res.json({ items: items.map(({ mensaje, respuesta, ...r }) => r), total, pagina, limite, resumen, tipos: TIPOS });
  } catch (err) { next(err); }
};

export const obtener = async (req, res, next) => {
  try {
    const { rows: [p] } = await pool.query(`${SQL_PQRS} WHERE p.id = $1 AND p.is_active`, [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Solicitud no encontrada' });
    const { rows: eventos } = await pool.query(
      `SELECT e.id, e.tipo, e.detalle, e.created_at, u.nombre AS autor
         FROM pqrs_eventos e LEFT JOIN global_usuarios u ON u.id = e.autor_uuid
        WHERE e.pqrs_id = $1 ORDER BY e.created_at, e.id`, [p.id]);
    res.json({ ...p, eventos, tipo_nombre: TIPOS[p.tipo] });
  } catch (err) { next(err); }
};

// Usuarios a quienes se puede asignar: activos con permiso de gestión (WRITE) en PQRS, o administradores
export const asignables = async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.nombre FROM global_usuarios u
        WHERE u.is_active AND u.is_approved AND (u.rol = 'admin' OR EXISTS (
          SELECT 1 FROM permisos p JOIN modulos m ON m.id = p.modulo_id JOIN acciones a ON a.id = p.accion_id
           WHERE p.usuario_uuid = u.id AND m.nombre = 'pqrs' AND a.nombre = 'WRITE'))
        ORDER BY u.nombre`);
    res.json(rows);
  } catch (err) { next(err); }
};

const cargar = async (id) => {
  const { rows: [p] } = await pool.query(`SELECT id, estado, tipo, nombre, email, radicado FROM pqrs WHERE id = $1 AND is_active`, [id]);
  return p || null;
};

export const cambiarEstado = async (req, res, next) => {
  try {
    const { estado } = estadoSchema.parse(req.body);
    const p = await cargar(req.params.id);
    if (!p) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (estado === 'cerrada' && p.estado !== 'respondida' && !['sugerencia', 'felicitacion'].includes(p.tipo)) {
      return res.status(400).json({ error: 'Una petición, queja o reclamo se cierra después de responderla' });
    }
    if (p.estado === 'cerrada' && estado !== 'en_revision') return res.status(400).json({ error: 'La solicitud ya está cerrada' });
    await pool.query(
      `UPDATE pqrs SET estado = $2::varchar, cerrada_at = CASE WHEN $2::varchar = 'cerrada' THEN NOW() ELSE NULL END, updated_at = NOW() WHERE id = $1`,
      [p.id, estado]);
    await evento(p.id, 'estado', req.user.id, `${p.estado} → ${estado}`);
    res.json({ ok: true, estado });
  } catch (err) { next(err); }
};

export const asignar = async (req, res, next) => {
  try {
    const { usuario_uuid } = asignarSchema.parse(req.body);
    const p = await cargar(req.params.id);
    if (!p) return res.status(404).json({ error: 'Solicitud no encontrada' });
    let nombre = null;
    if (usuario_uuid) {
      const { rows: [u] } = await pool.query(
        `SELECT u.id, u.nombre FROM global_usuarios u WHERE u.id = $1 AND u.is_active AND u.is_approved AND (u.rol = 'admin' OR EXISTS (
           SELECT 1 FROM permisos pe JOIN modulos m ON m.id = pe.modulo_id JOIN acciones a ON a.id = pe.accion_id
            WHERE pe.usuario_uuid = u.id AND m.nombre = 'pqrs' AND a.nombre = 'WRITE'))`, [usuario_uuid]);
      if (!u) return res.status(400).json({ error: 'Ese usuario no puede gestionar PQRS' });
      nombre = u.nombre;
    }
    // Al asignar, una solicitud recién recibida pasa a revisión
    await pool.query(
      `UPDATE pqrs SET asignado_a = $2, estado = CASE WHEN $2::uuid IS NOT NULL AND estado = 'recibida' THEN 'en_revision' ELSE estado END, updated_at = NOW() WHERE id = $1`,
      [p.id, usuario_uuid]);
    await evento(p.id, 'asignada', req.user.id, nombre ? `Asignada a ${nombre}` : 'Asignación retirada');
    res.json({ ok: true });
  } catch (err) { next(err); }
};

export const agregarNota = async (req, res, next) => {
  try {
    const { nota } = notaSchema.parse(req.body);
    const p = await cargar(req.params.id);
    if (!p) return res.status(404).json({ error: 'Solicitud no encontrada' });
    await evento(p.id, 'nota', req.user.id, nota);
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
};

// Guarda la respuesta, marca la solicitud como respondida y se la envía por correo a quien radicó
export const responder = async (req, res, next) => {
  try {
    const { respuesta } = responderSchema.parse(req.body);
    const p = await cargar(req.params.id);
    if (!p) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (p.estado === 'cerrada') return res.status(400).json({ error: 'La solicitud está cerrada. Reábrela para responder.' });

    await pool.query(
      `UPDATE pqrs SET respuesta = $2, estado = 'respondida', respondida_at = NOW(), respondida_por = $3, updated_at = NOW() WHERE id = $1`,
      [p.id, respuesta, req.user.id]);
    await evento(p.id, 'respondida', req.user.id);

    let correoEnviado = true;
    try {
      await enviarRespuestaPqrs({ email: p.email, nombre: p.nombre, radicado: p.radicado, respuesta });
    } catch (err) {
      correoEnviado = false;
      await evento(p.id, 'respuesta_sin_correo', req.user.id, err.code === 'EMAIL_SUPRIMIDO' ? 'El correo rebotó antes (lista de supresión)' : 'No se pudo enviar el correo');
      logger.warn(`pqrs: no se pudo enviar la respuesta de ${p.radicado}: ${err.message}`);
    }
    res.json({ ok: true, correo_enviado: correoEnviado });
  } catch (err) { next(err); }
};
