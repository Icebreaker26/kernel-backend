import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import pool from '../../../db/database.js';
import { env } from '../../../config/env.js';
import { notificarUsuario } from '../../../services/notificationService.js';
import { enviarCodigoFirma, enviarEmail } from '../../../services/emailService.js';
import { validarArchivo, generarPresignedUpload, guardarArchivo, generarPresignedDescarga, eliminarArchivo, subirBuffer, leerBuffer } from '../../../services/archivoService.js';
import logger from '../../../config/logger.js';
import { TARIFAS } from '../tarifas.js';
import { generarFormatoVinculacion } from '../services/formatoVinculacionPdf.js';
import { SQL_SIN_IDENTIFICAR, veTodasLasVinculaciones, ambitoLectura } from '../services/captacionService.js';
import { canonicalizar, sha256 } from '../../../services/hashCanonico.js';
import { registrarTexto } from '../services/textosConsentimiento.js';
import { subsanacionAbierta, archivarFirma, textoSubsanacion } from '../services/subsanacion.js';
import { consultaListasExigida, consultaVigente } from '../listas/consultas.js';
import { PROTOCOLO_VOZ, MIN_PREGUNTAS_COINCIDEN, validacionVozExigida, guardarExigencia, validacionVigente } from '../services/validacionVoz.js';
import {
  crearProspectoSchema, toqueSchema, updateProspectoSchema,
  seccionPersonalSchema, seccionLaboralSchema, seccionPepSchema,
  seccionFinancieraSchema, seccionAportesSchema, seccionBeneficiariosSchema, seccionReferenciasSchema,
  seccionFirmaSchema, stepUpSchema, valoresAsesorSchema, habeasDataSchema, iniciarWebSchema, configWebSchema,
  validacionVozSchema, exigenciaVozSchema, subsanacionSchema, correccionIdentidadSchema,
} from '../schemas/captacionSchema.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

const calcScore = `(
  CASE WHEN v.id IS NOT NULL AND v.seccion_firma_at IS NOT NULL THEN 40 ELSE 0 END +
  CASE WHEN v.id IS NOT NULL THEN 30 ELSE 0 END +
  CASE WHEN p.ping_count > 1 THEN 20 ELSE 0 END +
  CASE WHEN p.ping_at > NOW() - INTERVAL '2 hours' THEN 15 ELSE 0 END
) AS score`;

const VERSION_CONSENTIMIENTO = 'v1.0';
// Texto del consentimiento a firmar electrónicamente; súbelo si cambia la redacción en el formulario.
const VERSION_FIRMA_ELECTRONICA = 'fe-v1.0';
// Texto de la autorización de tratamiento de datos (Ley 1581 de 2012); súbelo si cambia la redacción.
const VERSION_HABEAS_DATA = 'hd-v1.0';

// Tras la entrega la solicitud está en procesamiento: ni el asociado ni el asesor pueden modificarla.
// Antes de la entrega SÍ se puede completar o corregir (subsanar) aunque ya esté firmada.
const solicitudEntregada = async (prospectoId) => {
  const { rows: [v] } = await pool.query(
    `SELECT estado FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [prospectoId]
  );
  return v?.estado === 'entregada';
};
const ERROR_ENTREGADA = { error: 'La solicitud ya fue entregada' };

// ── CRUD interno (asesor) ─────────────────────────────────────────────────────

export const crearProspecto = async (req, res, next) => {
  try {
    const data = crearProspectoSchema.parse(req.body);

    // Validar empresa activa
    const { rowCount: emp } = await pool.query(
      `SELECT 1 FROM empresas WHERE codigo = $1 AND is_active = true`,
      [data.empresa_codigo]
    );
    if (!emp) return res.status(400).json({ error: 'Empresa no encontrada o inactiva' });

    // Duplicado: misma cédula activa (cualquier asesor, últimos 30 días)
    const { rows: dup } = await pool.query(
      `SELECT id, asesor_uuid FROM captacion_prospectos
        WHERE cedula = $1 AND is_active = true
          AND estado NOT IN ('convertido','convertido_por_sync','frio')
          AND created_at > NOW() - INTERVAL '30 days'`,
      [data.cedula]
    );
    if (dup.length) return res.status(409).json({ error: 'Ya existe un prospecto activo con esa cédula en los últimos 30 días' });

    // Generar token
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(rawToken);

    const { rows: [p] } = await pool.query(
      `INSERT INTO captacion_prospectos
         (empresa_codigo, asesor_uuid, nombres, apellidos, cedula, celular, correo,
          token_hash, token, acepta_habeas_data, habeas_data_at, habeas_data_origen, interes_principal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, true, NOW(), 'asesor', $10)
       RETURNING id, nombres, apellidos, cedula, celular, correo, empresa_codigo,
                 estado, interes_principal, created_at`,
      [data.empresa_codigo, req.user.id, data.nombres, data.apellidos,
       data.cedula, data.celular, data.correo || null, tokenHash, rawToken,
       data.interes_principal || null]
    );

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, tipo, autor_tipo, autor_uuid, ip)
       VALUES ($1, 'creado', 'asesor', $2, $3)`,
      [p.id, req.user.id, req.ip]
    );

    res.status(201).json({ ...p, token: rawToken });
  } catch (err) { next(err); }
};

// El admin ve la captación de todos los asesores (null = sin filtro); cada asesor, solo la suya.
const ambitoAsesor = (req) => (req.user.rol === 'admin' ? null : req.user.id);

export const listarProspectos = async (req, res, next) => {
  try {
    const { estado, empresa, sin_identificar } = req.query;
    const params = [ambitoAsesor(req)];
    const filters = [`($1::uuid IS NULL OR p.asesor_uuid = $1)`, `p.is_active = true`];

    // Por defecto se ocultan los prospectos del stand que nadie ha identificado (ver captacionService).
    // ?sin_identificar=solo → únicamente esos; ?sin_identificar=incluir → todos.
    if (sin_identificar === 'solo') filters.push(SQL_SIN_IDENTIFICAR);
    else if (sin_identificar !== 'incluir') filters.push(`NOT ${SQL_SIN_IDENTIFICAR}`);

    if (estado) { params.push(estado); filters.push(`p.estado = $${params.length}`); }
    if (empresa) { params.push(empresa); filters.push(`p.empresa_codigo = $${params.length}`); }

    const { rows } = await pool.query(
      `SELECT p.id, p.nombres, p.apellidos, p.cedula, p.celular, p.correo,
              p.empresa_codigo, e.nombre AS empresa_nombre,
              p.estado, p.ping_count, p.ping_at, p.created_at, p.convertido_at, p.interes_principal,
              ${SQL_SIN_IDENTIFICAR} AS sin_identificar,
              CASE WHEN EXISTS (SELECT 1 FROM captacion_eventos ev WHERE ev.prospecto_id = p.id AND ev.tipo = 'stand_init') THEN 'stand'
                   WHEN EXISTS (SELECT 1 FROM captacion_eventos ev WHERE ev.prospecto_id = p.id AND ev.tipo = 'enlace_publico_init') THEN 'grupo'
                   WHEN EXISTS (SELECT 1 FROM captacion_eventos ev WHERE ev.prospecto_id = p.id AND ev.tipo = 'web_init') THEN 'web'
                   ELSE 'enlace' END AS origen,
              v.id AS vinculacion_id, v.estado AS vinculacion_estado,
              v.seccion_personal_at, v.seccion_laboral_at, v.seccion_pep_at,
              v.seccion_financiera_at, v.seccion_aportes_at, v.seccion_beneficiarios_at,
              v.seccion_referencias_at, v.seccion_documentos_at, v.seccion_firma_at,
              (SELECT resultado FROM captacion_toques
                WHERE prospecto_id = p.id ORDER BY created_at DESC LIMIT 1) AS ultimo_toque,
              (SELECT created_at FROM captacion_toques
                WHERE prospecto_id = p.id ORDER BY created_at DESC LIMIT 1) AS ultimo_toque_at,
              ${calcScore},
              p.asesor_uuid, CASE WHEN $1::uuid IS NULL THEN ua.nombre END AS asesor_nombre
         FROM captacion_prospectos p
         JOIN empresas e ON e.codigo = p.empresa_codigo
         LEFT JOIN global_usuarios ua ON ua.id = p.asesor_uuid
         LEFT JOIN captacion_vinculaciones v ON v.prospecto_id = p.id AND v.is_active = true
        WHERE ${filters.join(' AND ')}
        ORDER BY score DESC, p.ping_at DESC NULLS LAST, p.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
};

// Conteos que la lista necesita y que no salen de la propia lista (que oculta los sin identificar)
export const resumenProspectos = async (req, res, next) => {
  try {
    const { rows: [r] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE ${SQL_SIN_IDENTIFICAR}) AS sin_identificar
         FROM captacion_prospectos p
        WHERE ($1::uuid IS NULL OR p.asesor_uuid = $1) AND p.is_active = true`,
      [ambitoAsesor(req)]
    );
    res.json({ sin_identificar: Number(r.sin_identificar) });
  } catch (err) { next(err); }
};

export const getProspecto = async (req, res, next) => {
  try {
    const { rows: [p] } = await pool.query(
      `SELECT p.*, e.nombre AS empresa_nombre,
              v.id AS vinculacion_id, v.estado AS vinculacion_estado,
              v.seccion_personal_at, v.seccion_laboral_at, v.seccion_pep_at,
              v.seccion_financiera_at, v.seccion_beneficiarios_at,
              v.seccion_referencias_at, v.seccion_documentos_at, v.seccion_firma_at,
              v.seccion_personal_autor, v.seccion_laboral_autor,
              v.seccion_pep_autor, v.seccion_financiera_autor,
              v.debida_diligencia_ampliada
         FROM captacion_prospectos p
         JOIN empresas e ON e.codigo = p.empresa_codigo
         LEFT JOIN captacion_vinculaciones v ON v.prospecto_id = p.id AND v.is_active = true
        WHERE p.id = $1 AND ($2::uuid IS NULL OR p.asesor_uuid = $2) AND p.is_active = true`,
      [req.params.id, ambitoAsesor(req)]
    );
    if (!p) return res.status(404).json({ error: 'Prospecto no encontrado' });
    res.json(p);
  } catch (err) { next(err); }
};

export const actualizarProspecto = async (req, res, next) => {
  try {
    const data = updateProspectoSchema.parse(req.body);
    const sets = Object.entries(data).map(([k], i) => `${k} = $${i + 2}`);
    if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });

    const { rows: [p] } = await pool.query(
      `UPDATE captacion_prospectos SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1 AND asesor_uuid = $${sets.length + 2} AND is_active = true
        RETURNING id, estado`,
      [req.params.id, ...Object.values(data), req.user.id]
    );
    if (!p) return res.status(404).json({ error: 'Prospecto no encontrado' });

    // Cambiar el correo o el celular de una solicitud ya firmada queda registrado (y la validación de voz deja de valer para el número nuevo)
    if (data.correo !== undefined || data.celular !== undefined) {
      const { rows: [firmada] } = await pool.query(
        `SELECT id, seccion_firma_at FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true AND seccion_firma_at IS NOT NULL`, [p.id]);
      if (firmada) {
        await pool.query(
          `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, autor_uuid, ip, payload)
           VALUES ($1,$2,'cambio_posterior_a_firma','contacto','asesor',$3,$4,$5)`,
          [p.id, firmada.id, req.user.id, req.ip,
           JSON.stringify({ campos: ['correo', 'celular'].filter((k) => data[k] !== undefined), firmada_at: firmada.seccion_firma_at })]
        ).catch((err) => logger.error(`captacion: no se pudo auditar el cambio de contacto: ${err.message}`));
      }
    }
    res.json(p);
  } catch (err) { next(err); }
};

export const registrarToque = async (req, res, next) => {
  try {
    const data = toqueSchema.parse(req.body);
    const { rows: [p] } = await pool.query(
      `SELECT id FROM captacion_prospectos WHERE id = $1 AND asesor_uuid = $2 AND is_active = true`,
      [req.params.id, req.user.id]
    );
    if (!p) return res.status(404).json({ error: 'Prospecto no encontrado' });

    const { rows: [t] } = await pool.query(
      `INSERT INTO captacion_toques (prospecto_id, asesor_uuid, resultado, notas)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, req.user.id, data.resultado, data.notas || null]
    );

    await pool.query(
      `UPDATE captacion_prospectos SET estado = 'contactado', updated_at = NOW()
        WHERE id = $1 AND estado = 'nuevo'`,
      [req.params.id]
    );

    res.status(201).json(t);
  } catch (err) { next(err); }
};

export const whatsappUrl = async (req, res, next) => {
  try {
    const { rows: [p] } = await pool.query(
      `SELECT p.nombres, p.apellidos, p.celular, p.token, p.estado,
              u.nombre AS asesor_nombre
         FROM captacion_prospectos p
         JOIN global_usuarios u ON u.id = p.asesor_uuid
        WHERE p.id = $1 AND p.asesor_uuid = $2 AND p.is_active = true`,
      [req.params.id, req.user.id]
    );
    if (!p) return res.status(404).json({ error: 'Prospecto no encontrado' });

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const link = `${baseUrl}/conocenos/${p.token}`;
    const telefono = p.celular.replace(/\D/g, '').replace(/^0/, '57');
    const mensaje = encodeURIComponent(
      `Hola ${p.nombres}, soy ${p.asesor_nombre} de Cooperativa Progresemos. ` +
      `Te comparto información sobre cómo afiliarte y los beneficios que tenemos para ti: ${link}`
    );
    const url = `https://wa.me/${telefono.startsWith('57') ? telefono : '57' + telefono}?text=${mensaje}`;

    await pool.query(
      `UPDATE captacion_prospectos SET estado = 'link_enviado', updated_at = NOW()
        WHERE id = $1 AND estado IN ('nuevo','contactado')`,
      [req.params.id]
    );

    res.json({ url, link });
  } catch (err) { next(err); }
};

// ── Vinculaciones (asesor completa secciones faltantes) ──────────────────────

export const listarVinculaciones = async (req, res, next) => {
  try {
    // ?alcance=todos → las de todos los asesores, solo si tiene captacion READ_ALL (o es admin); si no, las suyas.
    // ?alcance=mias → solo las suyas (útil para el admin, que por defecto ve todas).
    const { alcance } = req.query;
    const ambito = alcance === 'mias' ? req.user.id
      : alcance === 'todos' && await veTodasLasVinculaciones(req.user) ? null : ambitoAsesor(req);
    const { rows } = await pool.query(
      `SELECT v.id, v.estado, v.created_at, v.updated_at,
              p.nombres, p.apellidos, p.cedula, p.celular, p.empresa_codigo,
              e.nombre AS empresa_nombre, p.asesor_uuid, CASE WHEN $1::uuid IS NULL THEN ua.nombre END AS asesor_nombre,
              v.seccion_personal_at, v.seccion_laboral_at, v.seccion_pep_at,
              v.seccion_financiera_at, v.seccion_beneficiarios_at,
              v.seccion_referencias_at, v.seccion_documentos_at, v.seccion_firma_at, v.seccion_aportes_at,
              v.valor_aporte, v.periodicidad_descuento,
              v.debida_diligencia_ampliada, v.entregada_at, v.solido_estado, v.solido_cargado_at
         FROM captacion_vinculaciones v
         JOIN captacion_prospectos p ON p.id = v.prospecto_id
         JOIN empresas e ON e.codigo = p.empresa_codigo
         LEFT JOIN global_usuarios ua ON ua.id = p.asesor_uuid
        WHERE ($1::uuid IS NULL OR p.asesor_uuid = $1) AND v.is_active = true
        ORDER BY v.updated_at DESC`,
      [ambito]
    );
    res.json(rows);
  } catch (err) { next(err); }
};

// Qué puede ver el usuario en Vinculaciones (el frontend muestra el botón "Ver las de todos" solo si puede)
export const miAlcanceVinculaciones = async (req, res, next) => {
  try { res.json({ ve_todas: await veTodasLasVinculaciones(req.user) }); } catch (err) { next(err); }
};

export const getVinculacion = async (req, res, next) => {
  try {
    const { rows: [v] } = await pool.query(
      `SELECT v.*,
              p.nombres, p.apellidos, p.cedula, p.celular, p.correo, p.empresa_codigo, p.asesor_uuid,
              p.habeas_data_at, p.habeas_data_origen, p.habeas_data_version,
              e.nombre AS empresa_nombre,
              (SELECT json_agg(json_build_object('seccion', ev.seccion, 'autor_tipo', ev.autor_tipo, 'created_at', ev.created_at)
                               ORDER BY ev.created_at DESC)
                 FROM captacion_eventos ev
                WHERE ev.vinculacion_id = v.id AND ev.tipo = 'cambio_posterior_a_firma') AS cambios_posteriores,
              json_agg(DISTINCT jsonb_build_object(
                'id',b.id,'orden',b.orden,'identificacion',b.identificacion,
                'nombres',b.nombres,'porcentaje',b.porcentaje,
                'fecha_nacimiento',b.fecha_nacimiento,'parentesco',b.parentesco
              )) FILTER (WHERE b.id IS NOT NULL) AS beneficiarios,
              json_agg(DISTINCT jsonb_build_object(
                'id',r.id,'tipo',r.tipo,'nombres',r.nombres,
                'telefono_fijo',r.telefono_fijo,'celular',r.celular
              )) FILTER (WHERE r.id IS NOT NULL) AS referencias
         FROM captacion_vinculaciones v
         JOIN captacion_prospectos p ON p.id = v.prospecto_id
         JOIN empresas e ON e.codigo = p.empresa_codigo
         LEFT JOIN captacion_beneficiarios b ON b.vinculacion_id = v.id
         LEFT JOIN captacion_referencias r ON r.vinculacion_id = v.id
        WHERE v.id = $1 AND ($2::uuid IS NULL OR p.asesor_uuid = $2) AND v.is_active = true
        GROUP BY v.id, p.nombres, p.apellidos, p.cedula, p.celular, p.correo, p.asesor_uuid,
                 p.empresa_codigo, p.habeas_data_at, p.habeas_data_origen, p.habeas_data_version, e.nombre`,
      [req.params.id, await ambitoLectura(req)]
    );
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    res.json({ ...v, tarifas: TARIFAS });
  } catch (err) { next(err); }
};

// Datos que alimentan el Formato No. 5. `asesorUuid` restringe al asesor dueño (null = uso interno del sistema).
const cargarDatosFormato = async (vinculacionId, asesorUuid = null) => {
  const { rows: [v] } = await pool.query(
    `SELECT v.*,
            p.nombres, p.apellidos, p.cedula, p.celular, p.correo,
            e.nombre AS empresa_nombre,
            u.nombre AS asesor_nombre
       FROM captacion_vinculaciones v
       JOIN captacion_prospectos p ON p.id = v.prospecto_id
       JOIN empresas e ON e.codigo = p.empresa_codigo
       LEFT JOIN global_usuarios u ON u.id = p.asesor_uuid
      WHERE v.id = $1 AND v.is_active = true AND ($2::uuid IS NULL OR p.asesor_uuid = $2)`,
    [vinculacionId, asesorUuid]
  );
  if (!v) return null;

  const [{ rows: beneficiarios }, { rows: referencias }] = await Promise.all([
    pool.query('SELECT * FROM captacion_beneficiarios WHERE vinculacion_id = $1 ORDER BY orden', [v.id]),
    pool.query('SELECT * FROM captacion_referencias WHERE vinculacion_id = $1 ORDER BY created_at', [v.id]),
  ]);
  return { ...v, beneficiarios, referencias };
};

// Copia inmutable del formato tal como quedó al firmar: se guarda una sola vez y su hash SHA-256 queda
// en la vinculación para poder comprobar después que no fue alterada. Si falla, la firma sigue siendo
// válida (tiene snapshot y hash) y la descarga genera el PDF al vuelo.
const sellarFormato = async (vinculacionId, { reemplazar = false, correccionId = null } = {}) => {
  try {
    const datos = await cargarDatosFormato(vinculacionId);
    if (!datos || (datos.firma_pdf_archivo_id && !reemplazar)) return false;
    const pdf = Buffer.from(await generarFormatoVinculacion(datos));
    const hash = crypto.createHash('sha256').update(pdf).digest('hex');
    const archivo = await subirBuffer('captacion_formato', vinculacionId, pdf,
      { nombre: `formato-vinculacion-${String(datos.cedula).replace(/[^A-Za-z0-9_-]/g, '')}.pdf`, mime: 'application/pdf' });
    await pool.query(
      `UPDATE captacion_vinculaciones
          SET firma_pdf_archivo_id = $1, firma_pdf_hash = $2, firma_pdf_at = NOW()
        WHERE id = $3 AND ($4::boolean OR firma_pdf_archivo_id IS NULL)`,
      [archivo.id, hash, vinculacionId, reemplazar]
    );
    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, payload)
       VALUES ($1,$2,'formato_sellado','firma','sistema',$3)`,
      [datos.prospecto_id, vinculacionId, JSON.stringify({ pdf_hash: hash, doc_hash: datos.firma_doc_hash, ...(reemplazar ? { reemplaza_a: datos.firma_pdf_archivo_id, hash_anterior: datos.firma_pdf_hash, correccion_id: correccionId } : {}) })]
    );
    return true;
  } catch (err) {
    logger.error(`captacion: no se pudo sellar el formato de ${vinculacionId}: ${err.message}`);
    return false;
  }
};

// Formato No. 5 (PDF oficial). Firmada la solicitud se entrega la copia sellada; con `?actual=1`
// (o sin firma) se genera con los datos de hoy. Contiene datos personales y la firma: solo el asesor
// dueño, sin caché, y cada descarga queda en captacion_eventos.
export const descargarFormato = async (req, res, next) => {
  try {
    const v = await cargarDatosFormato(req.params.id, await ambitoLectura(req));
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });

    let pdf = null;
    let sellado = false;
    if (v.firma_pdf_archivo_id && req.query.actual !== '1') {
      pdf = await leerBuffer(v.firma_pdf_archivo_id).catch((err) => {
        logger.error(`captacion: no se pudo leer el formato sellado de ${v.id}: ${err.message}`);
        return null;
      });
      sellado = !!pdf;
      // El sellado es prueba: si lo guardado ya no coincide con su hash, no se entrega como si nada
      if (pdf && v.firma_pdf_hash && sha256(pdf) !== v.firma_pdf_hash) {
        logger.error(`captacion: el formato sellado de ${v.id} NO coincide con su hash`);
        await pool.query(
          `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, autor_uuid, ip, payload)
           VALUES ($1,$2,'formato_integridad_fallida','formato','asesor',$3,$4,$5)`,
          [v.prospecto_id, v.id, req.user.id, req.ip, JSON.stringify({ esperado: v.firma_pdf_hash, obtenido: sha256(pdf) })]
        ).catch(() => {});
        return res.status(409).json({ error: 'El formato sellado no coincide con su huella digital. No se entrega; avisa a soporte.', code: 'FORMATO_ALTERADO' });
      }
    }
    if (!pdf) pdf = Buffer.from(await generarFormatoVinculacion(v));

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, autor_uuid, ip, payload)
       VALUES ($1,$2,'formato_descargado','formato','asesor',$3,$4,$5)`,
      [v.prospecto_id, v.id, req.user.id, req.ip, JSON.stringify({ estado: v.estado, sellado })]
    );

    const nombre = `formato-vinculacion-${String(v.cedula || v.id).replace(/[^A-Za-z0-9_-]/g, '')}.pdf`;
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${nombre}"`,
      'Cache-Control': 'no-store',
      'X-Formato-Sellado': String(sellado),
    });
    res.send(pdf);
  } catch (err) { next(err); }
};

// URLs de descarga (15 min) de la cédula. Son datos personales sensibles: solo el asesor dueño
// de la solicitud y cada consulta queda en captacion_eventos.
export const getDocumentosVinculacion = async (req, res, next) => {
  try {
    const { rows: [v] } = await pool.query(
      `SELECT v.id, v.prospecto_id, v.cedula_frente_id, v.cedula_reverso_id
         FROM captacion_vinculaciones v
         JOIN captacion_prospectos p ON p.id = v.prospecto_id
        WHERE v.id = $1 AND ($2::uuid IS NULL OR p.asesor_uuid = $2) AND v.is_active = true`,
      [req.params.id, await ambitoLectura(req)]
    );
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });

    const [frente, reverso] = await Promise.all([
      v.cedula_frente_id  ? generarPresignedDescarga(v.cedula_frente_id)  : null,
      v.cedula_reverso_id ? generarPresignedDescarga(v.cedula_reverso_id) : null,
    ]);

    if (frente || reverso) {
      await pool.query(
        `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, autor_uuid, ip, payload)
         VALUES ($1,$2,'documento_visto','documentos','asesor',$3,$4,$5)`,
        [v.prospecto_id, v.id, req.user.id, req.ip,
         JSON.stringify({ lados: [frente && 'frente', reverso && 'reverso'].filter(Boolean) })]
      );
    }

    res.set('Cache-Control', 'no-store');
    res.json({ frente, reverso });
  } catch (err) { next(err); }
};

export const actualizarValoresAsesor = async (req, res, next) => {
  try {
    const data = valoresAsesorSchema.parse(req.body);
    const { rows: [v] } = await pool.query(
      `UPDATE captacion_vinculaciones SET
         valor_aporte   = COALESCE($1, valor_aporte),
         cuota_admision = COALESCE($2, cuota_admision),
         updated_at     = NOW()
        WHERE id = $3
          AND (SELECT asesor_uuid FROM captacion_prospectos WHERE id = prospecto_id) = $4
          AND is_active = true
        RETURNING id, valor_aporte, cuota_admision`,
      [data.valor_aporte ?? null, data.cuota_admision ?? null, req.params.id, req.user.id]
    );
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    res.json(v);
  } catch (err) { next(err); }
};

// ── Corrección de identidad por el asesor ────────────────────────────────────
// Un número de cédula o un nombre mal escrito lo corrige el asesor sin devolverle el trámite a la persona. Queda quién, cuándo, por qué,
// el valor anterior y el nuevo, y el PDF sellado anterior (se conserva); si ya estaba firmada se sella uno nuevo con los datos corregidos.
// La firma original sigue probando lo que la persona firmó (su hash y su instantánea no cambian).
export const corregirIdentidad = async (req, res, next) => {
  try {
    const data = correccionIdentidadSchema.parse(req.body);
    const { rows: [v] } = await pool.query(
      `SELECT v.id, v.prospecto_id, v.estado, v.seccion_firma_at, v.firma_pdf_archivo_id, v.firma_pdf_hash,
              p.nombres, p.apellidos, p.cedula
         FROM captacion_vinculaciones v JOIN captacion_prospectos p ON p.id = v.prospecto_id
        WHERE v.id = $1 AND ($2::uuid IS NULL OR p.asesor_uuid = $2) AND v.is_active = true`,
      [req.params.id, ambitoAsesor(req)]   // el admin corrige en cualquier solicitud; queda registrado él como quien corrigió
    );
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    if (v.estado === 'entregada') return res.status(400).json({ error: 'Ya fue entregada: no se puede corregir' });

    const antes = {};
    const despues = {};
    for (const k of ['cedula', 'nombres', 'apellidos']) {
      if (data[k] !== undefined && data[k] !== v[k]) { antes[k] = v[k]; despues[k] = data[k]; }
    }
    if (!Object.keys(despues).length) return res.status(400).json({ error: 'Los datos son iguales a los que ya tiene la solicitud' });

    if (despues.cedula) {
      const { rowCount } = await pool.query(
        `SELECT 1 FROM captacion_prospectos WHERE cedula = $1 AND id <> $2 AND is_active = true`, [despues.cedula, v.prospecto_id]);
      if (rowCount) return res.status(409).json({ error: 'Ya existe otra solicitud con esa cédula', code: 'CEDULA_DUPLICADA' });
    }

    const columnas = Object.keys(despues);
    await pool.query(
      `UPDATE captacion_prospectos SET ${columnas.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1`,
      [v.prospecto_id, ...columnas.map((k) => despues[k])]
    );
    const { rows: [c] } = await pool.query(
      `INSERT INTO captacion_correcciones (vinculacion_id, asesor_uuid, antes, despues, motivo, pdf_anterior_id, pdf_anterior_hash, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, created_at`,
      [v.id, req.user.id, JSON.stringify(antes), JSON.stringify(despues), data.motivo,
       v.firma_pdf_archivo_id, v.firma_pdf_hash, req.ip, req.headers['user-agent'] || null]
    );
    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, autor_uuid, ip, payload)
       VALUES ($1,$2,'identidad_corregida','identidad','asesor',$3,$4,$5)`,
      [v.prospecto_id, v.id, req.user.id, req.ip, JSON.stringify({ correccion_id: c.id, campos: columnas, motivo: data.motivo, firmada: !!v.seccion_firma_at })]
    );

    await pool.query(
      `INSERT INTO captacion_verificaciones_identidad (vinculacion_id, asesor_uuid, cedula, nombres, apellidos, origen, correccion_id, ip, user_agent)
       SELECT $1, $2, p.cedula, p.nombres, p.apellidos, 'corregida', $3, $4, $5 FROM captacion_prospectos p WHERE p.id = $6`,
      [v.id, req.user.id, c.id, req.ip, req.headers['user-agent'] || null, v.prospecto_id]
    );

    // Ya firmada: el PDF sellado anterior queda guardado y se sella uno nuevo con los datos corregidos
    let resellado = false;
    if (v.seccion_firma_at) {
      resellado = await sellarFormato(v.id, { reemplazar: true, correccionId: c.id });
    }
    res.json({ ok: true, id: c.id, campos: columnas, formato_resellado: resellado });
  } catch (err) { next(err); }
};

export const getCorrecciones = async (req, res, next) => {
  try {
    const { rows: [v] } = await pool.query(
      `SELECT v.id FROM captacion_vinculaciones v JOIN captacion_prospectos p ON p.id = v.prospecto_id
        WHERE v.id = $1 AND ($2::uuid IS NULL OR p.asesor_uuid = $2) AND v.is_active = true`, [req.params.id, await ambitoLectura(req)]);
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    const { rows } = await pool.query(
      `SELECT c.id, c.antes, c.despues, c.motivo, c.created_at, u.nombre AS asesor_nombre
         FROM captacion_correcciones c LEFT JOIN global_usuarios u ON u.id = c.asesor_uuid
        WHERE c.vinculacion_id = $1 ORDER BY c.created_at DESC`, [v.id]);
    const { rows: [ultima] } = await pool.query(
      `SELECT ve.id, ve.origen, ve.cedula, ve.nombres, ve.apellidos, ve.created_at, u.nombre AS asesor_nombre,
              (ve.cedula = p.cedula AND ve.nombres = p.nombres AND ve.apellidos = p.apellidos) AS vigente
         FROM captacion_verificaciones_identidad ve
         JOIN captacion_vinculaciones v ON v.id = ve.vinculacion_id
         JOIN captacion_prospectos p ON p.id = v.prospecto_id
         LEFT JOIN global_usuarios u ON u.id = ve.asesor_uuid
        WHERE ve.vinculacion_id = $1 ORDER BY ve.created_at DESC LIMIT 1`, [v.id]);
    res.json({ correcciones: rows, verificacion: ultima ?? null });
  } catch (err) { next(err); }
};

// El asesor confirma que cédula y nombre de la solicitud son EXACTAMENTE los de la cédula. Si no lo son, los corrige con corregirIdentidad.
export const verificarIdentidad = async (req, res, next) => {
  try {
    const { rows: [v] } = await pool.query(
      `SELECT v.id, v.prospecto_id, v.estado, p.cedula, p.nombres, p.apellidos
         FROM captacion_vinculaciones v JOIN captacion_prospectos p ON p.id = v.prospecto_id
        WHERE v.id = $1 AND ($2::uuid IS NULL OR p.asesor_uuid = $2) AND v.is_active = true`, [req.params.id, ambitoAsesor(req)]);   // el admin también confirma; queda él como quien verificó
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    if (v.estado === 'entregada') return res.status(400).json({ error: 'Ya fue entregada' });
    if (v.cedula?.startsWith('STAND_') || !v.nombres) return res.status(400).json({ error: 'La persona aún no da su cédula y su nombre' });
    const { rows: [r] } = await pool.query(
      `INSERT INTO captacion_verificaciones_identidad (vinculacion_id, asesor_uuid, cedula, nombres, apellidos, origen, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,'confirmada',$6,$7) RETURNING id, created_at`,
      [v.id, req.user.id, v.cedula, v.nombres, v.apellidos, req.ip, req.headers['user-agent'] || null]);
    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, autor_uuid, ip, payload)
       VALUES ($1,$2,'identidad_verificada','identidad','asesor',$3,$4,$5)`,
      [v.prospecto_id, v.id, req.user.id, req.ip, JSON.stringify({ verificacion_id: r.id, origen: 'confirmada' })]);
    res.status(201).json({ ok: true, id: r.id });
  } catch (err) { next(err); }
};

// ── Devolver a subsanar ──────────────────────────────────────────────────────
// El asesor marca qué está mal (cédula, firma o datos) con un motivo. La solicitud queda "por subsanar" y no se entrega hasta que se
// resuelva. Si devuelve la firma, la anterior se archiva en captacion_firmas_historial y la persona firma de nuevo.

const enlaceDelProspecto = (token) => `${env.FRONTEND_URL.replace(/\/$/, '')}/conocenos/${token}`;

// Qué le falta hacer a la persona para dar por corregida la solicitud
const pendientesSubsanacion = async (vinculacionId, s) => {
  const { rows: [v] } = await pool.query(
    `SELECT v.seccion_firma_at,
            (SELECT a.created_at FROM archivos a WHERE a.id = v.cedula_frente_id)  AS frente_at,
            (SELECT a.created_at FROM archivos a WHERE a.id = v.cedula_reverso_id) AS reverso_at
       FROM captacion_vinculaciones v WHERE v.id = $1`, [vinculacionId]);
  const desde = new Date(s.created_at);
  const pendientes = [];
  if (s.items.includes('cedula_frente') && !(v.frente_at && new Date(v.frente_at) > desde)) pendientes.push('cedula_frente');
  if (s.items.includes('cedula_reverso') && !(v.reverso_at && new Date(v.reverso_at) > desde)) pendientes.push('cedula_reverso');
  if (s.items.includes('firma') && !v.seccion_firma_at) pendientes.push('firma');
  return pendientes;
};

const cerrarSubsanacionDe = async (vinculacionId, subsanacionId, por) => {
  await pool.query(`UPDATE captacion_subsanaciones SET resuelta_at = NOW(), resuelta_por = $2 WHERE id = $1`, [subsanacionId, por]);
  await pool.query(
    `UPDATE captacion_vinculaciones
        SET estado = CASE WHEN seccion_firma_at IS NOT NULL THEN 'solicitud_completa' ELSE 'borrador' END, updated_at = NOW()
      WHERE id = $1 AND estado = 'por_subsanar'`, [vinculacionId]);
};

export const pedirSubsanacion = async (req, res, next) => {
  let client;
  try {
    const data = subsanacionSchema.parse(req.body);
    const items = [...new Set(data.items)];
    const { rows: [v] } = await pool.query(
      `SELECT v.id, v.prospecto_id, v.estado, v.seccion_firma_at, p.nombres, p.correo, p.token, a.nombre AS asesor_nombre
         FROM captacion_vinculaciones v
         JOIN captacion_prospectos p ON p.id = v.prospecto_id
         LEFT JOIN global_usuarios a ON a.id = p.asesor_uuid
        WHERE v.id = $1 AND p.asesor_uuid = $2 AND v.is_active = true`,
      [req.params.id, req.user.id]
    );
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    if (v.estado === 'entregada') return res.status(400).json({ error: 'Ya fue entregada: no se puede devolver' });
    if (await subsanacionAbierta(v.id)) {
      return res.status(409).json({ error: 'Esta solicitud ya está devuelta a subsanar. Espera la corrección o ciérrala.', code: 'SUBSANACION_ABIERTA' });
    }

    client = await pool.connect();
    await client.query('BEGIN');
    const { rows: [s] } = await client.query(
      `INSERT INTO captacion_subsanaciones (vinculacion_id, asesor_uuid, items, motivo) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [v.id, req.user.id, items, data.motivo]
    );
    const firmaArchivada = items.includes('firma') && !!v.seccion_firma_at;
    if (firmaArchivada) await archivarFirma(client, v.id, s.id);
    await client.query(`UPDATE captacion_vinculaciones SET estado = 'por_subsanar', updated_at = NOW() WHERE id = $1`, [v.id]);
    await client.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, autor_uuid, ip, payload)
       VALUES ($1,$2,'subsanacion_solicitada','subsanacion','asesor',$3,$4,$5)`,
      [v.prospecto_id, v.id, req.user.id, req.ip, JSON.stringify({ subsanacion_id: s.id, items, motivo: data.motivo, firma_archivada: firmaArchivada })]
    );
    await client.query('COMMIT');

    // Aviso a la persona por correo (si falla, el asesor tiene el enlace y el mensaje para enviarlo por WhatsApp)
    const enlace = enlaceDelProspecto(v.token);
    const mensaje = textoSubsanacion({ nombres: v.nombres, items, motivo: data.motivo, enlace, asesor: v.asesor_nombre || 'tu asesor' });
    let correoEnviado = false;
    if (v.correo) {
      try {
        await enviarEmail(v.correo, mensaje.asunto, mensaje.html, mensaje.texto);
        correoEnviado = true;
        await pool.query(`UPDATE captacion_subsanaciones SET correo_enviado = true WHERE id = $1`, [s.id]);
      } catch (err) {
        logger.warn(`captacion: no se pudo avisar la subsanación ${s.id} por correo: ${err.message}`);
      }
    }
    res.status(201).json({ id: s.id, items, motivo: data.motivo, enlace, correo_enviado: correoEnviado, mensaje: mensaje.texto, firma_archivada: firmaArchivada });
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
};

export const getSubsanacion = async (req, res, next) => {
  try {
    const { rows: [v] } = await pool.query(
      `SELECT v.id, p.token FROM captacion_vinculaciones v JOIN captacion_prospectos p ON p.id = v.prospecto_id
        WHERE v.id = $1 AND ($2::uuid IS NULL OR p.asesor_uuid = $2) AND v.is_active = true`,
      [req.params.id, await ambitoLectura(req)]
    );
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    const [abierta, { rows: historial }, { rows: [firmas] }] = await Promise.all([
      subsanacionAbierta(v.id),
      pool.query(
        `SELECT s.id, s.items, s.motivo, s.correo_enviado, s.created_at, s.resuelta_at, s.resuelta_por, u.nombre AS asesor_nombre
           FROM captacion_subsanaciones s LEFT JOIN global_usuarios u ON u.id = s.asesor_uuid
          WHERE s.vinculacion_id = $1 ORDER BY s.created_at DESC`, [v.id]),
      pool.query(`SELECT COUNT(*)::int AS n FROM captacion_firmas_historial WHERE vinculacion_id = $1`, [v.id]),
    ]);
    res.json({
      abierta: abierta ? { ...abierta, pendientes: await pendientesSubsanacion(v.id, abierta) } : null,
      enlace: enlaceDelProspecto(v.token),
      historial,
      firmas_archivadas: firmas.n,
    });
  } catch (err) { next(err); }
};

// El asesor cierra la subsanación sin esperar a la persona (p. ej. ya lo resolvieron por otro medio)
export const cerrarSubsanacion = async (req, res, next) => {
  try {
    const { rows: [v] } = await pool.query(
      `SELECT v.id, v.prospecto_id FROM captacion_vinculaciones v JOIN captacion_prospectos p ON p.id = v.prospecto_id
        WHERE v.id = $1 AND p.asesor_uuid = $2 AND v.is_active = true`, [req.params.id, req.user.id]);
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    const s = await subsanacionAbierta(v.id);
    if (!s) return res.status(404).json({ error: 'No hay una subsanación abierta' });
    if (s.items.includes('firma')) {
      const { rows: [f] } = await pool.query(`SELECT seccion_firma_at FROM captacion_vinculaciones WHERE id = $1`, [v.id]);
      if (!f.seccion_firma_at) return res.status(400).json({ error: 'La firma se devolvió y la persona aún no firma de nuevo' });
    }
    await cerrarSubsanacionDe(v.id, s.id, 'asesor');
    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, autor_uuid, ip, payload)
       VALUES ($1,$2,'subsanacion_resuelta','subsanacion','asesor',$3,$4,$5)`,
      [v.prospecto_id, v.id, req.user.id, req.ip, JSON.stringify({ subsanacion_id: s.id })]);
    res.json({ ok: true });
  } catch (err) { next(err); }
};

// La persona avisa que ya corrigió lo que se le pidió
export const pubResolverSubsanacion = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });
    if (await solicitudEntregada(p.id)) return res.status(400).json(ERROR_ENTREGADA);
    const { rows: [v] } = await pool.query(`SELECT id FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [p.id]);
    const s = v ? await subsanacionAbierta(v.id) : null;
    if (!s) return res.status(404).json({ error: 'No tienes nada pendiente por corregir' });

    const pendientes = await pendientesSubsanacion(v.id, s);
    if (pendientes.length) {
      return res.status(400).json({ error: 'Aún falta corregir algo de lo que se te pidió', code: 'SUBSANACION_INCOMPLETA', pendientes });
    }
    await cerrarSubsanacionDe(v.id, s.id, 'prospecto');
    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, ip, payload)
       VALUES ($1,$2,'subsanacion_resuelta','subsanacion','prospecto',$3,$4)`,
      [p.id, v.id, req.ip, JSON.stringify({ subsanacion_id: s.id, items: s.items })]);
    if (p.asesor_uuid) {
      notificarUsuario(p.asesor_uuid, {
        tipo: 'captacion', modulo: 'captacion',
        mensaje: `${p.nombres} ${p.apellidos} corrigió su solicitud: ya puedes revisarla`,
      }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
};

// ── Validación de identidad por llamada de voz ───────────────────────────────
// El asesor llama al celular registrado, hace preguntas del protocolo y confirma la voluntad de la persona. Cada intento queda
// registrado; la solicitud solo se entrega (si la cooperativa lo exige) con una validación posterior a la firma y a ese mismo celular.

export const getValidacionVoz = async (req, res, next) => {
  try {
    const { rows: [v] } = await pool.query(
      `SELECT v.id, v.seccion_firma_at, v.origen_solicitud, p.celular
         FROM captacion_vinculaciones v JOIN captacion_prospectos p ON p.id = v.prospecto_id
        WHERE v.id = $1 AND ($2::uuid IS NULL OR p.asesor_uuid = $2) AND v.is_active = true`,
      [req.params.id, await ambitoLectura(req)]
    );
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    const [exigida, vigente, { rows: historial }] = await Promise.all([
      validacionVozExigida(),
      validacionVigente(v.id),
      pool.query(
        `SELECT vv.id, vv.resultado, vv.celular_llamado, vv.preguntas, vv.confirma_voluntad, vv.grabada, vv.observaciones,
                vv.created_at, u.nombre AS asesor_nombre
           FROM captacion_validaciones_voz vv LEFT JOIN global_usuarios u ON u.id = vv.asesor_uuid
          WHERE vv.vinculacion_id = $1 ORDER BY vv.created_at DESC`, [v.id]),
    ]);
    res.json({
      exigida: exigida && v.origen_solicitud !== 'fisico', validada: !!vigente, firmada: !!v.seccion_firma_at, celular: v.celular,
      protocolo: PROTOCOLO_VOZ, minimo_coincidencias: MIN_PREGUNTAS_COINCIDEN, historial,
    });
  } catch (err) { next(err); }
};

export const registrarValidacionVoz = async (req, res, next) => {
  try {
    const data = validacionVozSchema.parse(req.body);
    const { rows: [v] } = await pool.query(
      `SELECT v.id, v.prospecto_id, v.estado, v.seccion_firma_at, p.celular
         FROM captacion_vinculaciones v JOIN captacion_prospectos p ON p.id = v.prospecto_id
        WHERE v.id = $1 AND p.asesor_uuid = $2 AND v.is_active = true`,
      [req.params.id, req.user.id]
    );
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    if (v.estado === 'entregada') return res.status(400).json({ error: 'Ya fue entregada' });
    if (!v.seccion_firma_at) return res.status(400).json({ error: 'La persona aún no firma: la llamada se hace después de la firma' });

    if (data.resultado === 'validada') {
      const coinciden = new Set(data.preguntas.filter((q) => q.coincide).map((q) => q.clave));
      if (!data.confirma_voluntad) return res.status(400).json({ error: 'Para validar hay que confirmar que la persona quiere asociarse y firmó' });
      if (coinciden.size < MIN_PREGUNTAS_COINCIDEN) {
        return res.status(400).json({ error: `Para validar deben coincidir al menos ${MIN_PREGUNTAS_COINCIDEN} respuestas del protocolo` });
      }
    }
    if (data.resultado === 'no_coincide' && !data.observaciones) {
      return res.status(400).json({ error: 'Cuando las respuestas no coinciden, explica qué pasó en las observaciones' });
    }

    const { rows: [r] } = await pool.query(
      `INSERT INTO captacion_validaciones_voz
         (vinculacion_id, asesor_uuid, resultado, celular_llamado, preguntas, confirma_voluntad, grabada, observaciones, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, resultado, created_at`,
      [v.id, req.user.id, data.resultado, v.celular, JSON.stringify(data.preguntas), data.confirma_voluntad, data.grabada,
       data.observaciones ?? null, req.ip, req.headers['user-agent'] || null]
    );
    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, autor_uuid, ip, payload)
       VALUES ($1,$2,'validacion_voz','identidad','asesor',$3,$4,$5)`,
      [v.prospecto_id, v.id, req.user.id, req.ip, JSON.stringify({ resultado: data.resultado, validacion_id: r.id, grabada: data.grabada })]
    );
    res.status(201).json(r);
  } catch (err) { next(err); }
};

export const getExigenciaVoz = async (req, res, next) => {
  try {
    res.json({ exigida: await validacionVozExigida(), puede_configurar: await puedeConfigurar(req.user) });
  } catch (err) { next(err); }
};

export const actualizarExigenciaVoz = async (req, res, next) => {
  try {
    const { exigida } = exigenciaVozSchema.parse(req.body);
    await guardarExigencia(exigida, req.user.id);
    logger.info(`captacion: validación de voz ${exigida ? 'exigida' : 'opcional'} por ${req.user.id}`);
    res.json({ ok: true, exigida });
  } catch (err) { next(err); }
};

export const entregar = async (req, res, next) => {
  try {
    const { rows: [v] } = await pool.query(
      `SELECT v.id, v.estado,
              v.seccion_pep_at, v.seccion_firma_at, v.seccion_documentos_at, v.valor_aporte, v.origen_solicitud
         FROM captacion_vinculaciones v
         JOIN captacion_prospectos p ON p.id = v.prospecto_id
        WHERE v.id = $1 AND ($2::uuid IS NULL OR p.asesor_uuid = $2) AND v.is_active = true`,
      [req.params.id, ambitoAsesor(req)]   // el asesor entrega solo lo suyo; el admin puede entregar la de cualquiera
    );
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    if (v.estado === 'entregada') return res.status(400).json({ error: 'Ya fue entregada' });
    if (await subsanacionAbierta(v.id)) {
      return res.status(400).json({ error: 'La solicitud está devuelta a subsanar: falta que se corrija', code: 'SUBSANACION_PENDIENTE' });
    }
    if (!v.seccion_pep_at) return res.status(400).json({ error: 'Falta completar la sección PEP (SARLAFT)' });
    if (!v.seccion_firma_at) return res.status(400).json({ error: 'Falta la firma digital del asociado' });
    if (!v.seccion_documentos_at) return res.status(400).json({ error: 'Falta cargar la cédula' });
    if (v.valor_aporte === null) return res.status(400).json({ error: 'Falta definir el aporte del asociado' });
    if (await consultaListasExigida() && !(await consultaVigente(v.id))) {
      return res.status(400).json({ error: 'Falta la consulta en listas restrictivas validada por el Oficial de Cumplimiento', code: 'CONSULTA_LISTAS_REQUERIDA' });
    }
    // Las solicitudes en papel se firmaron en presencia del asesor: no aplica la llamada de validación de identidad
    if (v.origen_solicitud !== 'fisico' && await validacionVozExigida() && !(await validacionVigente(v.id))) {
      return res.status(400).json({ error: 'Falta la validación de identidad por llamada de voz', code: 'VALIDACION_VOZ_REQUERIDA' });
    }

    const { rows: [updated] } = await pool.query(
      `UPDATE captacion_vinculaciones
          SET estado = 'entregada', entregada_at = NOW(), entregada_por = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING id, estado, entregada_at`,
      [req.user.id, req.params.id]
    );

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, autor_tipo, autor_uuid, ip)
       SELECT prospecto_id, $1, 'entregada', 'asesor', $2, $3
         FROM captacion_vinculaciones WHERE id = $1`,
      [req.params.id, req.user.id, req.ip]
    );

    res.json(updated);
  } catch (err) { next(err); }
};

// ── Stand sessions (kiosko reutilizable) ─────────────────────────────────────

export const crearStandSession = async (req, res, next) => {
  try {
    const { empresa_codigo } = req.body;
    if (!empresa_codigo) return res.status(400).json({ error: 'empresa_codigo requerido' });

    const { rowCount: emp } = await pool.query(
      `SELECT 1 FROM empresas WHERE codigo = $1 AND is_active = true`, [empresa_codigo]
    );
    if (!emp) return res.status(400).json({ error: 'Empresa no encontrada o inactiva' });

    const token = crypto.randomBytes(16).toString('base64url');
    const expira_at = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    // Desactivar sesiones previas del mismo asesor+empresa
    await pool.query(
      `UPDATE captacion_stand_sessions SET is_active = false
        WHERE asesor_uuid = $1 AND empresa_codigo = $2 AND is_active = true`,
      [req.user.id, empresa_codigo]
    );

    await pool.query(
      `INSERT INTO captacion_stand_sessions (token, asesor_uuid, empresa_codigo, expira_at)
       VALUES ($1, $2, $3, $4)`,
      [token, req.user.id, empresa_codigo, expira_at]
    );

    res.status(201).json({ token, expira_at });
  } catch (err) { next(err); }
};

export const pubGetStandSession = async (req, res, next) => {
  try {
    const { rows: [s] } = await pool.query(
      `SELECT s.empresa_codigo, s.expira_at,
              e.nombre AS empresa_nombre,
              u.nombre AS asesor_nombre
         FROM captacion_stand_sessions s
         JOIN empresas e ON e.codigo = s.empresa_codigo
         JOIN global_usuarios u ON u.id = s.asesor_uuid
        WHERE s.token = $1 AND s.is_active = true`,
      [req.params.standToken]
    );
    if (!s) return res.status(404).json({ error: 'Sesión de stand no válida' });
    if (new Date(s.expira_at) < new Date()) return res.status(410).json({ error: 'Sesión expirada' });
    res.json({ ...s, asociados_empresa: await asociadosDeEmpresa(s.empresa_codigo), tarifas: TARIFAS });
  } catch (err) { next(err); }
};

// Prospecto sin identificar: lo crea el kiosco o el enlace público al tocar "Quiero asociarme".
// Usa el prefijo STAND_ y nombre vacío (ver SQL_SIN_IDENTIFICAR) hasta que la persona escribe sus datos.
const crearProspectoSinIdentificar = async ({ empresaCodigo, asesorUuid, ip, evento }) => {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  const placeholderCedula = 'STAND_' + crypto.randomBytes(6).toString('hex');

  const { rows: [p] } = await pool.query(
    `INSERT INTO captacion_prospectos
       (empresa_codigo, asesor_uuid, nombres, apellidos, cedula, celular,
        token_hash, token)
     VALUES ($1, $2, '', '', $3, '', $4, $5)
     RETURNING id, token`,
    [empresaCodigo, asesorUuid, placeholderCedula, hashToken(rawToken), rawToken]
  );

  await pool.query(
    `INSERT INTO captacion_eventos (prospecto_id, tipo, autor_tipo, ip)
     VALUES ($1, $2, 'prospecto', $3)`,
    [p.id, evento, ip]
  );
  return p;
};

export const pubIniciarDesdeStand = async (req, res, next) => {
  try {
    const { rows: [s] } = await pool.query(
      `SELECT asesor_uuid, empresa_codigo, expira_at
         FROM captacion_stand_sessions
        WHERE token = $1 AND is_active = true`,
      [req.params.standToken]
    );
    if (!s) return res.status(404).json({ error: 'Sesión de stand no válida' });
    if (new Date(s.expira_at) < new Date()) return res.status(410).json({ error: 'Sesión expirada' });

    const p = await crearProspectoSinIdentificar({
      empresaCodigo: s.empresa_codigo, asesorUuid: s.asesor_uuid, ip: req.ip, evento: 'stand_init',
    });

    res.status(201).json({ token: p.token });
  } catch (err) { next(err); }
};

// ── Enlace público de presentación (para compartir en grupos) ────────────────

// El asesor obtiene (o crea) su enlace para una empresa, o su enlace "libre" (`libre: true`): sin empresa fija, quien
// lo abre la elige como en /asociate. `renovar` genera uno nuevo e invalida el anterior (por si se filtró a quien no debía).
// Idempotente: pedirlo varias veces devuelve el mismo enlace. Ninguno caduca.
export const obtenerEnlacePublico = async (req, res, next) => {
  try {
    const { empresa_codigo, renovar, libre } = req.body || {};
    if (libre === true) {
      const { rows: [e] } = await pool.query(
        `INSERT INTO captacion_enlaces_publicos (token, asesor_uuid, empresa_codigo)
         VALUES ($1, $2, NULL)
         ON CONFLICT (asesor_uuid) WHERE empresa_codigo IS NULL DO UPDATE
           SET is_active = true,
               token = CASE WHEN $3::boolean THEN EXCLUDED.token ELSE captacion_enlaces_publicos.token END,
               updated_at = NOW()
         RETURNING token`,
        [crypto.randomBytes(16).toString('base64url'), req.user.id, renovar === true]
      );
      return res.json({ token: e.token });
    }
    if (!empresa_codigo) return res.status(400).json({ error: 'empresa_codigo requerido' });

    const { rowCount: emp } = await pool.query(
      `SELECT 1 FROM empresas WHERE codigo = $1 AND is_active = true`, [empresa_codigo]
    );
    if (!emp) return res.status(400).json({ error: 'Empresa no encontrada o inactiva' });

    const nuevoToken = crypto.randomBytes(16).toString('base64url');
    const { rows: [e] } = await pool.query(
      `INSERT INTO captacion_enlaces_publicos (token, asesor_uuid, empresa_codigo)
       VALUES ($1, $2, $3)
       ON CONFLICT (asesor_uuid, empresa_codigo) DO UPDATE
         SET is_active = true,
             token = CASE WHEN $4::boolean THEN EXCLUDED.token ELSE captacion_enlaces_publicos.token END,
             updated_at = NOW()
       RETURNING token`,
      [nuevoToken, req.user.id, empresa_codigo, renovar === true]
    );
    res.json({ token: e.token });
  } catch (err) { next(err); }
};

// :empresa = 'libre' desactiva el enlace sin empresa fija
export const desactivarEnlacePublico = async (req, res, next) => {
  try {
    const libre = req.params.empresa === 'libre';
    const { rowCount } = await pool.query(
      `UPDATE captacion_enlaces_publicos SET is_active = false, updated_at = NOW()
        WHERE asesor_uuid = $1 AND ${libre ? 'empresa_codigo IS NULL' : 'empresa_codigo = $2'} AND is_active = true`,
      libre ? [req.user.id] : [req.user.id, req.params.empresa]
    );
    if (!rowCount) return res.status(404).json({ error: 'No hay un enlace activo para esa empresa' });
    res.json({ ok: true });
  } catch (err) { next(err); }
};

const enlacePublicoVigente = async (token) => {
  const { rows: [e] } = await pool.query(
    `SELECT l.asesor_uuid, l.empresa_codigo, emp.nombre AS empresa_nombre, u.nombre AS asesor_nombre
       FROM captacion_enlaces_publicos l
       LEFT JOIN empresas emp ON emp.codigo = l.empresa_codigo
       JOIN global_usuarios u ON u.id = l.asesor_uuid
      WHERE l.token = $1 AND l.is_active = true AND u.is_active = true
        AND (l.empresa_codigo IS NULL OR emp.is_active = true)`,
    [token]
  );
  return e || null;
};

export const pubGetEnlace = async (req, res, next) => {
  try {
    const e = await enlacePublicoVigente(req.params.token);
    if (!e) return res.status(404).json({ error: 'Enlace no válido' });
    if (!e.empresa_codigo) {   // enlace libre: la persona elige su empresa
      const { rows: empresas } = await pool.query(`SELECT codigo, nombre FROM empresas WHERE is_active = true ORDER BY nombre ASC`);
      return res.json({ pide_empresa: true, empresas, asesor_nombre: e.asesor_nombre, tarifas: TARIFAS });
    }
    res.json({ empresa_nombre: e.empresa_nombre, asesor_nombre: e.asesor_nombre, asociados_empresa: await asociadosDeEmpresa(e.empresa_codigo), tarifas: TARIFAS });
  } catch (err) { next(err); }
};

// ── Página pública /asociate (enlace único y estático para el sitio web de la cooperativa) ──
// Muestra la presentación y el botón "Quiero asociarme". No hay asesor ni empresa previos: la persona elige
// su empresa y la solicitud se asigna al asesor definido en CAPTACION_ASESOR_WEB_UUID.
// El asesor se elige en la interfaz (captacion_config, clave 'web_asesor_uuid'), no en variables de entorno.
const CLAVE_ASESOR_WEB = 'web_asesor_uuid';

const asesorWebActivo = async () => {
  const { rows: [u] } = await pool.query(
    `SELECT u.id FROM captacion_config c
       JOIN global_usuarios u ON u.id::text = c.valor
      WHERE c.clave = $1 AND u.is_active = true`, [CLAVE_ASESOR_WEB]
  );
  return u?.id ?? null;
};

// Quien puede recibir solicitudes de la web: usuario activo con acceso de escritura a captación (o admin)
const SQL_PUEDE_CAPTAR = `
  u.is_active = true AND u.is_approved = true AND (
    u.rol = 'admin' OR EXISTS (
      SELECT 1 FROM permisos p
        JOIN modulos m ON m.id = p.modulo_id
        JOIN acciones a ON a.id = p.accion_id
       WHERE p.usuario_uuid = u.id AND m.nombre = 'captacion' AND a.nombre = 'WRITE'))`;

const puedeConfigurar = async (user) => {
  if (user.rol === 'admin') return true;
  const { rowCount } = await pool.query(
    `SELECT 1 FROM permisos p JOIN modulos m ON m.id = p.modulo_id JOIN acciones a ON a.id = p.accion_id
      WHERE p.usuario_uuid = $1 AND m.nombre = 'captacion' AND a.nombre = 'CONFIGURAR'`, [user.id]
  );
  return rowCount > 0;
};

// Panel "Página web" de la pestaña de prospectos: enlace para el sitio y asesor asignado
export const getConfigWeb = async (req, res, next) => {
  try {
    const [{ rows: [asesor] }, editable] = await Promise.all([
      pool.query(
        `SELECT u.id, u.nombre, u.email FROM captacion_config c
           JOIN global_usuarios u ON u.id::text = c.valor
          WHERE c.clave = $1 AND u.is_active = true`, [CLAVE_ASESOR_WEB]),
      puedeConfigurar(req.user),
    ]);
    let candidatos = [];
    let embudo = null;
    if (editable) {
      embudo = await embudoWeb();
      ({ rows: candidatos } = await pool.query(
        `SELECT u.id, u.nombre, u.email FROM global_usuarios u WHERE ${SQL_PUEDE_CAPTAR} ORDER BY u.nombre`));
    }
    res.json({
      enlace: `${env.FRONTEND_URL.replace(/\/$/, '')}/asociate`,
      asesor: asesor ?? null,
      puede_configurar: editable,
      candidatos,
      embudo,   // solo para quien puede configurar
    });
  } catch (err) { next(err); }
};

export const actualizarConfigWeb = async (req, res, next) => {
  try {
    const { asesor_uuid } = configWebSchema.parse(req.body);
    if (asesor_uuid) {
      const { rowCount } = await pool.query(`SELECT 1 FROM global_usuarios u WHERE u.id = $1 AND ${SQL_PUEDE_CAPTAR}`, [asesor_uuid]);
      if (!rowCount) return res.status(400).json({ error: 'Ese usuario no puede recibir solicitudes de captación (debe estar activo y tener permiso de escritura en el módulo)' });
    }
    await pool.query(
      `INSERT INTO captacion_config (clave, valor, actualizado_por) VALUES ($1, $2, $3)
       ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_por = EXCLUDED.actualizado_por, updated_at = NOW()`,
      [CLAVE_ASESOR_WEB, asesor_uuid, req.user.id]
    );
    logger.info(`captacion: asesor de la página web ${asesor_uuid ? `= ${asesor_uuid}` : 'quitado'} por ${req.user.id}`);
    res.json({ ok: true });
  } catch (err) { next(err); }
};

export const pubGetWeb = async (_req, res, next) => {
  try {
    if (!(await asesorWebActivo())) return res.json({ disponible: false });
    const { rows: empresas } = await pool.query(
      `SELECT codigo, nombre FROM empresas WHERE is_active = true ORDER BY nombre ASC`
    );
    res.json({ disponible: true, empresas, tarifas: TARIFAS });
  } catch (err) { next(err); }
};

// Cuenta una visita a /asociate (una por sesión del navegador; el frontend lo pide una sola vez). Solo la fecha.
export const pubVisitaWeb = async (_req, res, next) => {
  try {
    await pool.query('INSERT INTO captacion_web_visitas DEFAULT VALUES');
    res.status(204).end();
  } catch (err) { next(err); }
};

// Embudo de los últimos 30 días de la página web: visitas -> inician -> se identifican -> firman
const embudoWeb = async (dias = 30) => {
  const [{ rows: [v] }, { rows: [e] }] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS visitas FROM captacion_web_visitas WHERE created_at > NOW() - make_interval(days => $1)`, [dias]),
    pool.query(
      `SELECT COUNT(*)::int AS iniciados,
              COUNT(*) FILTER (WHERE NOT (p.cedula LIKE 'STAND_%' AND p.nombres = ''))::int AS identificados,
              COUNT(*) FILTER (WHERE vi.seccion_firma_at IS NOT NULL)::int AS firmados
         FROM captacion_eventos ev
         JOIN captacion_prospectos p ON p.id = ev.prospecto_id
         LEFT JOIN captacion_vinculaciones vi ON vi.prospecto_id = p.id AND vi.is_active = true
        WHERE ev.tipo = 'web_init' AND ev.created_at > NOW() - make_interval(days => $1)`, [dias]),
  ]);
  return { dias, ...v, ...e };
};

export const pubIniciarDesdeWeb = async (req, res, next) => {
  try {
    const { empresa_codigo } = iniciarWebSchema.parse(req.body);
    const asesorUuid = await asesorWebActivo();
    if (!asesorUuid) return res.status(503).json({ error: 'Este servicio no está disponible por ahora', code: 'WEB_NO_DISPONIBLE' });

    const { rows: [e] } = await pool.query(
      `SELECT codigo FROM empresas WHERE codigo = $1 AND is_active = true`, [empresa_codigo]
    );
    if (!e) return res.status(400).json({ error: 'Elige tu empresa de la lista' });

    const p = await crearProspectoSinIdentificar({ empresaCodigo: e.codigo, asesorUuid, ip: req.ip, evento: 'web_init' });
    res.status(201).json({ token: p.token });
  } catch (err) { next(err); }
};

// ── Cifras y tarifas para la página pública de inicio (landing) ──────────────────────────
// Solo agregados: cuántos asociados activos y cuántas empresas con asociados, más las tarifas oficiales.
let sitioCache = { hasta: 0, datos: null };

export const pubSitio = async (_req, res, next) => {
  try {
    if (Date.now() > sitioCache.hasta || env.NODE_ENV === 'test') {
      const { rows: [r] } = await pool.query(
        `SELECT COUNT(*)::int AS asociados, COUNT(DISTINCT empresa_dsto)::int AS empresas
           FROM asociados WHERE is_active = true`);
      sitioCache = { hasta: Date.now() + 10 * 60 * 1000, datos: { asociados: r.asociados, empresas: r.empresas } };
    }
    res.set('Cache-Control', 'public, max-age=600');
    res.json({ ...sitioCache.datos, tarifas: TARIFAS });
  } catch (err) { next(err); }
};

// ── Presencia de la cooperativa (diapositiva del mapa en la presentación pública) ──
// Solo los nombres de las ciudades donde hay asociados activos: sin conteos ni datos de personas.
// Se cachea unos minutos porque es público y la lista casi no cambia.
let presenciaCache = { hasta: 0, ciudades: [] };

export const pubPresencia = async (_req, res, next) => {
  try {
    if (Date.now() > presenciaCache.hasta || env.NODE_ENV === 'test') {
      const { rows } = await pool.query(
        `SELECT DISTINCT UPPER(TRIM(ciudad)) AS ciudad FROM asociados
          WHERE is_active = true AND ciudad IS NOT NULL AND TRIM(ciudad) <> '' ORDER BY 1`
      );
      presenciaCache = { hasta: Date.now() + 10 * 60 * 1000, ciudades: rows.map((r) => r.ciudad) };
    }
    res.set('Cache-Control', 'public, max-age=600');
    res.json({ ciudades: presenciaCache.ciudades });
  } catch (err) { next(err); }
};

export const pubIniciarDesdeEnlace = async (req, res, next) => {
  try {
    const e = await enlacePublicoVigente(req.params.token);
    if (!e) return res.status(404).json({ error: 'Enlace no válido' });

    let empresaCodigo = e.empresa_codigo;
    if (!empresaCodigo) {   // enlace libre: la empresa la elige la persona
      const { empresa_codigo } = iniciarWebSchema.parse(req.body);
      const { rows: [emp] } = await pool.query(`SELECT codigo FROM empresas WHERE codigo = $1 AND is_active = true`, [empresa_codigo]);
      if (!emp) return res.status(400).json({ error: 'Elige tu empresa de la lista' });
      empresaCodigo = emp.codigo;
    }
    const p = await crearProspectoSinIdentificar({
      empresaCodigo, asesorUuid: e.asesor_uuid, ip: req.ip, evento: 'enlace_publico_init',
    });
    res.status(201).json({ token: p.token });
  } catch (err) { next(err); }
};

export const initStandProspecto = async (req, res, next) => {
  try {
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(rawToken);
    const placeholderCedula = 'STAND_' + crypto.randomBytes(6).toString('hex');

    const { rows: [p] } = await pool.query(
      `INSERT INTO captacion_prospectos
         (empresa_codigo, asesor_uuid, nombres, apellidos, cedula, celular,
          token_hash, token)
       VALUES ($1, $2, '', '', $3, '',
               $4, $5)
       RETURNING id, token`,
      [req.body.empresa_codigo || null, req.user.id, placeholderCedula, tokenHash, rawToken]
    );

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, tipo, autor_tipo, autor_uuid, ip)
       VALUES ($1, 'stand_init', 'asesor', $2, $3)`,
      [p.id, req.user.id, req.ip]
    );

    res.status(201).json({ token: p.token });
  } catch (err) { next(err); }
};

export const getValoresAsesor = async (req, res, next) => {
  try {
    // Cada asesor solo ve sus propios valores (antes bastaba con cambiar el UUID de la URL)
    if (req.params.uuid !== req.user.id && req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo puedes ver tus propios valores' });
    const asesor_uuid = req.params.uuid;
    const { rows: [r] } = await pool.query(`
      SELECT
        COUNT(p.id)                                              AS total_prospectos,
        COUNT(v.id) FILTER (WHERE v.is_active = true)           AS vinculados,
        COUNT(v.id) FILTER (WHERE v.estado = 'entregada')       AS entregados,
        COUNT(v.id) FILTER (
          WHERE v.is_active = true AND v.estado NOT IN ('entregada'))  AS en_proceso,
        COUNT(p.id) FILTER (
          WHERE p.created_at >= NOW() - INTERVAL '30 days')     AS ultimo_mes
        FROM captacion_prospectos p
        LEFT JOIN captacion_vinculaciones v ON v.prospecto_id = p.id
       WHERE p.asesor_uuid = $1 AND p.is_active = true
         AND NOT ${SQL_SIN_IDENTIFICAR}  -- los del stand sin identificar no son prospectos reales
    `, [asesor_uuid]);

    const vinculados = Number(r.vinculados);
    const total      = Number(r.total_prospectos);
    res.json({
      total_prospectos: total,
      vinculados,
      entregados:       Number(r.entregados),
      en_proceso:       Number(r.en_proceso),
      ultimo_mes:       Number(r.ultimo_mes),
      tasa_conversion:  total > 0 ? Math.round((vinculados / total) * 100) : 0,
    });
  } catch (err) { next(err); }
};

// ── Endpoints públicos (sin auth — token como sesión) ─────────────────────────

const resolverToken = async (rawToken) => {
  const { rows: [p] } = await pool.query(
    `SELECT id, nombres, apellidos, cedula, celular, correo, empresa_codigo,
            estado, ping_count, token_expira_at, asesor_uuid, habeas_data_origen
       FROM captacion_prospectos
      WHERE token = $1 AND is_active = true`,
    [rawToken]
  );
  return p || null;
};

// Construye respuesta 410 con info suficiente para que el frontend genere un CTA accionable
const respuesta410 = async (p, req, res) => {
  await pool.query(
    `INSERT INTO captacion_eventos (prospecto_id, tipo, autor_tipo, ip)
     VALUES ($1,'link_expirado_visto','prospecto',$2)
     ON CONFLICT DO NOTHING`,
    [p.id, req.ip]
  ).catch(() => {});

  const { rows: [asesor] } = await pool.query(
    `SELECT nombre FROM global_usuarios WHERE id = $1`, [p.asesor_uuid]
  ).catch(() => ({ rows: [] }));

  return res.status(410).json({
    error       : 'Este link ha expirado',
    nombres     : p.nombres,
    asesor_nombre: asesor?.nombre || null,
    empresa_codigo: p.empresa_codigo,
  });
};

// Prueba social: cuántos compañeros de la misma empresa ya son asociados. Es un dato agregado (sin nombres) y solo
// se muestra si son al menos MIN_PRUEBA_SOCIAL, para no exponer conteos pequeños.
const MIN_PRUEBA_SOCIAL = 10;
const asociadosDeEmpresa = async (empresaCodigo) => {
  if (!empresaCodigo) return null;
  const { rows: [r] } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM asociados WHERE empresa_dsto = $1 AND is_active = true`, [empresaCodigo]);
  return r.n >= MIN_PRUEBA_SOCIAL ? r.n : null;
};

// Lo que la persona debe ver de una devolución abierta: qué se le pidió, por qué y qué le falta
const estadoSubsanacionPublico = async (prospectoId) => {
  const { rows: [v] } = await pool.query(`SELECT id FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [prospectoId]);
  const s = v ? await subsanacionAbierta(v.id) : null;
  if (!s) return null;
  return { items: s.items, motivo: s.motivo, created_at: s.created_at, pendientes: await pendientesSubsanacion(v.id, s) };
};

export const pubGetProspecto = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido o expirado' });
    if (new Date(p.token_expira_at) < new Date()) return respuesta410(p, req, res);

    // Devolver solo info pública + datos del asesor para WhatsApp flotante
    const { rows: [asesor] } = await pool.query(
      `SELECT nombre, avatar_url FROM global_usuarios WHERE id = $1`,
      [p.asesor_uuid]
    );

    const { rows: [v] } = await pool.query(
      `SELECT estado, seccion_personal_at, seccion_laboral_at, seccion_pep_at,
              seccion_financiera_at, seccion_aportes_at, seccion_beneficiarios_at, seccion_referencias_at,
              seccion_documentos_at, seccion_firma_at
         FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`,
      [p.id]
    );

    res.json({
      nombres: p.nombres,
      apellidos: p.apellidos,
      // En modo stand la cédula es un placeholder hasta que la persona la escribe; el frontend
      // solo necesita saber si debe pedirla (nunca se devuelve la cédula real).
      requiere_identificacion: p.cedula?.startsWith('STAND_') ?? false,
      // Datos de contacto que aún no tenemos (p. ej. prospectos creados desde el stand)
      requiere_celular: !p.celular,
      requiere_correo:  !p.correo,
      empresa_codigo: p.empresa_codigo,
      asociados_empresa: await asociadosDeEmpresa(p.empresa_codigo),
      asesor: { nombre: asesor?.nombre, avatar_url: asesor?.avatar_url, celular: p.celular },
      version_consentimiento: VERSION_CONSENTIMIENTO,
      version_firma_electronica: VERSION_FIRMA_ELECTRONICA,
      // La autorización de datos la tiene que aceptar la propia persona antes de darnos los suyos
      requiere_habeas_data: p.habeas_data_origen !== 'titular',
      version_habeas_data: VERSION_HABEAS_DATA,
      tarifas: TARIFAS,
      vinculacion: v || null,
      subsanacion: await estadoSubsanacionPublico(p.id),
    });
  } catch (err) { next(err); }
};

export const pubPing = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });

    await pool.query(
      `UPDATE captacion_prospectos
          SET ping_count = ping_count + 1, ping_at = NOW(),
              estado = CASE WHEN estado IN ('nuevo','link_enviado') THEN 'vio_landing' ELSE estado END,
              updated_at = NOW()
        WHERE id = $1`,
      [p.id]
    );

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, tipo, autor_tipo, ip, user_agent)
       VALUES ($1, 'ping', 'prospecto', $2, $3)`,
      [p.id, req.ip, req.headers['user-agent'] || null]
    );

    res.json({ ok: true });
  } catch (err) { next(err); }
};

// ── Autorización de tratamiento de datos (Ley 1581 de 2012) ─────────────────
// La acepta el titular en el formulario. Queda con versión del texto, fecha, IP y user agent.
export const pubAceptarHabeasData = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });
    const data = habeasDataSchema.parse(req.body);
    if (data.version !== VERSION_HABEAS_DATA) {
      return res.status(400).json({ error: 'El texto de la autorización cambió: recarga el formulario', code: 'HABEAS_VERSION' });
    }
    if (p.habeas_data_origen === 'titular') return res.json({ ok: true, ya_aceptada: true });

    await pool.query(
      `UPDATE captacion_prospectos
          SET acepta_habeas_data = true, habeas_data_at = NOW(), habeas_data_origen = 'titular',
              habeas_data_version = $2, habeas_data_ip = $3, updated_at = NOW()
        WHERE id = $1`,
      [p.id, data.version, req.ip]
    );
    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, tipo, autor_tipo, ip, user_agent, payload)
       VALUES ($1,'habeas_data_aceptado','prospecto',$2,$3,$4)`,
      [p.id, req.ip, req.headers['user-agent'] || null, JSON.stringify({ version: data.version })]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
};

// Middleware: no se reciben datos personales ni se firma mientras el titular no haya aceptado la autorización
export const exigirHabeasData = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });
    if (p.habeas_data_origen !== 'titular') {
      return res.status(403).json({ error: 'Antes de continuar debes aceptar la autorización de tratamiento de datos', code: 'HABEAS_DATA_REQUERIDO' });
    }
    next();
  } catch (err) { next(err); }
};

// ── Verificación de identidad para firmar: OTP por correo ─────────────────────
const OTP_MINUTOS = 10;
const OTP_MAX_INTENTOS = 5;
const OTP_ESPERA_SEG = 60;       // mínimo entre dos envíos
const OTP_MAX_POR_HORA = 5;
const STEPUP_MINUTOS = 30;

// Clave propia del step-up (derivada de JWT_SECRET): una rotación o filtración de la sesión no toca esta evidencia
const CLAVE_STEPUP = crypto.createHmac('sha256', env.JWT_SECRET).update('captacion-stepup-v1').digest('hex');
const hashOtp = (pid, codigo) => crypto.createHash('sha256').update(`${pid}:${codigo}:${env.JWT_SECRET}`).digest('hex');
const hashCorreo = (c) => crypto.createHash('sha256').update(String(c).trim().toLowerCase()).digest('hex');
const enmascararCorreo = (c) => {
  const [u, d] = String(c).split('@');
  return `${u.slice(0, 2)}${'*'.repeat(Math.max(u.length - 2, 2))}@${d}`;
};

export const pubSolicitarOtp = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });
    if (await solicitudEntregada(p.id)) return res.status(400).json(ERROR_ENTREGADA);
    if (!p.correo) {
      return res.status(400).json({ error: 'Necesitamos tu correo electrónico para enviarte el código. Complétalo en tus datos personales.', code: 'CORREO_REQUERIDO' });
    }

    const { rows: [rec] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int AS ultima_hora,
              EXTRACT(EPOCH FROM (NOW() - MAX(created_at)))::int AS seg_desde_ultimo
         FROM captacion_otp WHERE prospecto_id = $1`, [p.id]
    );
    if (rec.seg_desde_ultimo !== null && rec.seg_desde_ultimo < OTP_ESPERA_SEG) {
      return res.status(429).json({ error: `Espera ${OTP_ESPERA_SEG - rec.seg_desde_ultimo} segundos para pedir otro código.`, espera: OTP_ESPERA_SEG - rec.seg_desde_ultimo });
    }
    if (rec.ultima_hora >= OTP_MAX_POR_HORA) {
      return res.status(429).json({ error: 'Pediste demasiados códigos. Inténtalo de nuevo en una hora.' });
    }

    const codigo = String(crypto.randomInt(0, 1000000)).padStart(6, '0');

    // Primero se envía y solo si sale bien se guarda: si el correo está caído, el código anterior
    // sigue vigente y el intento fallido no gasta la espera ni el límite por hora.
    try {
      await enviarCodigoFirma(p.correo, p.nombres || 'asociado', codigo, OTP_MINUTOS);
    } catch (err) {
      if (err.code === 'EMAIL_SUPRIMIDO') {
        return res.status(400).json({ error: 'Ese correo no puede recibir mensajes (rebotó antes). Revisa que esté bien escrito o usa otro.', code: 'CORREO_INVALIDO' });
      }
      logger.error(`captacion: no se pudo enviar el código de firma a prospecto ${p.id}: ${err.message}`);
      await pool.query(
        `INSERT INTO captacion_eventos (prospecto_id, tipo, autor_tipo, ip, payload) VALUES ($1,'otp_envio_fallido','sistema',$2,$3)`,
        [p.id, req.ip, JSON.stringify({ canal: 'correo', error: String(err.message).slice(0, 200) })]
      ).catch(() => {});
      return res.status(502).json({ error: 'No pudimos enviar el correo en este momento. Tu avance está guardado: inténtalo de nuevo en unos minutos.', code: 'CORREO_NO_ENVIADO' });
    }

    // Un código nuevo invalida los anteriores
    await pool.query(`UPDATE captacion_otp SET usado_at = NOW() WHERE prospecto_id = $1 AND usado_at IS NULL`, [p.id]);
    await pool.query(
      `INSERT INTO captacion_otp (prospecto_id, canal, destino, codigo_hash, expira_at, ip, user_agent)
       VALUES ($1,'correo',$2,$3, NOW() + make_interval(mins => $4), $5, $6)`,
      [p.id, p.correo, hashOtp(p.id, codigo), OTP_MINUTOS, req.ip, req.headers['user-agent'] || null]
    );

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, tipo, autor_tipo, ip, payload) VALUES ($1,'otp_enviado','prospecto',$2,$3)`,
      [p.id, req.ip, JSON.stringify({ canal: 'correo', destino: enmascararCorreo(p.correo) })]
    );
    res.json({ ok: true, correo: enmascararCorreo(p.correo), expira_min: OTP_MINUTOS, espera: OTP_ESPERA_SEG });
  } catch (err) { next(err); }
};

export const pubStepUp = async (req, res, next) => {
  try {
    const { codigo } = stepUpSchema.parse(req.body);
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });

    const { rows: [otp] } = await pool.query(
      `SELECT id, codigo_hash, destino, intentos FROM captacion_otp
        WHERE prospecto_id = $1 AND usado_at IS NULL AND expira_at > NOW()
        ORDER BY created_at DESC LIMIT 1`, [p.id]
    );
    if (!otp || otp.intentos >= OTP_MAX_INTENTOS) {
      return res.status(403).json({ error: 'El código venció o ya no es válido. Pide uno nuevo.', code: 'OTP_NO_VIGENTE' });
    }
    // El código debe seguir yendo al mismo correo del prospecto (si lo cambió, no vale)
    if (hashCorreo(otp.destino) !== hashCorreo(p.correo || '')) {
      return res.status(403).json({ error: 'Tu correo cambió. Pide un código nuevo.', code: 'OTP_NO_VIGENTE' });
    }

    const a = Buffer.from(hashOtp(p.id, codigo));
    const b = Buffer.from(otp.codigo_hash);
    if (!crypto.timingSafeEqual(a, b)) {
      await pool.query(`UPDATE captacion_otp SET intentos = intentos + 1 WHERE id = $1`, [otp.id]);
      await pool.query(
        `INSERT INTO captacion_eventos (prospecto_id, tipo, autor_tipo, ip) VALUES ($1,'stepup_fallido','prospecto',$2)`,
        [p.id, req.ip]
      );
      const restan = OTP_MAX_INTENTOS - otp.intentos - 1;
      return res.status(403).json({
        error: restan > 0 ? `Código incorrecto. Te quedan ${restan} intentos.` : 'Código incorrecto. Pide uno nuevo.',
        code: restan > 0 ? 'OTP_INCORRECTO' : 'OTP_NO_VIGENTE',
      });
    }

    await pool.query(`UPDATE captacion_otp SET usado_at = NOW() WHERE id = $1`, [otp.id]);

    // JWT de corta duración que autoriza la firma; lleva el canal verificado como evidencia
    const enmascarado = enmascararCorreo(otp.destino);
    const stepupToken = jwt.sign(
      { sub: 'captacion_stepup', pid: p.id, canal: 'correo', destino: enmascarado, otp: otp.id, c: hashCorreo(otp.destino) },
      CLAVE_STEPUP,
      { expiresIn: `${STEPUP_MINUTOS}m` }
    );

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, tipo, autor_tipo, ip, payload) VALUES ($1,'stepup_ok','prospecto',$2,$3)`,
      [p.id, req.ip, JSON.stringify({ canal: 'correo', destino: enmascarado, otp_id: otp.id })]
    );

    res.json({ ok: true, stepup_token: stepupToken });
  } catch (err) { next(err); }
};

// ── Auditoría de cambios posteriores a la firma ──────────────────────────────
// La subsanación (completar o corregir datos tras firmar) se permite sin volver a firmar, pero cada
// cambio queda registrado: quién, cuándo, desde dónde y qué campos tocó (solo nombres, no valores,
// para no duplicar datos personales). El PDF sellado conserva lo que el asociado firmó.
export const auditarCambioPosteriorAFirma = (autorTipo) => async (req, res, next) => {
  try {
    const partes = req.path.split('/').filter(Boolean);
    const ultima = partes[partes.length - 1];
    if (req.method === 'GET' || ultima === 'solicitar') return next();

    const { rows: [v] } = autorTipo === 'prospecto'
      ? await pool.query(
          `SELECT v.id, v.prospecto_id, v.seccion_firma_at FROM captacion_vinculaciones v
             JOIN captacion_prospectos p ON p.id = v.prospecto_id
            WHERE p.token = $1 AND v.is_active = true`, [req.params.token])
      : await pool.query(
          `SELECT v.id, v.prospecto_id, v.seccion_firma_at FROM captacion_vinculaciones v
             JOIN captacion_prospectos p ON p.id = v.prospecto_id
            WHERE v.id = $1 AND p.asesor_uuid = $2 AND v.is_active = true`, [req.params.id, req.user.id]);
    if (!v?.seccion_firma_at) return next();

    const seccion = partes.slice(2).filter((x) => x !== 'confirmar').join('/') || partes[1];
    const campos = req.body && typeof req.body === 'object' ? Object.keys(req.body).filter((k) => k !== 'key') : [];
    // Se registra justo antes de responder (así el evento existe cuando el cliente recibe el 2xx)
    const responder = res.json.bind(res);
    res.json = async (cuerpo) => {
      if (res.statusCode < 300) {
        await pool.query(
          `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, autor_uuid, ip, payload)
           VALUES ($1,$2,'cambio_posterior_a_firma',$3,$4,$5,$6,$7)`,
          [v.prospecto_id, v.id, seccion, autorTipo, autorTipo === 'prospecto' ? null : req.user.id, req.ip,
           JSON.stringify({ campos, firmada_at: v.seccion_firma_at })]
        ).catch((err) => logger.error(`captacion: no se pudo auditar cambio posterior a la firma: ${err.message}`));
      }
      return responder(cuerpo);
    };
    next();
  } catch (err) { next(err); }
};

// Guardar sección (PUT idempotente)
const guardarSeccion = (seccion, schema, camposExtra) => async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });
    if (new Date(p.token_expira_at) < new Date()) return respuesta410(p, req, res);
    if (await solicitudEntregada(p.id)) return res.status(400).json(ERROR_ENTREGADA);

    const data = schema.parse(req.body);

    // Asegurar que la vinculación exista (crea si no)
    let { rows: [v] } = await pool.query(
      `SELECT id FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`,
      [p.id]
    );
    if (!v) {
      const { rows: [nv] } = await pool.query(
        `INSERT INTO captacion_vinculaciones (prospecto_id) VALUES ($1) RETURNING id`,
        [p.id]
      );
      v = nv;
      await pool.query(
        `UPDATE captacion_prospectos SET estado = CASE WHEN estado = 'vio_landing' THEN 'interesado' ELSE estado END,
         updated_at = NOW() WHERE id = $1`,
        [p.id]
      );
    }

    // Construir SET dinámico con los campos de la sección
    const campos = { ...data, ...camposExtra(v.id) };
    const sets = Object.keys(campos).map((k, i) => `${k} = $${i + 2}`);
    // pg serializa los arrays JS como arrays de Postgres, no como JSON: las columnas jsonb
    // (p. ej. moneda_extranjera_detalle) necesitan el valor ya convertido a texto JSON.
    const valores = Object.values(campos).map(x => (x !== null && typeof x === 'object' ? JSON.stringify(x) : x));
    await pool.query(
      `UPDATE captacion_vinculaciones SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`,
      [v.id, ...valores]
    );

    await pool.query(
      `INSERT INTO captacion_eventos
         (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, ip, user_agent)
       VALUES ($1,$2,'seccion_guardada',$3,'prospecto',$4,$5)`,
      [p.id, v.id, seccion, req.ip, req.headers['user-agent'] || null]
    );

    res.json({ ok: true, vinculacion_id: v.id });
  } catch (err) { next(err); }
};

export const pubSeccionPersonal = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });
    if (new Date(p.token_expira_at) < new Date()) return respuesta410(p, req, res);
    if (await solicitudEntregada(p.id)) return res.status(400).json(ERROR_ENTREGADA);

    const data = seccionPersonalSchema.parse(req.body);
    const { nombres, apellidos, cedula, celular, correo, ...vinculacionData } = data;

    // Firmada la solicitud, los datos de identidad y contacto quedan como se firmaron: corregirlos lo hace el asesor y queda auditado
    const { rows: [firmada] } = await pool.query(
      `SELECT id FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true AND seccion_firma_at IS NOT NULL`, [p.id]);
    const distintos = Object.entries({ nombres, apellidos, cedula, celular, correo }).filter(([k, val]) => val && val !== p[k]);
    const subsDatos = firmada ? await subsanacionAbierta(firmada.id) : null;
    if (firmada && distintos.length && !subsDatos?.items.includes('datos')) {
      return res.status(409).json({ error: 'Tu solicitud ya está firmada: tus datos de identidad y contacto no se pueden cambiar desde aquí. Escríbele a tu asesor.', code: 'DATOS_FIRMADOS' });
    }

    // Info básica y contacto viven en captacion_prospectos (en stand llegan aquí por primera vez)
    if (nombres || apellidos || cedula || celular || correo) {
      const campos = [];
      const vals   = [];
      if (nombres)   { campos.push(`nombres   = $${vals.length + 2}`); vals.push(nombres); }
      if (apellidos) { campos.push(`apellidos = $${vals.length + 2}`); vals.push(apellidos); }
      if (cedula)    { campos.push(`cedula    = $${vals.length + 2}`); vals.push(cedula); }
      if (celular)   { campos.push(`celular   = $${vals.length + 2}`); vals.push(celular); }
      if (correo)    { campos.push(`correo    = $${vals.length + 2}`); vals.push(correo); }
      await pool.query(
        `UPDATE captacion_prospectos SET ${campos.join(', ')}, updated_at = NOW() WHERE id = $1`,
        [p.id, ...vals]
      );
    }

    // Asegurar vinculación
    let { rows: [v] } = await pool.query(
      `SELECT id FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [p.id]
    );
    if (!v) {
      const { rows: [nv] } = await pool.query(
        `INSERT INTO captacion_vinculaciones (prospecto_id) VALUES ($1) RETURNING id`, [p.id]
      );
      v = nv;
      await pool.query(
        `UPDATE captacion_prospectos SET estado = CASE WHEN estado = 'vio_landing' THEN 'interesado' ELSE estado END, updated_at = NOW() WHERE id = $1`,
        [p.id]
      );
    }

    const campos = { ...vinculacionData, seccion_personal_at: new Date().toISOString(), seccion_personal_autor: 'prospecto' };
    const sets   = Object.keys(campos).map((k, i) => `${k} = $${i + 2}`);
    await pool.query(
      `UPDATE captacion_vinculaciones SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`,
      [v.id, ...Object.values(campos)]
    );

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, ip, user_agent)
       VALUES ($1,$2,'seccion_guardada','personal','prospecto',$3,$4)`,
      [p.id, v.id, req.ip, req.headers['user-agent'] || null]
    );

    res.json({ ok: true, vinculacion_id: v.id });
  } catch (err) { next(err); }
};

export const pubSeccionLaboral = guardarSeccion('laboral', seccionLaboralSchema, () => ({
  seccion_laboral_at   : new Date().toISOString(),
  seccion_laboral_autor: 'prospecto',
}));

export const pubSeccionPep = guardarSeccion('pep', seccionPepSchema, (vid) => ({
  seccion_pep_at   : new Date().toISOString(),
  seccion_pep_autor: 'prospecto',
  debida_diligencia_ampliada: false, // se recalcula abajo
}));

// PEP tiene lógica especial: marcar debida_diligencia_ampliada
export const pubSeccionPepHandler = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });
    if (new Date(p.token_expira_at) < new Date()) return respuesta410(p, req, res);
    if (await solicitudEntregada(p.id)) return res.status(400).json(ERROR_ENTREGADA);

    const data = seccionPepSchema.parse(req.body);
    const esAmpliada = data.pep_maneja_recursos_publicos || data.pep_reconocimiento_publico ||
                       data.pep_poder_publico || data.pep_vinculo_expuesto;

    let { rows: [v] } = await pool.query(
      `SELECT id FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`,
      [p.id]
    );
    if (!v) {
      const { rows: [nv] } = await pool.query(
        `INSERT INTO captacion_vinculaciones (prospecto_id) VALUES ($1) RETURNING id`, [p.id]
      );
      v = nv;
    }

    await pool.query(
      `UPDATE captacion_vinculaciones SET
         pep_maneja_recursos_publicos = $1, pep_reconocimiento_publico = $2,
         pep_poder_publico = $3, pep_vinculo_expuesto = $4,
         debida_diligencia_ampliada = $5,
         seccion_pep_at = NOW(), seccion_pep_autor = 'prospecto',
         updated_at = NOW()
       WHERE id = $6`,
      [data.pep_maneja_recursos_publicos, data.pep_reconocimiento_publico,
       data.pep_poder_publico, data.pep_vinculo_expuesto, esAmpliada, v.id]
    );

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, ip)
       VALUES ($1,$2,'seccion_guardada','pep','prospecto',$3)`,
      [p.id, v.id, req.ip]
    );

    res.json({ ok: true, debida_diligencia_ampliada: esAmpliada });
  } catch (err) { next(err); }
};

export const pubSeccionFinanciera = guardarSeccion('financiera', seccionFinancieraSchema, () => ({
  seccion_financiera_at   : new Date().toISOString(),
  seccion_financiera_autor: 'prospecto',
}));

// Guarda la elección de aportes. Los precios de fondo, seguro, bono y cuota los fija el servidor.
// `autor` queda en seccion_aportes_autor: 'prospecto' (lo eligió el asociado) o 'asesor' (lo definió el asesor).
export const aplicarAportes = async ({ vinculacionId, datos, autor }) => {
  const seguro = datos.seguro_vida ? TARIFAS.seguro_vida : 0;
  const bono   = datos.bono_sorteo ? TARIFAS.bono_sorteo : 0;

  await pool.query(
    `UPDATE captacion_vinculaciones SET
       valor_aporte = $1, periodicidad_descuento = $2,
       valor_fondo_bienestar = $3,
       seguro_vida_activo = $4, valor_seguro_vida = $5,
       bono_sorteo_activo = $6, valor_bono_sorteo = $7,
       cuota_admision = COALESCE(cuota_admision, $8),
       seccion_aportes_at = NOW(), seccion_aportes_autor = $10, updated_at = NOW()
     WHERE id = $9`,
    [datos.valor_aporte, datos.periodicidad, TARIFAS.fondo_bienestar,
     datos.seguro_vida, seguro, datos.bono_sorteo, bono, TARIFAS.cuota_admision, vinculacionId, autor]
  );
  return datos.valor_aporte + TARIFAS.fondo_bienestar + seguro + bono;
};

const resumenAportes = (d) => JSON.stringify({
  valor_aporte: d.valor_aporte, periodicidad: d.periodicidad, seguro_vida: d.seguro_vida, bono_sorteo: d.bono_sorteo,
});

export const pubSeccionAportes = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });
    if (new Date(p.token_expira_at) < new Date()) return respuesta410(p, req, res);

    const d = seccionAportesSchema.parse(req.body);

    let { rows: [v] } = await pool.query(
      `SELECT id, estado FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [p.id]
    );
    if (!v) {
      const { rows: [nv] } = await pool.query(
        `INSERT INTO captacion_vinculaciones (prospecto_id) VALUES ($1) RETURNING id, estado`, [p.id]
      );
      v = nv;
    }
    if (v.estado === 'entregada') return res.status(400).json(ERROR_ENTREGADA);

    const totalMensual = await aplicarAportes({ vinculacionId: v.id, datos: d, autor: 'prospecto' });

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, ip, payload)
       VALUES ($1,$2,'seccion_guardada','aportes','prospecto',$3,$4)`,
      [p.id, v.id, req.ip, resumenAportes(d)]
    );

    res.json({ ok: true, total_mensual: totalMensual });
  } catch (err) { next(err); }
};

// El asesor define o corrige los aportes desde el panel (p. ej. solicitudes firmadas antes de que
// existiera este paso). Queda registrado que lo hizo el asesor.
export const asesorSeccionAportes = async (req, res, next) => {
  try {
    const d = seccionAportesSchema.parse(req.body);
    const v = await vinculacionDelAsesor(req.params.id, req.user.id);
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    if (v.estado === 'entregada') return res.status(400).json(ERROR_ENTREGADA);

    const totalMensual = await aplicarAportes({ vinculacionId: v.id, datos: d, autor: 'asesor' });

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, autor_uuid, ip, payload)
       VALUES ($1,$2,'aportes_definidos_asesor','aportes','asesor',$3,$4,$5)`,
      [v.prospecto_id, v.id, req.user.id, req.ip, resumenAportes(d)]
    );

    res.json({ ok: true, total_mensual: totalMensual });
  } catch (err) { next(err); }
};

export const pubSeccionBeneficiarios = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });
    if (new Date(p.token_expira_at) < new Date()) return respuesta410(p, req, res);
    if (await solicitudEntregada(p.id)) return res.status(400).json(ERROR_ENTREGADA);

    const { beneficiarios } = seccionBeneficiariosSchema.parse(req.body);
    const total = beneficiarios.reduce((s, b) => s + b.porcentaje, 0);
    if (total !== 100) return res.status(400).json({ error: 'Los porcentajes de beneficiarios deben sumar 100%' });

    let { rows: [v] } = await pool.query(
      `SELECT id FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [p.id]
    );
    if (!v) {
      const { rows: [nv] } = await pool.query(
        `INSERT INTO captacion_vinculaciones (prospecto_id) VALUES ($1) RETURNING id`, [p.id]
      );
      v = nv;
    }

    await pool.query(`DELETE FROM captacion_beneficiarios WHERE vinculacion_id = $1`, [v.id]);
    for (const b of beneficiarios) {
      await pool.query(
        `INSERT INTO captacion_beneficiarios (vinculacion_id, orden, identificacion, nombres, porcentaje, fecha_nacimiento, parentesco)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [v.id, b.orden, b.identificacion || null, b.nombres, b.porcentaje, b.fecha_nacimiento || null, b.parentesco || null]
      );
    }

    await pool.query(
      `UPDATE captacion_vinculaciones SET seccion_beneficiarios_at = NOW(), updated_at = NOW() WHERE id = $1`, [v.id]
    );

    res.json({ ok: true });
  } catch (err) { next(err); }
};

export const pubSeccionReferencias = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });
    if (new Date(p.token_expira_at) < new Date()) return respuesta410(p, req, res);
    if (await solicitudEntregada(p.id)) return res.status(400).json(ERROR_ENTREGADA);

    const { referencias } = seccionReferenciasSchema.parse(req.body);

    let { rows: [v] } = await pool.query(
      `SELECT id FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [p.id]
    );
    if (!v) {
      const { rows: [nv] } = await pool.query(
        `INSERT INTO captacion_vinculaciones (prospecto_id) VALUES ($1) RETURNING id`, [p.id]
      );
      v = nv;
    }

    await pool.query(`DELETE FROM captacion_referencias WHERE vinculacion_id = $1`, [v.id]);
    for (const r of referencias) {
      await pool.query(
        `INSERT INTO captacion_referencias (vinculacion_id, tipo, nombres, telefono_fijo, celular)
         VALUES ($1,$2,$3,$4,$5)`,
        [v.id, r.tipo, r.nombres || null, r.telefono_fijo || null, r.celular || null]
      );
    }

    await pool.query(
      `UPDATE captacion_vinculaciones SET seccion_referencias_at = NOW(), updated_at = NOW() WHERE id = $1`, [v.id]
    );

    res.json({ ok: true });
  } catch (err) { next(err); }
};

export const pubFirmar = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });
    if (await solicitudEntregada(p.id)) return res.status(400).json(ERROR_ENTREGADA);

    // Exigir step-up: la firma tiene validez legal y requiere identidad verificada
    const stepupToken = req.headers['x-stepup-token'];
    let decoded;
    if (!stepupToken) return res.status(403).json({ error: 'Se requiere verificación de identidad para firmar', code: 'STEPUP_REQUIRED' });
    try {
      decoded = jwt.verify(stepupToken, CLAVE_STEPUP);
      if (decoded.sub !== 'captacion_stepup' || decoded.pid !== p.id || !decoded.otp)
        return res.status(403).json({ error: 'Token de verificación no corresponde a este formulario', code: 'STEPUP_MISMATCH' });
      // Si el correo cambió después de verificarlo, la verificación ya no vale
      if (decoded.c !== hashCorreo(p.correo || ''))
        return res.status(403).json({ error: 'Tu correo cambió: verifica tu identidad de nuevo', code: 'STEPUP_EXPIRED' });
    } catch {
      return res.status(403).json({ error: 'Verificación expirada — realiza el paso de identidad nuevamente', code: 'STEPUP_EXPIRED' });
    }

    const data = seccionFirmaSchema.parse(req.body);
    if (data.version_firma_electronica !== VERSION_FIRMA_ELECTRONICA)
      return res.status(400).json({ error: 'El texto del consentimiento cambió: recarga el formulario para firmar' });

    const { rows: [v] } = await pool.query(
      `SELECT id, seccion_pep_at, seccion_aportes_at, seccion_firma_at FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [p.id]
    );
    if (!v) return res.status(400).json({ error: 'No hay formulario iniciado' });
    // La firma sella el documento: no se puede volver a firmar (la subsanación completa datos sin re-firmar)
    if (v.seccion_firma_at) return res.status(409).json({ error: 'Esta solicitud ya fue firmada' });
    if (!v.seccion_pep_at) return res.status(400).json({ error: 'Debe completar la sección PEP antes de firmar' });
    if (!v.seccion_aportes_at) return res.status(400).json({ error: 'Debe elegir su aporte antes de firmar' });

    // Snapshot de lo que se firma: el formulario, el acto de firma (imagen, trazos, hora, IP, dispositivo, verificación del
    // correo) y el texto íntegro de lo que aceptó. El hash cubre todo, con claves ordenadas para que un perito lo recalcule.
    const firmaAt = new Date();
    const userAgent = req.headers['user-agent'] || null;
    const { rows: [snap] } = await pool.query(
      `SELECT v.*, p.nombres, p.apellidos, p.cedula, p.celular, p.correo, p.empresa_codigo,
              p.habeas_data_at, p.habeas_data_version
         FROM captacion_vinculaciones v
         JOIN captacion_prospectos p ON p.id = v.prospecto_id WHERE v.id = $1`, [v.id]
    );
    const verificacion = { canal: decoded.canal, destino: decoded.destino, correo: p.correo, otp_id: decoded.otp };
    const consentimientos = {
      habeas_data:       await registrarTexto('habeas_data', snap.habeas_data_version ?? VERSION_HABEAS_DATA),
      declaracion:       await registrarTexto('declaracion', data.version_consentimiento),
      firma_electronica: await registrarTexto('firma_electronica', data.version_firma_electronica),
    };
    const snapshotStr = canonicalizar({
      formulario: snap,
      firma: { origen: data.firma_origen, png: data.firma_png, trazos: data.firma_trazos, firmada_at: firmaAt, ip: req.ip, user_agent: userAgent, verificacion },
      consentimientos,
    });
    const docHash = sha256(snapshotStr);

    await pool.query(
      `UPDATE captacion_vinculaciones SET
         firma_png              = $1,
         firma_trazos           = $2,
         firma_at               = $11,
         firma_ip               = $3,
         firma_user_agent       = $4,
         firma_doc_hash         = $5,
         version_consentimiento = $6,
         formulario_snapshot    = $7,
         firma_electronica_at      = NOW(),
         firma_electronica_version = $8,
         firma_verificacion        = $10,
         seccion_firma_at       = NOW(),
         estado                 = CASE WHEN EXISTS (SELECT 1 FROM captacion_subsanaciones s WHERE s.vinculacion_id = $9 AND s.resuelta_at IS NULL)
                                       THEN 'por_subsanar' ELSE 'solicitud_completa' END,
         updated_at             = NOW()
       WHERE id = $9`,
      [data.firma_png, JSON.stringify(data.firma_trazos), req.ip,
       userAgent, docHash, data.version_consentimiento,
       snapshotStr, data.version_firma_electronica, v.id,
       JSON.stringify(verificacion), firmaAt]
    );

    await pool.query(
      `UPDATE captacion_prospectos SET estado = 'convertido', convertido_at = NOW(), updated_at = NOW()
        WHERE id = $1`, [p.id]
    );

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, autor_tipo, ip, payload)
       VALUES ($1,$2,'firma','prospecto',$3,$4)`,
      [p.id, v.id, req.ip, JSON.stringify({ doc_hash: docHash, firma_origen: data.firma_origen, firma_sha256: sha256(data.firma_png), version: data.version_consentimiento, firma_electronica: data.version_firma_electronica, verificacion: { canal: decoded.canal, destino: decoded.destino }, user_agent: userAgent, consentimientos })]
    );

    // Notificar al asesor
    await pool.query(
      `SELECT asesor_uuid FROM captacion_prospectos WHERE id = $1`, [p.id]
    ).then(({ rows: [pr] }) => {
      if (pr?.asesor_uuid) {
        notificarUsuario(pr.asesor_uuid, {
          tipo   : 'captacion',
          mensaje: `${p.nombres} ${p.apellidos} completó su solicitud de vinculación`,
          modulo : 'captacion',
        }).catch(() => {});
      }
    });

    // Copia sellada del formato tal como se firmó (no bloquea la firma si falla)
    await sellarFormato(v.id);

    res.json({ ok: true, estado: 'solicitud_completa' });
  } catch (err) { next(err); }
};

// ── Upload de cédula (presigned URL pattern) ──────────────────────────────────
// Lo usan dos flujos: el asociado (por su enlace) y el asesor (desde el panel, cuando el
// asociado le manda la foto por otro medio). Ambos comparten estas funciones.

const LADOS_CEDULA = ['frente', 'reverso'];
const COLUMNA_CEDULA = { frente: 'cedula_frente_id', reverso: 'cedula_reverso_id' };

// Devuelve un mensaje de error si el lado no es válido.
const validarLado = (lado) => (LADOS_CEDULA.includes(lado) ? null : 'lado debe ser frente o reverso');

/**
 * Registra el archivo ya subido a S3 como cédula (frente | reverso), reemplaza el anterior
 * (borrándolo de la tabla y de S3, para no dejar huérfanos) y marca la sección como completa
 * cuando ya están ambas caras. `autor` queda en seccion_documentos_autor.
 */
const registrarCedula = async ({ vinculacionId, lado, archivo, subidoPor, autor }) => {
  const columna = COLUMNA_CEDULA[lado];
  const { rows: [previo] } = await pool.query(
    `SELECT ${columna} AS id, seccion_firma_at FROM captacion_vinculaciones WHERE id = $1`, [vinculacionId]
  );

  const nuevo = await guardarArchivo(`captacion_cedula_${lado}`, vinculacionId, archivo, subidoPor);
  await pool.query(
    `UPDATE captacion_vinculaciones SET ${columna} = $1, updated_at = NOW() WHERE id = $2`,
    [nuevo.id, vinculacionId]
  );

  await pool.query(
    `UPDATE captacion_vinculaciones
        SET seccion_documentos_at = NOW(), seccion_documentos_autor = $2, updated_at = NOW()
      WHERE id = $1 AND cedula_frente_id IS NOT NULL AND cedula_reverso_id IS NOT NULL
        AND seccion_documentos_at IS NULL`,
    [vinculacionId, autor]
  );

  // Ya apunta al nuevo: el anterior se puede borrar sin romper la FK. Si falla S3 no se
  // revierte la subida (el documento nuevo ya es válido); queda en el log para limpieza manual.
  // Firmada la solicitud, la cédula anterior es evidencia de lo que se firmó: se conserva (queda sin vínculo, pero en el archivo).
  if (previo?.id && !previo.seccion_firma_at) {
    // En tests no se toca el bucket real: solo se elimina la fila.
    await eliminarArchivo(previo.id, { omitirS3: env.NODE_ENV === 'test' })
      .catch((err) => logger.warn(`No se pudo eliminar la cédula anterior ${previo.id}: ${err.message}`));
  }
  return nuevo;
};

const datosArchivo = ({ key, nombre, mime, size }) => ({ key, nombre, mime, size });

export const pubSolicitarUploadCedula = async (req, res, next) => {
  try {
    const { lado } = req.params;
    const errLado = validarLado(lado);
    if (errLado) return res.status(400).json({ error: errLado });

    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });
    if (new Date(p.token_expira_at) < new Date()) return res.status(410).json({ error: 'Link expirado' });

    const error = validarArchivo(req.body);
    if (error) return res.status(400).json({ error });

    // Asegurar que la vinculación exista
    let { rows: [v] } = await pool.query(
      `SELECT id, estado FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [p.id]
    );
    if (!v) {
      const { rows: [nv] } = await pool.query(
        `INSERT INTO captacion_vinculaciones (prospecto_id) VALUES ($1) RETURNING id, estado`, [p.id]
      );
      v = nv;
    }
    if (v.estado === 'entregada') return res.status(400).json({ error: 'La solicitud ya fue entregada' });

    const result = await generarPresignedUpload(`captacion_cedula_${lado}`, v.id, req.body);
    res.json(result);
  } catch (err) { next(err); }
};

export const pubConfirmarUploadCedula = async (req, res, next) => {
  try {
    const { lado } = req.params;
    const errLado = validarLado(lado);
    if (errLado) return res.status(400).json({ error: errLado });

    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });

    const { key, nombre } = req.body;
    if (!key || !nombre) return res.status(400).json({ error: 'Faltan campos: key, nombre' });
    const error = validarArchivo(req.body);
    if (error) return res.status(400).json({ error });

    const { rows: [v] } = await pool.query(
      `SELECT id, estado FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [p.id]
    );
    if (!v) return res.status(400).json({ error: 'No hay formulario iniciado' });
    if (v.estado === 'entregada') return res.status(400).json({ error: 'La solicitud ya fue entregada' });

    if (!key.startsWith(`kernel/captacion_cedula_${lado}s/${v.id}/`))
      return res.status(400).json({ error: 'Key inválida para esta solicitud' });

    const archivo = await registrarCedula({
      vinculacionId: v.id, lado, archivo: datosArchivo(req.body), subidoPor: null, autor: 'prospecto',
    });

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, ip)
       VALUES ($1,$2,'seccion_guardada','documentos','prospecto',$3)`,
      [p.id, v.id, req.ip]
    );

    res.json({ ok: true, archivo_id: archivo.id });
  } catch (err) { next(err); }
};

// ── Cédula cargada por el asesor (subsanación desde el panel) ────────────────

// Solo el asesor dueño de la solicitud, y mientras no esté entregada.
const vinculacionDelAsesor = async (id, asesorUuid) => {
  const { rows: [v] } = await pool.query(
    `SELECT v.id, v.estado, v.prospecto_id
       FROM captacion_vinculaciones v
       JOIN captacion_prospectos p ON p.id = v.prospecto_id
      WHERE v.id = $1 AND p.asesor_uuid = $2 AND v.is_active = true`,
    [id, asesorUuid]
  );
  return v || null;
};

export const solicitarDocumentoAsesor = async (req, res, next) => {
  try {
    const { id, lado } = req.params;
    const errLado = validarLado(lado);
    if (errLado) return res.status(400).json({ error: errLado });

    const v = await vinculacionDelAsesor(id, req.user.id);
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    if (v.estado === 'entregada') return res.status(400).json({ error: 'La solicitud ya fue entregada' });

    const error = validarArchivo(req.body);
    if (error) return res.status(400).json({ error });

    res.json(await generarPresignedUpload(`captacion_cedula_${lado}`, v.id, req.body));
  } catch (err) { next(err); }
};

export const confirmarDocumentoAsesor = async (req, res, next) => {
  try {
    const { id, lado } = req.params;
    const errLado = validarLado(lado);
    if (errLado) return res.status(400).json({ error: errLado });

    const v = await vinculacionDelAsesor(id, req.user.id);
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    if (v.estado === 'entregada') return res.status(400).json({ error: 'La solicitud ya fue entregada' });

    const { key, nombre } = req.body;
    if (!key || !nombre) return res.status(400).json({ error: 'Faltan campos: key, nombre' });
    const error = validarArchivo(req.body);
    if (error) return res.status(400).json({ error });
    if (!key.startsWith(`kernel/captacion_cedula_${lado}s/${v.id}/`))
      return res.status(400).json({ error: 'Key inválida para esta solicitud' });

    const archivo = await registrarCedula({
      vinculacionId: v.id, lado, archivo: datosArchivo(req.body), subidoPor: req.user.id, autor: 'asesor',
    });

    // Trazabilidad: quién cargó el documento en nombre del asociado
    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, autor_uuid, ip, payload)
       VALUES ($1,$2,'documento_subido_asesor','documentos','asesor',$3,$4,$5)`,
      [v.prospecto_id, v.id, req.user.id, req.ip, JSON.stringify({ lado, archivo_id: archivo.id, nombre: req.body.nombre })]
    );

    res.json({ ok: true, archivo_id: archivo.id });
  } catch (err) { next(err); }
};

export const pubListarEmpresas = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT codigo, nombre FROM empresas WHERE is_active = true ORDER BY nombre ASC`
    );
    res.json(rows);
  } catch (err) { next(err); }
};
