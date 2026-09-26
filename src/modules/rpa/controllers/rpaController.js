import crypto from 'crypto';
import { z } from 'zod';
import pool from '../../../db/database.js';
import {
  encolarSchema, equivalenciaSchema, equivalenciaUpdateSchema, cedulaUsuarioSchema, crearAgenteSchema,
  estadoAgenteSchema, latidoSchema, resultadoSchema, resolverRevisionSchema,
} from '../schemas/rpaSchema.js';
import * as svc from '../services/rpaService.js';
import * as flex from '../services/flexibleService.js';
import { env } from '../../../config/env.js';
import { norm, llaveCiudad } from '../services/payloadSolido.js';

// Los ErrorRpa (409, 404…) se contestan con su mensaje; el errorHandler oculta el detalle de cualquier otro error en producción
const manejar = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof svc.ErrorRpa) return res.status(err.status).json({ error: err.message, ...err.extra });
    next(err);
  }
};

// ── Jobs ──────────────────────────────────────────────────────────────────────

const SELECT_JOB = `
  SELECT j.id, j.estado, j.cedula, j.intentos, j.error, j.faltantes, j.resultado, j.created_at, j.updated_at, j.terminado_at,
         j.aprobado_at, j.vinculacion_id, j.agente_id,
         p.nombres, p.apellidos, u.nombre AS asesor_nombre, ap.nombre AS aprobado_por_nombre
    FROM rpa_jobs j
    JOIN captacion_vinculaciones v ON v.id = j.vinculacion_id
    JOIN captacion_prospectos p ON p.id = v.prospecto_id
    LEFT JOIN global_usuarios u ON u.id = p.asesor_uuid
    LEFT JOIN global_usuarios ap ON ap.id = j.aprobado_por`;

export const listarJobs = manejar(async (req, res) => {
  const estado = typeof req.query.estado === 'string' ? req.query.estado : null;
  const { rows } = await pool.query(
    `${SELECT_JOB} WHERE j.is_active ${estado ? 'AND j.estado = $1' : ''} ORDER BY j.created_at DESC LIMIT 200`,
    estado ? [estado] : []);
  res.json(rows);
});

export const getJob = manejar(async (req, res) => {
  const { rows: [job] } = await pool.query(`${SELECT_JOB} WHERE j.id = $1`, [req.params.id]);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  const { rows: capturas } = await pool.query(
    `SELECT id, etiqueta, created_at FROM rpa_capturas WHERE job_id = $1 ORDER BY created_at`, [job.id]);
  // Lo que se digitará, para que quien aprueba lo compare con las capturas
  const abierto = ['requiere_datos', 'pendiente', 'listo_para_aprobar', 'aprobado'].includes(job.estado);
  const { payload } = abierto ? await svc.armarPayload(job.vinculacion_id) : { payload: null };
  res.json({ ...job, capturas, payload });
});

export const verCaptura = manejar(async (req, res) => {
  const { rows: [c] } = await pool.query(`SELECT mime, datos FROM rpa_capturas WHERE id = $1`, [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Captura no encontrada' });
  res.setHeader('Content-Type', c.mime);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(c.datos);
});

export const encolar = manejar(async (req, res) => {
  const { vinculacion_id } = encolarSchema.parse(req.body);
  res.status(201).json(await svc.encolar(vinculacion_id, req.user.id));
});
export const reevaluar = manejar(async (req, res) => res.json(await svc.reevaluar(req.params.id)));
export const aprobar   = manejar(async (req, res) => res.json(await svc.aprobar(req.params.id, req.user.id)));
export const cancelar  = manejar(async (req, res) => res.json(await svc.cancelar(req.params.id)));
export const resolver  = manejar(async (req, res) => {
  res.json(await svc.resolverRevision(req.params.id, resolverRevisionSchema.parse(req.body), req.user.id));
});

// ── Equivalencias texto → código SOLIDO ───────────────────────────────────────

export const listarEquivalencias = manejar(async (req, res) => {
  const catalogo = typeof req.query.catalogo === 'string' ? req.query.catalogo : null;
  const { rows } = await pool.query(
    `SELECT id, catalogo, texto_original, texto_norm, codigo_solido, descripcion, created_at
       FROM rpa_equivalencias WHERE is_active ${catalogo ? 'AND catalogo = $1' : ''} ORDER BY catalogo, texto_norm LIMIT 2000`,
    catalogo ? [catalogo] : []);
  res.json(rows);
});

export const crearEquivalencia = manejar(async (req, res) => {
  const d = equivalenciaSchema.parse(req.body);
  const llave = d.catalogo === 'ciudad' ? llaveCiudad(d.texto, d.departamento) : norm(d.texto);
  const { rows: [r] } = await pool.query(
    `INSERT INTO rpa_equivalencias (catalogo, texto_norm, texto_original, codigo_solido, descripcion, creado_por)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (catalogo, texto_norm) DO UPDATE
       SET codigo_solido = EXCLUDED.codigo_solido, descripcion = EXCLUDED.descripcion, is_active = true, updated_at = NOW()
     RETURNING id, catalogo, texto_original, texto_norm, codigo_solido, descripcion`,
    [d.catalogo, llave, d.departamento ? `${d.texto}, ${d.departamento}` : d.texto, d.codigo_solido, d.descripcion ?? null, req.user.id]);
  res.status(201).json(r);
});

export const actualizarEquivalencia = manejar(async (req, res) => {
  const d = equivalenciaUpdateSchema.parse(req.body);
  const { rows: [r] } = await pool.query(
    `UPDATE rpa_equivalencias SET codigo_solido = COALESCE($2, codigo_solido), descripcion = COALESCE($3, descripcion), updated_at = NOW()
      WHERE id = $1 AND is_active RETURNING id, catalogo, texto_original, codigo_solido, descripcion`,
    [req.params.id, d.codigo_solido ?? null, d.descripcion ?? null]);
  if (!r) return res.status(404).json({ error: 'Equivalencia no encontrada' });
  res.json(r);
});

export const eliminarEquivalencia = manejar(async (req, res) => {
  const { rowCount } = await pool.query(`UPDATE rpa_equivalencias SET is_active = false, updated_at = NOW() WHERE id = $1 AND is_active`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Equivalencia no encontrada' });
  res.json({ ok: true });
});

// ── Cédula de los asesores ────────────────────────────────────────────────────

export const sugerirCedulas = manejar(async (_req, res) => res.json(await svc.sugerirCedulas()));

export const asignarCedula = manejar(async (req, res) => {
  const { cedula } = cedulaUsuarioSchema.parse(req.body);
  const { rows: [u] } = await pool.query(
    `UPDATE global_usuarios SET cedula = $2, updated_at = NOW() WHERE id = $1 RETURNING id, nombre, cedula`, [req.params.id, cedula]);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  // Aviso (no bloqueo): todos los empleados deberían ser asociados, así que la cédula debería estar en el padrón
  let en_padron = null;
  if (cedula) en_padron = (await pool.query(`SELECT 1 FROM asociados WHERE codigo = $1`, [cedula])).rowCount > 0;
  res.json({ ...u, en_padron });
});

// ── Agentes (administración) ──────────────────────────────────────────────────

// Con su estado real: activo · trabajando · bloqueado (pantalla de Windows bloqueada) · pausado · apagado (sin latido reciente)
export const listarAgentes = manejar(async (_req, res) => res.json(await svc.estadoAgentes()));

export const crearAgente = manejar(async (req, res) => {
  const { nombre } = crearAgenteSchema.parse(req.body);
  const token = `rpa_${crypto.randomBytes(32).toString('base64url')}`;
  const { rows: [a] } = await pool.query(
    `INSERT INTO rpa_agentes (nombre, token_hash) VALUES ($1, $2) RETURNING id, nombre, pausado, permite_guardar`,
    [nombre, svc.hashToken(token)]);
  // El token se muestra una sola vez: en la base solo queda su hash
  res.status(201).json({ ...a, token });
});

export const estadoAgente = manejar(async (req, res) => {
  const d = estadoAgenteSchema.parse(req.body);
  const { rows: [a] } = await pool.query(
    `UPDATE rpa_agentes SET pausado = COALESCE($2, pausado), permite_guardar = COALESCE($3, permite_guardar), updated_at = NOW()
      WHERE id = $1 AND is_active RETURNING id, nombre, pausado, permite_guardar`,
    [req.params.id, d.pausado ?? null, d.permite_guardar ?? null]);
  if (!a) return res.status(404).json({ error: 'Agente no encontrado' });
  res.json(a);
});

// ── Endpoints del agente (autenticados con su token, no con cookie) ───────────

export const agenteLatido = manejar(async (req, res) => {
  res.json(await svc.latido(req.agente, latidoSchema.parse(req.body ?? {})));
});
export const agenteReclamar = manejar(async (req, res) => {
  await svc.latido(req.agente, {});
  res.json({ job: await svc.reclamar(req.agente) });
});
export const agenteResultado = manejar(async (req, res) => {
  const j = await svc.registrarResultado(req.agente, req.params.id, resultadoSchema.parse(req.body));
  res.json({ id: j.id, estado: j.estado });
});

// ── Botón "Subir a SOLIDO" (lo usa el asesor titular desde la vinculación) ────

const uuid = (v) => z.string().uuid().parse(v);

const titularDe = async (vinculacionId) => {
  const { rows: [t] } = await pool.query(
    `SELECT p.asesor_uuid FROM captacion_vinculaciones v JOIN captacion_prospectos p ON p.id = v.prospecto_id WHERE v.id = $1`, [vinculacionId]);
  return t?.asesor_uuid ?? null;
};

const esTitular = (user, asesorUuid) => user.rol === 'admin' || user.id === asesorUuid;

// Quien administra el RPA o ve las vinculaciones de todos los asesores también puede consultar el estado
const veEstadoAjeno = async (user) => {
  if (user.rol === 'admin') return true;
  const { rowCount } = await pool.query(
    `SELECT 1 FROM permisos p JOIN modulos m ON m.id = p.modulo_id JOIN acciones a ON a.id = p.accion_id
      WHERE p.usuario_uuid = $1 AND ((m.nombre = 'rpa' AND a.nombre = 'READ') OR (m.nombre = 'captacion' AND a.nombre = 'READ_ALL')) LIMIT 1`, [user.id]);
  return rowCount > 0;
};

export const estadoVinculacion = manejar(async (req, res) => {
  const id = uuid(req.params.id);
  const info = await svc.estadoVinculacion(id);
  const titular = esTitular(req.user, info.vinculacion.asesor_uuid);
  if (!titular && !(await veEstadoAjeno(req.user))) return res.status(403).json({ error: 'Sin permiso' });
  const { asesor_uuid: _omitido, ...vinculacion } = info.vinculacion;
  res.json({
    ...info,
    vinculacion,
    es_titular: titular,
    puede_subir: info.puede_subir && titular,
    motivo: info.motivo ?? (titular ? null : 'Solo el asesor titular de la solicitud puede subirla a SOLIDO.'),
  });
});

export const subirVinculacion = manejar(async (req, res) => {
  const id = uuid(req.params.id);
  const titular = await titularDe(id);
  if (!titular) return res.status(404).json({ error: 'Vinculación no encontrada' });
  if (!esTitular(req.user, titular)) return res.status(403).json({ error: 'Solo el asesor titular de la solicitud puede subirla a SOLIDO.' });
  await svc.exigirCumplimiento(id);
  const { rows: [abierto] } = await pool.query(
    `SELECT id FROM rpa_jobs WHERE vinculacion_id = $1 AND estado = 'requiere_datos' AND is_active ORDER BY created_at DESC LIMIT 1`, [id]);
  // "Subir = aprobar" (RPA_GUARDADO_DIRECTO, por defecto true): el trabajo nace aprobado y el agente guarda sin revisión previa
  const directo = env.RPA_GUARDADO_DIRECTO === 'true';
  if (abierto) await svc.reevaluar(abierto.id, { directo, usuarioId: req.user.id });   // esperaba datos: se revisa de nuevo
  else await svc.encolar(id, req.user.id, { directo });
  res.status(201).json(await svc.estadoVinculacion(id));
});

// ── Flexible del maestro de cartera (exportación de SOLIDO → sync de asociados con aprobación humana) ─────────────────


export const agenteTareaReclamar = manejar(async (req, res) => {
  await svc.latido(req.agente, {});
  res.json({ tarea: await flex.reclamarTarea(req.agente) });
});

export const agenteFlexibleArchivo = manejar(async (req, res) => {
  const id = uuid(req.params.id);
  const cuerpo = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const esperado = (req.get('x-sha256') || '').toLowerCase();
  if (esperado && crypto.createHash('sha256').update(cuerpo).digest('hex') !== esperado) {
    throw new svc.ErrorRpa(400, 'El archivo se alteró en el envío (el SHA-256 no coincide)');
  }
  const f = await flex.recibirArchivo(req.agente, id, cuerpo, decodeURIComponent(req.get('x-nombre-archivo') || 'flexible.csv'));
  res.status(201).json({ id: f.id, estado: f.estado, filas: f.filas });
});

export const agenteFlexibleFallo = manejar(async (req, res) => {
  const { error } = z.object({ error: z.string().min(1).max(2000) }).strict().parse(req.body);
  const f = await flex.fallo(req.agente, uuid(req.params.id), error);
  res.json({ id: f.id, estado: f.estado });
});

export const listarFlexibles = manejar(async (_req, res) => res.json(await flex.listar()));
export const getFlexible = manejar(async (req, res) => res.json(await flex.obtener(uuid(req.params.id))));
export const solicitarFlexible = manejar(async (req, res) => res.status(201).json(await flex.solicitar(req.user.id)));
export const cancelarFlexible = manejar(async (req, res) => res.json(await flex.cancelar(uuid(req.params.id))));

export const analizarFlexible = manejar(async (req, res) => {
  const { status, body } = await flex.analizar(uuid(req.params.id));
  res.status(status).json(body);
});

export const aplicarFlexible = manejar(async (req, res) => {
  const r = await flex.aplicar(uuid(req.params.id), req.user);
  res.status(r.aplicada ? 200 : r.status).json({ aplicada: r.aplicada, ...(r.body ?? {}) });
});

export const rechazarFlexible = manejar(async (req, res) => {
  const { nota } = z.object({ nota: z.string().trim().min(5).max(500) }).strict().parse(req.body);
  res.json(await flex.rechazar(uuid(req.params.id), req.user, nota));
});

export const descargarFlexible = manejar(async (req, res) => {
  const f = await flex.descargar(uuid(req.params.id));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${(f.nombre_archivo || 'flexible.csv').replace(/[^\w.\- ]/g, '_')}"`);
  res.send(f.csv);
});
