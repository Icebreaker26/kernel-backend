import { z } from 'zod';
import pool from '../../../db/database.js';
import logger from '../../../config/logger.js';
import { notificarUsuario } from '../../../services/notificationService.js';
import { subirBuffer, leerBuffer, leerPorKey, validarArchivo, generarPresignedUpload, guardarArchivo, generarPresignedDescarga } from '../../../services/archivoService.js';
import { canonicalizar, sha256 } from '../../../services/hashCanonico.js';
import { PARAMETROS_COTEJO } from '../listas/normalizar.js';
import { FUENTES, estadoFuentes, actualizarTodas } from '../listas/fuentes.js';
import { cotejar } from '../listas/cotejo.js';
import { generarPdfConsulta } from '../listas/consultaPdf.js';
import { CHECKLIST_MANUAL, CLAVES_MANUAL, enlacesBusqueda } from '../listas/checklist.js';
import { buscarFuentesAbiertas, busquedaWebDisponible } from '../listas/busquedaWeb.js';
import { consultaListasExigida, guardarExigenciaListas } from '../listas/consultas.js';
import { validacionVozExigida, guardarExigencia as guardarExigenciaVoz } from '../services/validacionVoz.js';

// ── Esquemas ─────────────────────────────────────────────────────────────────

const decisionSchema = z.object({
  id: z.string().max(10),
  decision: z.enum(['descartada', 'confirmada']),
  motivo: z.string().trim().min(10, 'Explica la decisión (mínimo 10 caracteres)').max(500),
});
const manualSchema = z.object({
  resultado: z.enum(['sin_hallazgos', 'hallazgo', 'no_aplica']),
  observaciones: z.string().trim().max(1500).optional(),
  terminos: z.string().trim().max(500).optional(),
  motor: z.string().trim().max(120).optional(),
  autorizacion_titular: z.boolean().optional(),
});
const guardarSchema = z.object({
  decisiones: z.array(decisionSchema).max(100).default([]),
  manual: z.record(z.string(), manualSchema).default({}),
}).strict();
const iniciarSchema = z.object({ repetir: z.boolean().default(false) }).strict();
const validarSchema = z.object({
  resultado: z.enum(['validada', 'observada']),
  observaciones: z.string().trim().max(1000).optional(),
}).strict();
const adjuntoMetaSchema = z.object({ nombre: z.string().min(1).max(200), mime: z.literal('application/pdf'), size: z.coerce.number().int().positive() });
const adjuntoConfirmarSchema = adjuntoMetaSchema.extend({
  key: z.string().min(10).max(300),
  proveedor: z.string().trim().min(2, 'Indica el proveedor (por ejemplo Starsol)').max(60),
  nota: z.string().trim().max(300).optional(),
});
const MAX_ADJUNTO = 10 * 1024 * 1024;
const reglasSchema = z.object({ validacion_voz: z.boolean().optional(), consulta_listas: z.boolean().optional() }).strict();

const ambito = (req) => (req.user.rol === 'admin' ? null : req.user.id);

// ── Consulta → respuesta de la API ───────────────────────────────────────────

const pendientesDe = (c) => {
  const sinDecidir = (c.coincidencias || []).filter((x) => !x.decision).length;
  const faltan = CHECKLIST_MANUAL.filter((i) => i.obligatoria && !c.manual?.[i.clave]).map((i) => i.clave);
  return { coincidencias_sin_decidir: sinDecidir, consultas_obligatorias_faltantes: faltan, completa: !sinDecidir && !faltan.length };
};

const formato = (c, extra = {}) => ({
  id: c.id, vinculacion_id: c.vinculacion_id, estado: c.estado, cedula: c.cedula, nombres: c.nombres, apellidos: c.apellidos,
  fecha_nacimiento: c.fecha_nacimiento, versiones: c.versiones, coincidencias: c.coincidencias, manual: c.manual, declaracion_pep: c.declaracion_pep,
  parametros: c.parametros, adjuntos: (c.adjuntos ?? []).map(({ id, nombre, proveedor, nota, bytes, sha256, subido_at, subido_por_nombre }) => ({ id, nombre, proveedor, nota, bytes, sha256, subido_at, subido_por_nombre })),
  busquedas: c.busquedas ?? null, busqueda_web_disponible: busquedaWebDisponible(), conclusion: c.conclusion, tiene_pdf: !!c.pdf_archivo_id, pdf_hash: c.pdf_hash,
  cerrada_at: c.cerrada_at, validada_at: c.validada_at, observaciones_oficial: c.observaciones_oficial, created_at: c.created_at,
  asesor_nombre: c.asesor_nombre ?? null, oficial_nombre: c.oficial_nombre ?? null,
  pendientes: pendientesDe(c), checklist: CHECKLIST_MANUAL,
  enlaces: enlacesBusqueda({ nombres: c.nombres, apellidos: c.apellidos, cedula: c.cedula }),
  ...extra,
});

const SELECT_CONSULTA = `
  SELECT c.*, ua.nombre AS asesor_nombre, uo.nombre AS oficial_nombre
    FROM captacion_consultas_listas c
    LEFT JOIN global_usuarios ua ON ua.id = c.asesor_uuid
    LEFT JOIN global_usuarios uo ON uo.id = c.validada_por`;

const cargarVinculacion = async (id, asesorUuid) => {
  const { rows: [v] } = await pool.query(
    `SELECT v.id, v.prospecto_id, v.estado, v.fecha_nacimiento,
            v.pep_maneja_recursos_publicos, v.pep_reconocimiento_publico, v.pep_poder_publico, v.pep_vinculo_expuesto, v.seccion_pep_at,
            p.cedula, p.nombres, p.apellidos, p.asesor_uuid
       FROM captacion_vinculaciones v JOIN captacion_prospectos p ON p.id = v.prospecto_id
      WHERE v.id = $1 AND ($2::uuid IS NULL OR p.asesor_uuid = $2) AND v.is_active = true`, [id, asesorUuid]);
  return v ?? null;
};

const identidadVerificada = async (vinculacionId) => {
  const { rows: [r] } = await pool.query(
    `SELECT (ve.cedula = p.cedula AND ve.nombres = p.nombres AND ve.apellidos = p.apellidos) AS vigente
       FROM captacion_verificaciones_identidad ve
       JOIN captacion_vinculaciones v ON v.id = ve.vinculacion_id JOIN captacion_prospectos p ON p.id = v.prospecto_id
      WHERE ve.vinculacion_id = $1 ORDER BY ve.created_at DESC LIMIT 1`, [vinculacionId]);
  return !!r?.vigente;
};

const evento = (v, tipo, req, payload = {}, autor = 'asesor') => pool.query(
  `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, autor_uuid, ip, payload)
   VALUES ($1,$2,$3,'listas',$4,$5,$6,$7)`,
  [v.prospecto_id, v.id, tipo, autor, req.user.id, req.ip, JSON.stringify(payload)]
).catch((err) => logger.error(`captacion: no se pudo registrar ${tipo}: ${err.message}`));

// ── Asesor ───────────────────────────────────────────────────────────────────

export const getConsultaListas = async (req, res, next) => {
  try {
    const v = await cargarVinculacion(req.params.id, ambito(req));
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    const [exigida, verificada, fuentes, { rows }] = await Promise.all([
      consultaListasExigida(), identidadVerificada(v.id), estadoFuentes(),
      pool.query(`${SELECT_CONSULTA} WHERE c.vinculacion_id = $1 ORDER BY c.created_at DESC`, [v.id]),
    ]);
    const vigentes = rows.filter((c) => c.estado !== 'anulada');
    const actual = vigentes[0] ?? null;
    const valida = !!actual && actual.estado === 'validada' && actual.cedula === v.cedula && actual.nombres === v.nombres && actual.apellidos === v.apellidos;
    res.json({
      exigida, vigente: valida, identidad_verificada: verificada, entregada: v.estado === 'entregada',
      actual: actual ? formato(actual) : null,
      // La consulta quedó desactualizada si después se corrigió la identidad
      desactualizada_por_identidad: !!actual && !['anulada'].includes(actual.estado) && (actual.cedula !== v.cedula || actual.nombres !== v.nombres || actual.apellidos !== v.apellidos),
      historial: vigentes.map((c) => ({ id: c.id, estado: c.estado, conclusion: c.conclusion, created_at: c.created_at, cerrada_at: c.cerrada_at, validada_at: c.validada_at, asesor_nombre: c.asesor_nombre, tiene_pdf: !!c.pdf_archivo_id })),
      fuentes: fuentes.map((f) => ({ codigo: f.codigo, nombre: f.nombre, vinculante: f.vinculante, disponible: f.disponible, desactualizada: f.desactualizada, publicada: f.publicada, verificada_at: f.verificada_at })),
    });
  } catch (err) { next(err); }
};

export const iniciarConsultaListas = async (req, res, next) => {
  try {
    const { repetir } = iniciarSchema.parse(req.body ?? {});
    const v = await cargarVinculacion(req.params.id, req.user.id);
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    if (v.estado === 'entregada') return res.status(400).json({ error: 'Ya fue entregada' });
    if (!v.nombres || String(v.cedula).startsWith('STAND_')) return res.status(400).json({ error: 'La persona aún no da su cédula y su nombre' });
    if (!(await identidadVerificada(v.id))) {
      return res.status(409).json({ error: 'Primero verifica la cédula y el nombre contra el documento', code: 'IDENTIDAD_NO_VERIFICADA' });
    }

    // Una consulta en curso con los mismos datos se retoma; "repetir" la anula y hace una nueva con las listas de hoy
    const { rows: [abierta] } = await pool.query(
      `${SELECT_CONSULTA} WHERE c.vinculacion_id = $1 AND c.estado IN ('en_curso','observada') ORDER BY c.created_at DESC LIMIT 1`, [v.id]);
    if (abierta && !repetir && abierta.cedula === v.cedula && abierta.nombres === v.nombres && abierta.apellidos === v.apellidos) {
      return res.json({ ...formato(abierta), existente: true });
    }
    if (abierta) await pool.query(`UPDATE captacion_consultas_listas SET estado = 'anulada', updated_at = NOW() WHERE id = $1`, [abierta.id]);

    const fuentes = await estadoFuentes();
    const faltan = fuentes.filter((f) => f.obligatoria && (!f.disponible || f.desactualizada));
    if (faltan.length) {
      return res.status(409).json({
        error: `La lista obligatoria (${faltan.map((f) => f.nombre).join(', ')}) no está al día. Avisa al administrador: se actualiza sola cada día.`,
        code: 'LISTAS_NO_DISPONIBLES',
      });
    }

    const versiones = Object.fromEntries(fuentes.map((f) => [f.codigo, {
      nombre: f.nombre, vinculante: f.vinculante, disponible: f.disponible, version_id: f.version_id, publicada: f.publicada,
      verificada_at: f.verificada_at, sha256: f.sha256, registros: f.registros,
    }]));
    const coincidencias = await cotejar({ cedula: v.cedula, nombres: v.nombres, apellidos: v.apellidos, nacimiento: v.fecha_nacimiento });
    const declaraPep = !!(v.pep_maneja_recursos_publicos || v.pep_reconocimiento_publico || v.pep_poder_publico || v.pep_vinculo_expuesto);
    const declaracionPep = v.seccion_pep_at ? {
      declara_pep: declaraPep,
      detalle: declaraPep ? [v.pep_maneja_recursos_publicos && 'maneja recursos públicos', v.pep_reconocimiento_publico && 'goza de reconocimiento público',
        v.pep_poder_publico && 'ejerce poder público', v.pep_vinculo_expuesto && 'tiene vínculo con una persona expuesta políticamente'].filter(Boolean).join('; ') : null,
    } : null;

    // Búsqueda automática en fuentes abiertas (si hay buscador configurado): deja enlaces y resúmenes para que el asesor los revise
    const busquedas = busquedaWebDisponible() ? await buscarFuentesAbiertas({ nombres: v.nombres, apellidos: v.apellidos, cedula: v.cedula }) : null;

    const { rows: [c] } = await pool.query(
      `INSERT INTO captacion_consultas_listas
         (vinculacion_id, asesor_uuid, cedula, nombres, apellidos, fecha_nacimiento, versiones, coincidencias, declaracion_pep, parametros, ip, user_agent, busquedas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [v.id, req.user.id, v.cedula, v.nombres, v.apellidos, v.fecha_nacimiento, JSON.stringify(versiones), JSON.stringify(coincidencias),
       declaracionPep ? JSON.stringify(declaracionPep) : null, JSON.stringify(PARAMETROS_COTEJO), req.ip, req.headers['user-agent'] || null,
       busquedas ? JSON.stringify(busquedas) : null]
    );
    await evento(v, 'consulta_listas_iniciada', req, { consulta_id: c.id, coincidencias: coincidencias.length });
    const { rows: [fila] } = await pool.query(`${SELECT_CONSULTA} WHERE c.id = $1`, [c.id]);
    res.status(201).json(formato(fila));
  } catch (err) { next(err); }
};

const cargarConsultaDelAsesor = async (cid, req) => {
  const { rows: [c] } = await pool.query(
    `${SELECT_CONSULTA} JOIN captacion_vinculaciones v ON v.id = c.vinculacion_id JOIN captacion_prospectos p ON p.id = v.prospecto_id
      WHERE c.id = $1 AND p.asesor_uuid = $2 AND v.is_active = true`, [cid, req.user.id]);
  return c ?? null;
};

export const guardarConsultaListas = async (req, res, next) => {
  try {
    const data = guardarSchema.parse(req.body);
    const c = await cargarConsultaDelAsesor(req.params.cid, req);
    if (!c) return res.status(404).json({ error: 'Consulta no encontrada' });
    if (!['en_curso', 'observada'].includes(c.estado)) return res.status(409).json({ error: 'La consulta ya está cerrada', code: 'CONSULTA_CERRADA' });

    const coincidencias = c.coincidencias.map((x) => ({ ...x }));
    for (const d of data.decisiones) {
      const x = coincidencias.find((k) => k.id === d.id);
      if (!x) return res.status(400).json({ error: `La coincidencia ${d.id} no existe en esta consulta` });
      x.decision = d.decision;
      x.decision_motivo = d.motivo;
      x.decidida_at = new Date().toISOString();
    }
    const manual = { ...c.manual };
    for (const [clave, m] of Object.entries(data.manual)) {
      if (!CLAVES_MANUAL.includes(clave)) return res.status(400).json({ error: `Consulta manual desconocida: ${clave}` });
      const item = CHECKLIST_MANUAL.find((i) => i.clave === clave);
      if (m.resultado === 'hallazgo' && !(m.observaciones && m.observaciones.length >= 10)) {
        return res.status(400).json({ error: `${item.titulo}: describe el hallazgo en las observaciones` });
      }
      if (item.pide_terminos && m.resultado !== 'no_aplica' && (!m.terminos || !m.motor)) {
        return res.status(400).json({ error: `${item.titulo}: indica qué términos buscaste y en qué motor` });
      }
      if (item.obligatoria && m.resultado === 'no_aplica') return res.status(400).json({ error: `${item.titulo} es obligatoria: no puede quedar como "no aplica"` });
      if (item.pide_autorizacion && !m.autorizacion_titular) {
        return res.status(400).json({ error: `${item.titulo}: confirma que tienes la autorización del titular para consultar sus antecedentes` });
      }
      manual[clave] = { ...m, consultada_at: new Date().toISOString() };
    }
    const { rows: [fila] } = await pool.query(
      `UPDATE captacion_consultas_listas SET coincidencias = $2, manual = $3, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [c.id, JSON.stringify(coincidencias), JSON.stringify(manual)]);
    const { rows: [nueva] } = await pool.query(`${SELECT_CONSULTA} WHERE c.id = $1`, [fila.id]);
    res.json(formato(nueva));
  } catch (err) { next(err); }
};

// ── Soportes adjuntos (PDF de otro proveedor, como redundancia) ─────────────
// El asesor sube a S3 con URL prefirmada; al confirmar, el servidor lee el archivo, comprueba que es un PDF de verdad y guarda su hash.
// Los adjuntos son evidencia: no se borran y solo se agregan mientras la consulta está abierta (antes de cerrarla y sellar el PDF).

export const solicitarAdjunto = async (req, res, next) => {
  try {
    const meta = adjuntoMetaSchema.parse(req.body);
    const c = await cargarConsultaDelAsesor(req.params.cid, req);
    if (!c) return res.status(404).json({ error: 'Consulta no encontrada' });
    if (!['en_curso', 'observada'].includes(c.estado)) return res.status(409).json({ error: 'La consulta ya está cerrada', code: 'CONSULTA_CERRADA' });
    if (meta.size > MAX_ADJUNTO) return res.status(400).json({ error: 'El PDF excede el límite de 10 MB' });
    const error = validarArchivo(meta);
    if (error) return res.status(400).json({ error });
    res.json(await generarPresignedUpload('captacion_consulta_adjunto', c.vinculacion_id, meta));
  } catch (err) { next(err); }
};

export const confirmarAdjunto = async (req, res, next) => {
  try {
    const data = adjuntoConfirmarSchema.parse(req.body);
    const c = await cargarConsultaDelAsesor(req.params.cid, req);
    if (!c) return res.status(404).json({ error: 'Consulta no encontrada' });
    if (!['en_curso', 'observada'].includes(c.estado)) return res.status(409).json({ error: 'La consulta ya está cerrada', code: 'CONSULTA_CERRADA' });
    if (data.size > MAX_ADJUNTO) return res.status(400).json({ error: 'El PDF excede el límite de 10 MB' });
    const error = validarArchivo(data);
    if (error) return res.status(400).json({ error });
    if (!data.key.startsWith(`kernel/captacion_consulta_adjuntos/${c.vinculacion_id}/`)) return res.status(400).json({ error: 'Key inválida para esta consulta' });

    // Lo que llegó a S3 tiene que ser realmente un PDF (no basta el nombre ni el tipo declarado)
    const bytes = await leerPorKey(data.key);
    if (!bytes) return res.status(400).json({ error: 'No encontramos el archivo subido: inténtalo de nuevo' });
    if (bytes.length > MAX_ADJUNTO || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return res.status(400).json({ error: 'El archivo no es un PDF válido' });
    }
    const archivo = await guardarArchivo('captacion_consulta_adjunto', c.vinculacion_id, { key: data.key, nombre: data.nombre, mime: data.mime, size: bytes.length }, req.user.id);
    const { rows: [yo] } = await pool.query(`SELECT nombre FROM global_usuarios WHERE id = $1`, [req.user.id]);
    const adjunto = {
      id: archivo.id, nombre: data.nombre, proveedor: data.proveedor, nota: data.nota ?? null, bytes: bytes.length,
      sha256: sha256(bytes), subido_at: new Date().toISOString(), subido_por: req.user.id, subido_por_nombre: yo?.nombre ?? null,
    };
    const { rows: [fila] } = await pool.query(
      `UPDATE captacion_consultas_listas SET adjuntos = adjuntos || $2::jsonb, updated_at = NOW() WHERE id = $1 RETURNING id`, [c.id, JSON.stringify([adjunto])]);
    const { rows: [v] } = await pool.query(`SELECT id, prospecto_id FROM captacion_vinculaciones WHERE id = $1`, [c.vinculacion_id]);
    await evento(v, 'consulta_listas_adjunto', req, { consulta_id: c.id, archivo_id: archivo.id, proveedor: data.proveedor, sha256: adjunto.sha256 });
    const { rows: [nueva] } = await pool.query(`${SELECT_CONSULTA} WHERE c.id = $1`, [fila.id]);
    res.status(201).json(formato(nueva));
  } catch (err) { next(err); }
};

const urlDeAdjunto = async (req, res, next, { asesorUuid }) => {
  try {
    const { rows: [c] } = await pool.query(
      `SELECT c.adjuntos FROM captacion_consultas_listas c JOIN captacion_vinculaciones v ON v.id = c.vinculacion_id JOIN captacion_prospectos p ON p.id = v.prospecto_id
        WHERE c.id = $1 AND ($2::uuid IS NULL OR p.asesor_uuid = $2)`, [req.params.cid, asesorUuid]);
    if (!c || !c.adjuntos.some((a) => a.id === req.params.aid)) return res.status(404).json({ error: 'Adjunto no encontrado' });
    const d = await generarPresignedDescarga(req.params.aid);
    res.set('Cache-Control', 'no-store');
    res.json({ url: d.url, nombre: d.nombre });
  } catch (err) { next(err); }
};
export const urlAdjuntoAsesor = (req, res, next) => urlDeAdjunto(req, res, next, { asesorUuid: ambito(req) });
export const urlAdjuntoOficial = (req, res, next) => urlDeAdjunto(req, res, next, { asesorUuid: null });

// Vuelve a buscar en fuentes abiertas (p. ej. se configuró el buscador después de iniciar la consulta, o falló alguna búsqueda)
export const buscarWebConsulta = async (req, res, next) => {
  try {
    const c = await cargarConsultaDelAsesor(req.params.cid, req);
    if (!c) return res.status(404).json({ error: 'Consulta no encontrada' });
    if (!['en_curso', 'observada'].includes(c.estado)) return res.status(409).json({ error: 'La consulta ya está cerrada', code: 'CONSULTA_CERRADA' });
    if (!busquedaWebDisponible()) return res.status(409).json({ error: 'El buscador no está configurado en el servidor', code: 'BUSCADOR_NO_CONFIGURADO' });
    const busquedas = await buscarFuentesAbiertas({ nombres: c.nombres, apellidos: c.apellidos, cedula: c.cedula });
    await pool.query(`UPDATE captacion_consultas_listas SET busquedas = $2, updated_at = NOW() WHERE id = $1`, [c.id, JSON.stringify(busquedas)]);
    const { rows: [fila] } = await pool.query(`${SELECT_CONSULTA} WHERE c.id = $1`, [c.id]);
    res.json(formato(fila));
  } catch (err) { next(err); }
};

// Guarda el PDF (S3) y devuelve su id y hash
const guardarPdf = async (c, vinculacionId, opciones) => {
  const bytes = Buffer.from(await generarPdfConsulta(c, opciones));
  const nombre = `consulta-listas-${String(c.cedula).replace(/[^A-Za-z0-9_-]/g, '')}-${new Date().toISOString().slice(0, 10)}.pdf`;
  const archivo = await subirBuffer('captacion_consulta_listas', vinculacionId, bytes, { nombre, mime: 'application/pdf' });
  return { id: archivo.id, hash: sha256(bytes) };
};

export const cerrarConsultaListas = async (req, res, next) => {
  try {
    const c = await cargarConsultaDelAsesor(req.params.cid, req);
    if (!c) return res.status(404).json({ error: 'Consulta no encontrada' });
    if (!['en_curso', 'observada'].includes(c.estado)) return res.status(409).json({ error: 'La consulta ya está cerrada', code: 'CONSULTA_CERRADA' });
    const pend = pendientesDe(c);
    if (!pend.completa) {
      return res.status(400).json({
        error: pend.coincidencias_sin_decidir ? `Faltan ${pend.coincidencias_sin_decidir} coincidencia(s) por decidir` : 'Falta una consulta obligatoria por registrar',
        code: 'CONSULTA_INCOMPLETA', pendientes: pend,
      });
    }
    const conclusion = (c.coincidencias.some((x) => x.decision === 'confirmada') || Object.values(c.manual).some((m) => m.resultado === 'hallazgo'))
      ? 'con_hallazgos' : 'sin_hallazgos';
    const cerradaAt = new Date();
    const datosHash = sha256(canonicalizar({
      cedula: c.cedula, nombres: c.nombres, apellidos: c.apellidos, fecha_nacimiento: c.fecha_nacimiento, versiones: c.versiones, parametros: c.parametros,
      coincidencias: c.coincidencias, manual: c.manual, declaracion_pep: c.declaracion_pep, busquedas: c.busquedas ?? null,
      adjuntos: (c.adjuntos ?? []).map((a) => ({ id: a.id, nombre: a.nombre, proveedor: a.proveedor, sha256: a.sha256 })), conclusion,
    }));
    const pdf = await guardarPdf({ ...c, conclusion, datos_hash: datosHash, cerrada_at: cerradaAt, estado: 'cerrada' }, c.vinculacion_id, { asesorNombre: c.asesor_nombre });
    const { rows: [v] } = await pool.query(`SELECT id, prospecto_id FROM captacion_vinculaciones WHERE id = $1`, [c.vinculacion_id]);
    await pool.query(
      `UPDATE captacion_consultas_listas
          SET estado = 'cerrada', conclusion = $2, datos_hash = $3, cerrada_at = $4, pdf_archivo_id = $5, pdf_hash = $6, updated_at = NOW()
        WHERE id = $1`,
      [c.id, conclusion, datosHash, cerradaAt, pdf.id, pdf.hash]);
    await evento(v, 'consulta_listas_cerrada', req, { consulta_id: c.id, conclusion, datos_hash: datosHash, pdf_hash: pdf.hash });

    // Aviso a quienes validan (best effort)
    const { rows: oficiales } = await pool.query(
      `SELECT DISTINCT u.id FROM global_usuarios u
        WHERE u.is_active = true AND (u.rol = 'admin' OR EXISTS (
          SELECT 1 FROM permisos p JOIN modulos m ON m.id = p.modulo_id JOIN acciones a ON a.id = p.accion_id
           WHERE p.usuario_uuid = u.id AND m.nombre = 'captacion' AND a.nombre = 'VALIDAR'))`);
    for (const o of oficiales) {
      notificarUsuario(o.id, {
        tipo: 'captacion', modulo: 'captacion',
        mensaje: `${c.asesor_nombre} cerró la consulta en listas de ${c.nombres} ${c.apellidos}${conclusion === 'con_hallazgos' ? ' (CON HALLAZGOS)' : ''}: pendiente de tu validación`,
      }).catch(() => {});
    }
    const { rows: [fila] } = await pool.query(`${SELECT_CONSULTA} WHERE c.id = $1`, [c.id]);
    res.json(formato(fila));
  } catch (err) { next(err); }
};

// ── PDF ──────────────────────────────────────────────────────────────────────

const enviarPdf = async (req, res, next, { asesorUuid, oficial }) => {
  try {
    const { rows: [c] } = await pool.query(
      `SELECT c.id, c.vinculacion_id, c.pdf_archivo_id, c.cedula, v.prospecto_id
         FROM captacion_consultas_listas c JOIN captacion_vinculaciones v ON v.id = c.vinculacion_id JOIN captacion_prospectos p ON p.id = v.prospecto_id
        WHERE c.id = $1 AND ($2::uuid IS NULL OR p.asesor_uuid = $2)`, [req.params.cid, asesorUuid]);
    if (!c || !c.pdf_archivo_id) return res.status(404).json({ error: 'No hay constancia en PDF para esta consulta' });
    const bytes = await leerBuffer(c.pdf_archivo_id);
    await evento({ id: c.vinculacion_id, prospecto_id: c.prospecto_id }, 'consulta_listas_pdf_descargado', req, { consulta_id: c.id }, oficial ? 'oficial' : 'asesor');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="consulta-listas-${String(c.cedula).replace(/[^A-Za-z0-9_-]/g, '')}.pdf"`,
      'Cache-Control': 'no-store',
    });
    res.send(bytes);
  } catch (err) { next(err); }
};

export const pdfConsultaAsesor = (req, res, next) => enviarPdf(req, res, next, { asesorUuid: ambito(req), oficial: false });
export const pdfConsultaOficial = (req, res, next) => enviarPdf(req, res, next, { asesorUuid: null, oficial: true });

// ── Oficial de Cumplimiento ──────────────────────────────────────────────────
// Valida que el asesor hizo las consultas pertinentes. No repite la consulta: revisa lo que el asesor hizo y decidió.

export const listarConsultasCumplimiento = async (req, res, next) => {
  try {
    const estado = ['cerrada', 'validada', 'observada', 'en_curso'].includes(req.query.estado) ? req.query.estado : null;
    const { rows } = await pool.query(
      `${SELECT_CONSULTA} WHERE c.estado <> 'anulada' ${estado ? 'AND c.estado = $1' : "AND c.estado IN ('cerrada','validada','observada')"}
        ORDER BY (c.estado = 'cerrada') DESC, c.cerrada_at DESC NULLS LAST, c.created_at DESC LIMIT 200`, estado ? [estado] : []);
    res.json(rows.map((c) => ({
      id: c.id, estado: c.estado, cedula: c.cedula, nombres: c.nombres, apellidos: c.apellidos, conclusion: c.conclusion,
      asesor_nombre: c.asesor_nombre, cerrada_at: c.cerrada_at, validada_at: c.validada_at, oficial_nombre: c.oficial_nombre,
      coincidencias: c.coincidencias.length, confirmadas: c.coincidencias.filter((x) => x.decision === 'confirmada').length,
    })));
  } catch (err) { next(err); }
};

export const getConsultaCumplimiento = async (req, res, next) => {
  try {
    const { rows: [c] } = await pool.query(`${SELECT_CONSULTA} WHERE c.id = $1`, [req.params.cid]);
    if (!c) return res.status(404).json({ error: 'Consulta no encontrada' });
    res.json(formato(c));
  } catch (err) { next(err); }
};

export const validarConsulta = async (req, res, next) => {
  try {
    const data = validarSchema.parse(req.body);
    const { rows: [c] } = await pool.query(`${SELECT_CONSULTA} WHERE c.id = $1`, [req.params.cid]);
    if (!c) return res.status(404).json({ error: 'Consulta no encontrada' });
    if (c.estado !== 'cerrada') return res.status(409).json({ error: 'Solo se validan consultas cerradas por el asesor', code: 'CONSULTA_NO_CERRADA' });
    if (data.resultado === 'observada' && !(data.observaciones && data.observaciones.length >= 10)) {
      return res.status(400).json({ error: 'Explica qué debe corregir o completar el asesor (mínimo 10 caracteres)' });
    }
    const { rows: [v] } = await pool.query(`SELECT id, prospecto_id FROM captacion_vinculaciones WHERE id = $1`, [c.vinculacion_id]);
    const { rows: [yo] } = await pool.query(`SELECT nombre FROM global_usuarios WHERE id = $1`, [req.user.id]);
    const ahora = new Date();

    if (data.resultado === 'observada') {
      await pool.query(
        `UPDATE captacion_consultas_listas SET estado = 'observada', observaciones_oficial = $2, validada_por = $3, validada_at = $4, updated_at = NOW() WHERE id = $1`,
        [c.id, data.observaciones, req.user.id, ahora]);
      await evento(v, 'consulta_listas_observada', req, { consulta_id: c.id, observaciones: data.observaciones }, 'oficial');
      notificarUsuario(c.asesor_uuid, { tipo: 'captacion', modulo: 'captacion', mensaje: `El Oficial de Cumplimiento observó la consulta en listas de ${c.nombres} ${c.apellidos}: revisa las observaciones` }).catch(() => {});
    } else {
      // El PDF definitivo lleva la constancia de validación; el anterior se conserva
      const pdf = await guardarPdf({ ...c, estado: 'validada', validada_at: ahora, observaciones_oficial: data.observaciones ?? null }, c.vinculacion_id,
        { asesorNombre: c.asesor_nombre, oficialNombre: yo?.nombre });
      await pool.query(
        `UPDATE captacion_consultas_listas
            SET estado = 'validada', observaciones_oficial = $2, validada_por = $3, validada_at = $4, pdf_archivo_id = $5, pdf_hash = $6, updated_at = NOW()
          WHERE id = $1`,
        [c.id, data.observaciones ?? null, req.user.id, ahora, pdf.id, pdf.hash]);
      await evento(v, 'consulta_listas_validada', req, { consulta_id: c.id, pdf_hash: pdf.hash }, 'oficial');
      notificarUsuario(c.asesor_uuid, { tipo: 'captacion', modulo: 'captacion', mensaje: `El Oficial de Cumplimiento validó la consulta en listas de ${c.nombres} ${c.apellidos}` }).catch(() => {});
    }
    const { rows: [fila] } = await pool.query(`${SELECT_CONSULTA} WHERE c.id = $1`, [c.id]);
    res.json(formato(fila));
  } catch (err) { next(err); }
};

// ── Estado y actualización de las listas ─────────────────────────────────────

export const getEstadoListas = async (_req, res, next) => {
  try {
    res.json({ fuentes: await estadoFuentes(), catalogo: Object.keys(FUENTES) });
  } catch (err) { next(err); }
};

export const actualizarListasAhora = async (req, res) => {
  logger.info(`listas: actualización manual pedida por ${req.user.id}`);
  actualizarTodas().catch((err) => logger.error(`listas: ${err.message}`));
  res.status(202).json({ ok: true, mensaje: 'Actualizando en segundo plano; puede tardar un par de minutos.' });
};

// ── Reglas de entrega (qué pasos son obligatorios) ───────────────────────────

export const getReglasEntrega = async (req, res, next) => {
  try {
    const { rows: [p] } = req.user.rol === 'admin'
      ? { rows: [{ ok: true }] }
      : await pool.query(
          `SELECT 1 AS ok FROM permisos p JOIN modulos m ON m.id = p.modulo_id JOIN acciones a ON a.id = p.accion_id
            WHERE p.usuario_uuid = $1 AND m.nombre = 'captacion' AND a.nombre = 'CONFIGURAR'`, [req.user.id]);
    res.json({ validacion_voz: await validacionVozExigida(), consulta_listas: await consultaListasExigida(), puede_configurar: !!p });
  } catch (err) { next(err); }
};

export const actualizarReglasEntrega = async (req, res, next) => {
  try {
    const data = reglasSchema.parse(req.body);
    if (data.validacion_voz !== undefined) await guardarExigenciaVoz(data.validacion_voz, req.user.id);
    if (data.consulta_listas !== undefined) await guardarExigenciaListas(data.consulta_listas, req.user.id);
    logger.info(`captacion: reglas de entrega actualizadas por ${req.user.id}: ${JSON.stringify(data)}`);
    res.json({ ok: true, validacion_voz: await validacionVozExigida(), consulta_listas: await consultaListasExigida() });
  } catch (err) { next(err); }
};
