import pool from '../../../db/database.js';
import logger from '../../../config/logger.js';
import { validarArchivo, generarPresignedUpload, guardarArchivo, generarPresignedDescarga, leerPorKey } from '../../../services/archivoService.js';
import { canonicalizar, sha256 } from '../../../services/hashCanonico.js';
import { subsanacionAbierta } from '../services/subsanacion.js';
import { aplicarAportes } from './captacionController.js';
import { solicitudFisicaSchema, firmaFisicaSchema } from '../schemas/captacionSchema.js';

/**
 * Solicitud de vinculación diligenciada en papel.
 * El asesor digita el formato físico (mismas secciones y validaciones que el formulario digital) y sube el escaneo
 * firmado a mano, que hace de evidencia de la firma y de la autorización de datos. No hay OTP ni firma digital, y
 * tampoco validación por voz: la persona firmó en presencia del asesor. Consulta en listas y entrega siguen igual.
 */

const ENTIDAD_FIRMA_FISICA = 'captacion_firma_fisica';

// Prospecto del asesor dueño (los datos de la solicitud los responde solo quien la recibió)
const prospectoDelAsesor = async (id, asesorUuid) => {
  const { rows: [p] } = await pool.query(
    `SELECT id, nombres, apellidos, cedula, celular, correo FROM captacion_prospectos
      WHERE id = $1 AND asesor_uuid = $2 AND is_active = true`, [id, asesorUuid]);
  return p || null;
};

const evento = (p, vinculacionId, tipo, seccion, req, payload = null) => pool.query(
  `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, autor_uuid, ip, payload)
   VALUES ($1,$2,$3,$4,'asesor',$5,$6,$7)`,
  [p, vinculacionId, tipo, seccion, req.user.id, req.ip, payload ? JSON.stringify(payload) : null]);

export const getSolicitudFisica = async (req, res, next) => {
  try {
    const p = await prospectoDelAsesor(req.params.id, req.user.id);
    if (!p) return res.status(404).json({ error: 'Prospecto no encontrado' });
    const { rows: [v] } = await pool.query(
      `SELECT * FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [p.id]);
    if (!v) return res.json({ prospecto: p, vinculacion: null });
    const [{ rows: beneficiarios }, { rows: referencias }] = await Promise.all([
      pool.query('SELECT orden, identificacion, nombres, porcentaje, fecha_nacimiento, parentesco FROM captacion_beneficiarios WHERE vinculacion_id = $1 ORDER BY orden', [v.id]),
      pool.query('SELECT tipo, nombres, telefono_fijo, celular FROM captacion_referencias WHERE vinculacion_id = $1 ORDER BY created_at', [v.id]),
    ]);
    // No se devuelven la firma ni el snapshot: aquí solo se reedita lo digitado
    const { firma_png, firma_trazos, formulario_snapshot, ...datos } = v;
    res.json({ prospecto: p, vinculacion: { ...datos, beneficiarios, referencias } });
  } catch (err) { next(err); }
};

// Abre la solicitud física apenas se registra a la persona (antes de digitar el formato): así queda en la lista de
// solicitudes y se puede retomar aunque el asesor cierre el panel a la mitad. Idempotente.
export const iniciarSolicitudFisica = async (req, res, next) => {
  try {
    const p = await prospectoDelAsesor(req.params.id, req.user.id);
    if (!p) return res.status(404).json({ error: 'Prospecto no encontrado' });

    let { rows: [v] } = await pool.query(
      `SELECT id, estado, origen_solicitud, firma_png, seccion_firma_at FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [p.id]);
    if (v?.estado === 'entregada') return res.status(400).json({ error: 'La solicitud ya fue entregada' });
    if (v && (v.firma_png || (v.origen_solicitud !== 'fisico' && v.seccion_firma_at))) {
      return res.status(409).json({ error: 'Esta solicitud ya fue firmada digitalmente: no se puede convertir en física' });
    }
    if (!v) {
      ({ rows: [v] } = await pool.query(
        `INSERT INTO captacion_vinculaciones (prospecto_id, origen_solicitud, fisico_digitado_por) VALUES ($1, 'fisico', $2) RETURNING id`, [p.id, req.user.id]));
      await evento(p.id, v.id, 'solicitud_fisica_iniciada', 'solicitud', req);
    } else if (v.origen_solicitud !== 'fisico') {
      await pool.query(`UPDATE captacion_vinculaciones SET origen_solicitud = 'fisico', fisico_digitado_por = $2, updated_at = NOW() WHERE id = $1`, [v.id, req.user.id]);
      await evento(p.id, v.id, 'solicitud_fisica_iniciada', 'solicitud', req);
    }
    res.json({ ok: true, vinculacion_id: v.id });
  } catch (err) { next(err); }
};

// PUT idempotente: digita (o corrige) todas las secciones del formato físico
export const guardarSolicitudFisica = async (req, res, next) => {
  try {
    const p = await prospectoDelAsesor(req.params.id, req.user.id);
    if (!p) return res.status(404).json({ error: 'Prospecto no encontrado' });

    const d = solicitudFisicaSchema.parse(req.body);
    if (d.beneficiarios.length && d.beneficiarios.reduce((s, b) => s + b.porcentaje, 0) !== 100) {
      return res.status(400).json({ error: 'Los porcentajes de beneficiarios deben sumar 100%' });
    }

    let { rows: [v] } = await pool.query(
      `SELECT id, estado, firma_png, seccion_firma_at FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [p.id]);
    if (v?.estado === 'entregada') return res.status(400).json({ error: 'La solicitud ya fue entregada' });
    if (v?.firma_png) return res.status(409).json({ error: 'Esta solicitud ya fue firmada digitalmente: no se puede convertir en física' });

    // Firmado el papel, el documento queda como se firmó: solo se reedita si se devolvió a subsanar los datos
    let editaTrasFirma = false;
    if (v?.seccion_firma_at) {
      const sub = await subsanacionAbierta(v.id);
      if (!sub?.items.includes('datos')) {
        return res.status(409).json({ error: 'La solicitud ya está firmada: para corregir datos devuélvela a subsanar', code: 'DATOS_FIRMADOS' });
      }
      editaTrasFirma = true;
    }

    // Identidad y contacto viven en el prospecto
    const { nombres, apellidos, cedula, celular, correo, ...personal } = d.personal;
    const idCampos = Object.entries({ nombres, apellidos, cedula, celular, correo }).filter(([, val]) => val);
    if (idCampos.length) {
      await pool.query(
        `UPDATE captacion_prospectos SET ${idCampos.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1`,
        [p.id, ...idCampos.map(([, val]) => val)]);
    }

    if (!v) {
      ({ rows: [v] } = await pool.query(
        `INSERT INTO captacion_vinculaciones (prospecto_id) VALUES ($1) RETURNING id, estado`, [p.id]));
    }

    // Sección PEP: la debida diligencia ampliada se recalcula igual que en el formulario digital
    const ampliada = Object.values(d.pep).some(Boolean);
    const campos = {
      ...personal, ...d.laboral, ...d.financiera, ...d.pep,
      debida_diligencia_ampliada: ampliada,
      origen_solicitud: 'fisico', fisico_digitado_por: req.user.id, fisico_observaciones: d.observaciones ?? null,
      seccion_personal_at: new Date().toISOString(), seccion_personal_autor: 'asesor',
      seccion_laboral_at: new Date().toISOString(), seccion_laboral_autor: 'asesor',
      seccion_pep_at: new Date().toISOString(), seccion_pep_autor: 'asesor',
      seccion_financiera_at: new Date().toISOString(), seccion_financiera_autor: 'asesor',
      seccion_beneficiarios_at: new Date().toISOString(),
      seccion_referencias_at: new Date().toISOString(),
    };
    const claves = Object.keys(campos);
    // Las columnas jsonb (p. ej. moneda_extranjera_detalle) necesitan el valor como texto JSON
    const valores = Object.values(campos).map((x) => (x !== null && typeof x === 'object' ? JSON.stringify(x) : x));
    await pool.query(
      `UPDATE captacion_vinculaciones SET ${claves.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1`,
      [v.id, ...valores]);

    await pool.query('DELETE FROM captacion_beneficiarios WHERE vinculacion_id = $1', [v.id]);
    for (const b of d.beneficiarios) {
      await pool.query(
        `INSERT INTO captacion_beneficiarios (vinculacion_id, orden, identificacion, nombres, porcentaje, fecha_nacimiento, parentesco)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [v.id, b.orden, b.identificacion || null, b.nombres, b.porcentaje, b.fecha_nacimiento || null, b.parentesco || null]);
    }
    await pool.query('DELETE FROM captacion_referencias WHERE vinculacion_id = $1', [v.id]);
    for (const r of d.referencias) {
      await pool.query(
        `INSERT INTO captacion_referencias (vinculacion_id, tipo, nombres, telefono_fijo, celular) VALUES ($1,$2,$3,$4,$5)`,
        [v.id, r.tipo, r.nombres || null, r.telefono_fijo || null, r.celular || null]);
    }

    const totalMensual = await aplicarAportes({ vinculacionId: v.id, datos: d.aportes, autor: 'asesor' });

    await evento(p.id, v.id, 'solicitud_fisica_digitada', 'solicitud', req, { pep_ampliada: ampliada });
    if (editaTrasFirma) {
      await evento(p.id, v.id, 'cambio_posterior_a_firma', 'solicitud', req, { campos: Object.keys(req.body ?? {}) });
    }

    res.json({ ok: true, vinculacion_id: v.id, total_mensual: totalMensual, debida_diligencia_ampliada: ampliada });
  } catch (err) { next(err); }
};

// Vinculación física del asesor dueño, sin entregar
const fisicaDelAsesor = async (id, asesorUuid) => {
  const { rows: [v] } = await pool.query(
    `SELECT v.id, v.prospecto_id, v.estado, v.origen_solicitud, v.seccion_pep_at, v.seccion_aportes_at, v.seccion_firma_at
       FROM captacion_vinculaciones v JOIN captacion_prospectos p ON p.id = v.prospecto_id
      WHERE v.id = $1 AND p.asesor_uuid = $2 AND v.is_active = true`, [id, asesorUuid]);
  return v || null;
};

export const solicitarEscaneoFirma = async (req, res, next) => {
  try {
    const v = await fisicaDelAsesor(req.params.id, req.user.id);
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    if (v.origen_solicitud !== 'fisico') return res.status(409).json({ error: 'La solicitud no es física' });
    if (v.estado === 'entregada') return res.status(400).json({ error: 'La solicitud ya fue entregada' });
    const error = validarArchivo(req.body);
    if (error) return res.status(400).json({ error });
    res.json(await generarPresignedUpload(ENTIDAD_FIRMA_FISICA, v.id, req.body));
  } catch (err) { next(err); }
};

// Registra el escaneo firmado: sella la solicitud (huella del documento + huella del escaneo) y la deja completa
export const registrarFirmaFisica = async (req, res, next) => {
  try {
    const d = firmaFisicaSchema.parse(req.body);
    const v = await fisicaDelAsesor(req.params.id, req.user.id);
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    if (v.origen_solicitud !== 'fisico') return res.status(409).json({ error: 'La solicitud no es física' });
    if (v.estado === 'entregada') return res.status(400).json({ error: 'La solicitud ya fue entregada' });
    if (v.seccion_firma_at) return res.status(409).json({ error: 'Esta solicitud ya fue firmada' });
    if (!v.seccion_pep_at) return res.status(400).json({ error: 'Falta digitar la sección PEP' });
    if (!v.seccion_aportes_at) return res.status(400).json({ error: 'Falta digitar el aporte' });

    const error = validarArchivo(d);
    if (error) return res.status(400).json({ error });
    if (!d.key.startsWith(`kernel/${ENTIDAD_FIRMA_FISICA}s/${v.id}/`)) return res.status(400).json({ error: 'Key inválida para esta solicitud' });
    if (new Date(d.fecha_firma) > new Date()) return res.status(400).json({ error: 'La fecha de firma no puede ser futura' });

    // El escaneo debe existir de verdad: su huella queda en la evidencia
    const buffer = await leerPorKey(d.key);
    if (!buffer) return res.status(400).json({ error: 'El escaneo no llegó al almacenamiento: súbelo de nuevo' });
    const escaneoHash = sha256(buffer);

    const archivo = await guardarArchivo(ENTIDAD_FIRMA_FISICA, v.id, d, req.user.id);

    const { rows: [snap] } = await pool.query(
      `SELECT v.*, p.nombres, p.apellidos, p.cedula, p.celular, p.correo, p.empresa_codigo, p.habeas_data_at, p.habeas_data_version
         FROM captacion_vinculaciones v JOIN captacion_prospectos p ON p.id = v.prospecto_id WHERE v.id = $1`, [v.id]);
    const snapshotStr = canonicalizar({
      formulario: snap,
      firma_fisica: { fecha_firma: d.fecha_firma, escaneo_sha256: escaneoHash, escaneo_archivo_id: archivo.id, digitado_por: req.user.id, registrada_at: new Date() },
    });
    const docHash = sha256(snapshotStr);

    await pool.query(
      `UPDATE captacion_vinculaciones SET
         firma_fisica_archivo_id = $1, firma_fisica_hash = $2, firma_fisica_fecha = $3,
         firma_at = $3::date, firma_doc_hash = $4, formulario_snapshot = $5,
         seccion_firma_at = NOW(),
         estado = CASE WHEN EXISTS (SELECT 1 FROM captacion_subsanaciones s WHERE s.vinculacion_id = $6 AND s.resuelta_at IS NULL)
                       THEN 'por_subsanar' ELSE 'solicitud_completa' END,
         updated_at = NOW()
       WHERE id = $6`,
      [archivo.id, escaneoHash, d.fecha_firma, docHash, snapshotStr, v.id]);
    await pool.query(
      `UPDATE captacion_prospectos SET estado = 'convertido', convertido_at = NOW(), updated_at = NOW() WHERE id = $1`, [v.prospecto_id]);

    await evento(v.prospecto_id, v.id, 'firma_fisica', 'firma', req,
      { doc_hash: docHash, escaneo_sha256: escaneoHash, archivo_id: archivo.id, fecha_firma: d.fecha_firma });

    res.json({ ok: true, estado: 'solicitud_completa', doc_hash: docHash });
  } catch (err) { next(err); }
};

// URL temporal (15 min) del escaneo. Es un dato personal firmado: solo el asesor dueño y queda en el registro
export const verEscaneoFirma = async (req, res, next) => {
  try {
    const { rows: [v] } = await pool.query(
      `SELECT v.id, v.prospecto_id, v.firma_fisica_archivo_id, v.firma_fisica_hash
         FROM captacion_vinculaciones v JOIN captacion_prospectos p ON p.id = v.prospecto_id
        WHERE v.id = $1 AND ($2::uuid IS NULL OR p.asesor_uuid = $2) AND v.is_active = true`,
      [req.params.id, req.user.rol === 'admin' ? null : req.user.id]);
    if (!v?.firma_fisica_archivo_id) return res.status(404).json({ error: 'La solicitud no tiene escaneo firmado' });
    const descarga = await generarPresignedDescarga(v.firma_fisica_archivo_id);
    await evento(v.prospecto_id, v.id, 'escaneo_firma_visto', 'firma', req).catch((err) => logger.warn(`captacion: no se registró la vista del escaneo: ${err.message}`));
    res.set('Cache-Control', 'no-store');
    res.json({ url: descarga.url, nombre: descarga.nombre, mime: descarga.mime, hash: v.firma_fisica_hash });
  } catch (err) { next(err); }
};
