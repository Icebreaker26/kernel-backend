import crypto from 'crypto';
import { zipSync, strToU8 } from 'fflate';
import pool from '../../../db/database.js';
import logger from '../../../config/logger.js';
import { enviarOEncolar } from '../../../services/emailColaService.js';
import { notificarUsuario, notificarPorPermiso } from '../../../services/notificationService.js';
import {
  subirBuffer, leerBuffer, generarPresignedDescarga,
} from '../../../services/archivoService.js';
import { construirCorreoAutorizacion } from './correoAutorizacion.js';
import { ErrorNegocio } from '../http.js';

const ESTADOS_EDITABLES = ['en_tramite', 'devuelta'];
const ESTADOS_ABIERTOS = ['en_tramite', 'entregada', 'devuelta'];
const MB = 1024 * 1024;

// ── Utilidades ────────────────────────────────────────────────────────────────
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Se mira el contenido, no la extensión que declara el navegador
export const detectarTipo = (buf) => {
  if (buf.length > 4 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 7 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  return null;
};

export const validarUpload = (file, { permitidos = ['pdf', 'jpg', 'png'], maxMB = 15 } = {}) => {
  if (!file) throw new ErrorNegocio(400, 'Adjunta el archivo');
  if (file.size > maxMB * MB) throw new ErrorNegocio(400, `El archivo pesa más de ${maxMB} MB`);
  const tipo = detectarTipo(file.buffer);
  if (!tipo || !permitidos.includes(tipo.ext)) throw new ErrorNegocio(400, `Tipo de archivo no permitido (solo ${permitidos.join(', ').toUpperCase()})`);
  return tipo;
};

const nombreSeguro = (n, ext) => {
  const base = String(n ?? 'documento').replace(/\.[^.]+$/, '').replace(/[^\w.\- áéíóúñÁÉÍÓÚÑ()]/g, '_').slice(0, 120) || 'documento';
  return `${base}.${ext}`;
};

export const evento = (solicitudId, tipo, detalle = {}, { autorTipo = 'empleado', autorUuid = null, ip = null } = {}, db = pool) =>
  db.query(
    `INSERT INTO credito_eventos (solicitud_id, tipo, detalle, autor_tipo, autor_uuid, ip) VALUES ($1, $2, $3, $4, $5, $6)`,
    [solicitudId, tipo, JSON.stringify(detalle), autorTipo, autorUuid, ip]);

// ── Permisos ──────────────────────────────────────────────────────────────────
export const tieneAccion = async (user, modulo, accion) => {
  if (user.rol === 'admin') return true;
  const { rowCount } = await pool.query(
    `SELECT 1 FROM permisos p JOIN modulos m ON m.id = p.modulo_id JOIN acciones a ON a.id = p.accion_id
      WHERE p.usuario_uuid = $1 AND m.nombre = $2 AND a.nombre = $3`, [user.id, modulo, accion]);
  return rowCount > 0;
};

// El asesor ve solo lo suyo; ven todo: admin, quien administra créditos (CONFIGURAR) y Cartera
export const veTodas = async (user) =>
  (await tieneAccion(user, 'creditos', 'CONFIGURAR')) || (await tieneAccion(user, 'cartera', 'READ'));

export const puedeModificar = (s, user) => s.asesor_uuid === user.id || user.rol === 'admin';
const ESTADOS_TERMINALES = ['recibida', 'rechazada', 'desistida', 'completada', 'en_tesoreria', 'pagada'];

export const cargarSolicitud = async (id, user, { paraEditar = false } = {}) => {
  const { rows: [s] } = await pool.query('SELECT * FROM credito_solicitudes WHERE id = $1 AND is_active = true', [id]);
  if (!s) throw new ErrorNegocio(404, 'Solicitud no encontrada');
  if (s.asesor_uuid !== user.id && !(await veTodas(user))) throw new ErrorNegocio(404, 'Solicitud no encontrada');
  if (paraEditar) {
    // Solo el asesor que la creó (o quien la tenga asignada) o un administrador. Ver no es modificar: Cartera y quien configura solo leen.
    if (!puedeModificar(s, user)) throw new ErrorNegocio(403, 'Solo el asesor de la solicitud o un administrador puede modificarla');
    if (!ESTADOS_EDITABLES.includes(s.estado)) throw new ErrorNegocio(409, 'La solicitud ya no admite cambios en su estado actual');
  }
  return s;
};

// ── Asociados y empresas ──────────────────────────────────────────────────────
export const buscarAsociados = async (q) => {
  const term = String(q ?? '').trim();
  if (term.length < 3) return [];
  const { rows } = await pool.query(
    `SELECT a.codigo, a.nombre, a.apellido, a.movil, a.empresa_dsto AS empresa_codigo, e.nombre AS empresa_nombre
       FROM asociados a LEFT JOIN empresas e ON e.codigo = a.empresa_dsto
      WHERE a.is_active = true AND (a.codigo LIKE $1 || '%' OR (a.nombre || ' ' || a.apellido) ILIKE '%' || $2 || '%')
      ORDER BY a.apellido, a.nombre LIMIT 15`, [term.replace(/[%_]/g, ''), term]);
  return rows;
};

export const configEmpresa = async (empresaCodigo) => {
  const { rows: [c] } = await pool.query('SELECT * FROM credito_config_empresa WHERE empresa_codigo = $1', [empresaCodigo]);
  // Sin configuración: por defecto pide autorización (lo más seguro)
  return c ?? { empresa_codigo: empresaCodigo, requiere_autorizacion: true, momento_autorizacion: 'indiferente', emails_autorizacion: [], sin_configurar: true };
};

export const infoAsociado = async (codigo) => {
  const { rows: [a] } = await pool.query(
    `SELECT a.codigo, a.nombre, a.apellido, a.movil, a.email, a.fecha_ingreso, a.is_active, a.fecha_retiro, a.saldo_aporte, a.valor_aporte,
            a.empresa_dsto AS empresa_codigo, e.nombre AS empresa_nombre, e.contacto_email AS empresa_contacto_email
       FROM asociados a LEFT JOIN empresas e ON e.codigo = a.empresa_dsto WHERE a.codigo = $1`, [codigo]);
  if (!a) throw new ErrorNegocio(404, 'Asociado no encontrado');
  if (!a.is_active) throw new ErrorNegocio(422, 'El asociado no está activo: no se le pueden radicar créditos');
  if (!a.empresa_codigo || !a.empresa_nombre) throw new ErrorNegocio(422, 'La empresa del asociado no está registrada: corrige el asociado antes de radicar');
  const [{ rows: creditos }, { rows: abiertas }] = await Promise.all([
    pool.query(`SELECT nombre_linea, saldo_credito, num_cuotas, valor FROM asociado_descuentos WHERE asociado_codigo = $1 AND saldo_credito > 0 ORDER BY saldo_credito DESC`, [codigo]),
    pool.query(`SELECT id, radicado, estado, created_at FROM credito_solicitudes WHERE asociado_codigo = $1 AND estado = ANY($2) AND is_active = true ORDER BY created_at DESC`, [codigo, ESTADOS_ABIERTOS]),
  ]);
  return { ...a, config: await configEmpresa(a.empresa_codigo), creditos_vigentes: creditos, solicitudes_abiertas: abiertas };
};

// ── Radicación ────────────────────────────────────────────────────────────────
export const radicar = async (user, data, ip) => {
  if (data.clave) {
    const { rows: [previa] } = await pool.query('SELECT * FROM credito_solicitudes WHERE clave_idempotencia = $1', [data.clave]);
    if (previa) return { solicitud: previa, duplicada: true };
  }
  const asoc = await infoAsociado(data.asociado_codigo);
  const { rows: [cat] } = await pool.query('SELECT id FROM credito_categorias WHERE id = $1 AND is_active = true', [data.categoria_id]);
  if (!cat) throw new ErrorNegocio(400, 'Categoría de crédito inválida');

  const cfg = asoc.config;
  const requerida = data.autorizacion_requerida ?? cfg.requiere_autorizacion;
  if (requerida !== cfg.requiere_autorizacion && !data.override_motivo) {
    throw new ErrorNegocio(400, 'Cambiar lo que exige la empresa requiere un motivo', { campo: 'override_motivo' });
  }

  let s;
  try {
    ({ rows: [s] } = await pool.query(
      `INSERT INTO credito_solicitudes
         (radicado, clave_idempotencia, asociado_codigo, empresa_codigo, categoria_id, asesor_uuid, canal_origen,
          valor_solicitado, cuotas, cuota_mensual, forma_desembolso, modalidad_firma, proveedor_externo,
          autorizacion_requerida, autorizacion_momento, override_motivo, observaciones)
       VALUES ('CR-' || to_char(NOW() AT TIME ZONE 'America/Bogota', 'YYYY') || '-' || lpad(nextval('credito_radicado_seq')::text, 6, '0'),
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [data.clave ?? null, asoc.codigo, asoc.empresa_codigo, data.categoria_id, user.id, data.canal_origen,
        data.valor_solicitado, data.cuotas ?? null, data.cuota_mensual ?? null,
        data.forma_desembolso, data.modalidad_firma, data.proveedor_externo ?? null,
        requerida, cfg.momento_autorizacion, requerida !== cfg.requiere_autorizacion ? data.override_motivo : null, data.observaciones ?? null]));
  } catch (err) {
    if (err.code === '23505' && data.clave) {   // dos envíos simultáneos con la misma clave
      const { rows: [previa] } = await pool.query('SELECT * FROM credito_solicitudes WHERE clave_idempotencia = $1', [data.clave]);
      if (previa) return { solicitud: previa, duplicada: true };
    }
    throw err;
  }
  await evento(s.id, 'radicada', {
    radicado: s.radicado, canal: s.canal_origen, modalidad_firma: s.modalidad_firma,
    autorizacion_requerida: s.autorizacion_requerida, autorizacion_momento: s.autorizacion_momento,
    ...(s.override_motivo ? { override_motivo: s.override_motivo } : {}),
  }, { autorUuid: user.id, ip });
  const correo = await dispararCorreoAutorizacion(s.id, { emails: data.emails_autorizacion, actor: user, ip }).catch((err) => {
    logger.error(`creditos: no se pudo disparar el correo de autorización de ${s.radicado}: ${err.message}`);
    return { resultado: 'error' };
  });
  return { solicitud: s, duplicada: false, correo, advertencias: asoc.solicitudes_abiertas.length ? ['El asociado ya tiene otra solicitud abierta'] : [] };
};

export const actualizar = async (user, id, data, ip) => {
  const s = await cargarSolicitud(id, user, { paraEditar: true });
  const nuevo = { ...s, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) };
  if (nuevo.categoria_id !== s.categoria_id) {
    const { rowCount } = await pool.query('SELECT 1 FROM credito_categorias WHERE id = $1 AND is_active = true', [nuevo.categoria_id]);
    if (!rowCount) throw new ErrorNegocio(400, 'Categoría de crédito inválida');
  }
  const cambiaCondiciones = ['valor_solicitado', 'cuotas', 'cuota_mensual'].some((k) => String(nuevo[k] ?? '') !== String(s[k] ?? ''));

  const { rows: [act] } = await pool.query(
    `UPDATE credito_solicitudes SET categoria_id = $2, valor_solicitado = $3, cuotas = $4,
            cuota_mensual = $5, forma_desembolso = $6, proveedor_externo = $7, observaciones = $8, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, nuevo.categoria_id, nuevo.valor_solicitado, nuevo.cuotas ?? null,
      nuevo.cuota_mensual ?? null, nuevo.forma_desembolso, nuevo.proveedor_externo ?? null, nuevo.observaciones ?? null]);
  await evento(id, 'solicitud_editada', { campos: Object.keys(data) }, { autorUuid: user.id, ip });

  // Lo firmado y lo autorizado se refería a otras condiciones: pierde vigencia y hay que repetirlo
  let invalidados = 0;
  if (cambiaCondiciones) {
    const { rowCount } = await pool.query(
      `UPDATE credito_documentos SET vigente = false, invalidado_motivo = 'Cambiaron las condiciones del crédito después de firmar'
        WHERE solicitud_id = $1 AND clase IN ('firmado', 'evidencia_externa') AND vigente`, [id]);
    invalidados = rowCount;
    const { rowCount: aut } = await pool.query(
      `UPDATE credito_autorizaciones SET estado = 'invalidada' WHERE solicitud_id = $1 AND estado = 'aprobada'`, [id]);
    if (invalidados || aut) {
      await evento(id, 'cambio_posterior_a_firma', { documentos_invalidados: invalidados, autorizacion_invalidada: aut > 0 }, { autorUuid: user.id, ip });
    }
  }
  return { solicitud: act, invalidados };
};

// ── Documentos ────────────────────────────────────────────────────────────────
const ENTIDAD = { a_firmar: 'credito_borrador', firmado: 'credito_firmado', adjunto: 'credito_adjunto', evidencia_externa: 'credito_evidencia', autorizacion: 'credito_autorizacion' };

export const guardarDocumento = async (user, s, { clase, tipo, file, extra = {} }, ip) => {
  const t = validarUpload(file, { permitidos: clase === 'a_firmar' ? ['pdf'] : ['pdf', 'jpg', 'png'] });
  const nombre = nombreSeguro(file.originalname, t.ext);
  const archivo = await subirBuffer(ENTIDAD[clase], s.id, file.buffer, { nombre, mime: t.mime }, user.id);
  const { rows: [d] } = await pool.query(
    `INSERT INTO credito_documentos (solicitud_id, clase, tipo, nombre, archivo_id, sha256, borrador_id, proveedor, id_transaccion, fecha_firma, subido_por, etapa)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [s.id, clase, tipo, nombre, archivo.id, sha256(file.buffer), extra.borrador_id ?? null, extra.proveedor ?? null, extra.id_transaccion ?? null, extra.fecha_firma ?? null, user.id, extra.etapa ?? 'asesor']);
  await evento(s.id, `documento_${clase}`, { tipo, nombre, sha256: d.sha256 }, { autorUuid: user.id, ip });
  return d;
};

export const subirBorrador = async (user, id, { tipo }, file, ip) => {
  const s = await cargarSolicitud(id, user, { paraEditar: true });
  return guardarDocumento(user, s, { clase: 'a_firmar', tipo, file }, ip);
};

export const subirAdjunto = async (user, id, { tipo }, file, ip) => {
  const s = await cargarSolicitud(id, user, { paraEditar: true });
  return guardarDocumento(user, s, { clase: 'adjunto', tipo, file }, ip);
};

export const quitarDocumento = async (user, id, docId, ip) => {
  const s = await cargarSolicitud(id, user, { paraEditar: true });
  const { rows: [d] } = await pool.query('SELECT * FROM credito_documentos WHERE id = $1 AND solicitud_id = $2 AND vigente', [docId, s.id]);
  if (!d || !['a_firmar', 'adjunto'].includes(d.clase)) throw new ErrorNegocio(404, 'Documento no encontrado');
  if (d.clase === 'a_firmar') {
    const { rowCount } = await pool.query(`SELECT 1 FROM credito_documentos WHERE borrador_id = $1 AND clase = 'firmado' AND vigente`, [d.id]);
    if (rowCount) throw new ErrorNegocio(409, 'Este documento ya fue firmado y no se puede quitar');
  }
  // Los archivos no se borran (trazabilidad): el documento solo deja de estar vigente
  await pool.query(`UPDATE credito_documentos SET vigente = false, invalidado_motivo = 'Retirado por el asesor' WHERE id = $1`, [d.id]);
  await evento(s.id, 'documento_retirado', { tipo: d.tipo, nombre: d.nombre }, { autorUuid: user.id, ip });
};

// Firma electrónica externa: el asesor sube el PDF firmado. La evidencia del proveedor (certificado) NO se exige; si el asesor la adjunta, se guarda
export const registrarFirmaExterna = async (user, id, data, archivo, evidencia, ip) => {
  const s = await cargarSolicitud(id, user, { paraEditar: true });
  if (s.modalidad_firma !== 'externa') throw new ErrorNegocio(409, 'Esta solicitud se firma de forma presencial');
  const { rows: [b] } = await pool.query(`SELECT id, tipo FROM credito_documentos WHERE id = $1 AND solicitud_id = $2 AND clase = 'a_firmar' AND vigente`, [data.borrador_id, s.id]);
  if (!b) throw new ErrorNegocio(400, 'El documento a firmar no existe en esta solicitud');
  validarUpload(archivo, { permitidos: ['pdf'] });
  if (evidencia) validarUpload(evidencia, { permitidos: ['pdf', 'jpg', 'png'] });   // opcional
  if (data.fecha_firma > new Date().toISOString().slice(0, 10)) throw new ErrorNegocio(400, 'La fecha de firma no puede ser futura');
  try {
    const firmado = await guardarDocumento(user, s, { clase: 'firmado', tipo: b.tipo, file: archivo, extra: { borrador_id: b.id, ...data } }, ip);
    if (evidencia) await guardarDocumento(user, s, { clase: 'evidencia_externa', tipo: b.tipo, file: evidencia, extra: { borrador_id: b.id, proveedor: data.proveedor, id_transaccion: data.id_transaccion, fecha_firma: data.fecha_firma } }, ip);
    await despuesDeFirma(s.id, user, ip);
    return firmado;
  } catch (err) {
    if (err.code === '23505') throw new ErrorNegocio(409, 'Este documento ya tiene su firma registrada');
    throw err;
  }
};

// Firma presencial. El PDF firmado llega POR EL BACKEND (no directo a S3): funciona sin depender del CORS del bucket, y se guarda con cifrado,
// suma de verificación y retención. Antes de guardarlo se comprueba que ES el que produjo el motor de firma.
export const registrarFirmadoPresencial = async (user, id, { folio }, file, ip) => {
  const s = await cargarSolicitud(id, user, { paraEditar: true });
  if (s.modalidad_firma !== 'presencial') throw new ErrorNegocio(409, 'Esta solicitud se firma con proveedor externo');
  const t = validarUpload(file, { permitidos: ['pdf'], maxMB: 25 });
  const buf = file.buffer;
  const hash = sha256(buf);

  const { rows: [fe] } = await pool.query('SELECT * FROM firma_eventos WHERE folio = $1', [folio]);
  if (!fe || fe.empleado_id !== user.id) throw new ErrorNegocio(404, 'Folio de firma no encontrado');
  if (fe.h_final !== hash) throw new ErrorNegocio(400, 'El archivo no coincide con el documento que produjo la firma (huella distinta)');
  if (!fe.firmantes.some((f) => f.num_doc === s.asociado_codigo)) throw new ErrorNegocio(400, 'El asociado de la solicitud no figura entre los firmantes');
  const { rows: [b] } = await pool.query(
    `SELECT id, tipo FROM credito_documentos WHERE solicitud_id = $1 AND clase = 'a_firmar' AND vigente AND sha256 = $2`, [s.id, fe.h_original]);
  if (!b) throw new ErrorNegocio(400, 'Este documento no corresponde a uno de los preparados para la solicitud');
  const { rowCount: yaFirmado } = await pool.query(`SELECT 1 FROM credito_documentos WHERE borrador_id = $1 AND clase = 'firmado' AND vigente`, [b.id]);
  if (yaFirmado) throw new ErrorNegocio(409, 'Este documento ya tiene su firma registrada');

  try {
    const nombre = nombreSeguro(fe.nombre_archivo, 'pdf');
    const archivo = await subirBuffer(ENTIDAD.firmado, s.id, buf, { nombre, mime: t.mime }, user.id);
    const { rows: [d] } = await pool.query(
      `INSERT INTO credito_documentos (solicitud_id, clase, tipo, nombre, archivo_id, sha256, borrador_id, folio, lote_id, subido_por)
       VALUES ($1, 'firmado', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [s.id, b.tipo, nombre, archivo.id, hash, b.id, folio, fe.lote_id, user.id]);
    await evento(s.id, 'documento_firmado', { tipo: b.tipo, folio, sha256: hash }, { autorUuid: user.id, ip });
    await despuesDeFirma(s.id, user, ip);
    return d;
  } catch (err) {
    if (err.code === '23505') throw new ErrorNegocio(409, 'Este documento ya tiene su firma registrada');
    throw err;
  }
};

// El motor de firma necesita los bytes del documento a firmar: se sirven desde el backend (sin CORS de S3), solo al asesor de la solicitud o a un admin
export const contenidoParaFirma = async (user, id, docId) => {
  const s = await cargarSolicitud(id, user, { paraEditar: true });
  const { rows: [d] } = await pool.query(`SELECT archivo_id, nombre FROM credito_documentos WHERE id = $1 AND solicitud_id = $2 AND clase = 'a_firmar' AND vigente`, [docId, s.id]);
  if (!d) throw new ErrorNegocio(404, 'Documento no encontrado');
  const buf = await leerBuffer(d.archivo_id);
  if (!buf) throw new ErrorNegocio(404, 'No se encontró el archivo');
  return { buf, nombre: d.nombre };
};

const despuesDeFirma = async (solicitudId, user, ip) => {
  const { rows: [p] } = await pool.query('SELECT firma_completa FROM v_credito_pistas WHERE solicitud_id = $1', [solicitudId]);
  if (p?.firma_completa) {
    await evento(solicitudId, 'firma_completa', {}, { autorTipo: 'sistema' });
    await dispararCorreoAutorizacion(solicitudId, { actor: user, ip }).catch((err) => logger.error(`creditos: correo tras la firma: ${err.message}`));
  }
};

// ── Autorización de la empresa ────────────────────────────────────────────────
/**
 * Pide la autorización a la empresa por correo (una ronda). No hace nada si no se requiere, si ya hay una ronda vigente o si la empresa
 * pide la firma primero y esta aún no está completa. La respuesta llega al asesor (Reply-To) y él la registra con su soporte.
 */
export const dispararCorreoAutorizacion = async (solicitudId, { emails, actor, ip = null, forzar = false } = {}) => {
  const client = await pool.connect();
  let ronda; let dest; let s;
  try {
    await client.query('BEGIN');
    ({ rows: [s] } = await client.query('SELECT * FROM credito_solicitudes WHERE id = $1 FOR UPDATE', [solicitudId]));   // serializa envíos simultáneos
    if (!s.autorizacion_requerida) { await client.query('COMMIT'); return { resultado: 'no_requerida' }; }
    const { rows: [ult] } = await client.query('SELECT estado FROM credito_autorizaciones WHERE solicitud_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [solicitudId]);
    if (!forzar) {
      if (ult && ['solicitada', 'aprobada'].includes(ult.estado)) { await client.query('COMMIT'); return { resultado: 'ya_solicitada' }; }
      if (ult && ['rechazada', 'sin_destinatario'].includes(ult.estado)) { await client.query('COMMIT'); return { resultado: 'requiere_accion' }; }
      if (s.autorizacion_momento === 'despues_firma') {
        const { rows: [p] } = await client.query('SELECT firma_completa FROM v_credito_pistas WHERE solicitud_id = $1', [solicitudId]);
        if (!p?.firma_completa) { await client.query('COMMIT'); return { resultado: 'espera_firma' }; }
      }
    }
    const { rows: [cfg] } = await client.query('SELECT emails_autorizacion FROM credito_config_empresa WHERE empresa_codigo = $1', [s.empresa_codigo]);
    const { rows: [emp] } = await client.query('SELECT contacto_email FROM empresas WHERE codigo = $1', [s.empresa_codigo]);
    dest = emails?.length ? emails : (cfg?.emails_autorizacion?.length ? cfg.emails_autorizacion : (emp?.contacto_email ? [emp.contacto_email] : []));
    ({ rows: [ronda] } = await client.query(
      `INSERT INTO credito_autorizaciones (solicitud_id, estado, enviada_a, enviada_at) VALUES ($1, $2, $3, $4) RETURNING *`,
      [solicitudId, dest.length ? 'solicitada' : 'sin_destinatario', dest, dest.length ? new Date() : null]));
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (!dest.length) {
    await evento(solicitudId, 'autorizacion_sin_destinatario', {}, { autorTipo: 'sistema' });
    await notificarUsuario(s.asesor_uuid, { tipo: 'creditos', modulo: 'creditos', mensaje: `La solicitud ${s.radicado} no tiene a quién pedirle la autorización de la empresa: indica el correo y envíala` }).catch(() => {});
    return { resultado: 'sin_destinatario', ronda_id: ronda.id };
  }

  const { rows: [datos] } = await pool.query(
    `SELECT a.codigo, a.nombre, a.apellido, e.nombre AS empresa, u.nombre AS asesor_nombre, u.email AS asesor_email
       FROM credito_solicitudes s JOIN asociados a ON a.codigo = s.asociado_codigo JOIN empresas e ON e.codigo = s.empresa_codigo
       JOIN global_usuarios u ON u.id = s.asesor_uuid WHERE s.id = $1`, [solicitudId]);
  const msg = construirCorreoAutorizacion({
    asociado: datos, empresa: datos.empresa, radicado: s.radicado, cuotaMensual: s.cuota_mensual, cuotas: s.cuotas, asesor: { nombre: datos.asesor_nombre },
  });
  const resultados = [];
  for (const to of dest) {
    try {
      resultados.push(await enviarOEncolar({ tipo: 'credito_autorizacion', to, asunto: msg.asunto, html: msg.html, texto: msg.texto, referencia_tipo: 'credito_autorizacion', referencia_id: ronda.id, reply_to: datos.asesor_email }));
    } catch (err) {
      logger.error(`creditos: no se pudo encolar el correo a ${to}: ${err.message}`);
      resultados.push('error');
    }
  }
  await evento(solicitudId, 'autorizacion_solicitada', { a: dest, resultados, ronda: ronda.id }, { autorUuid: actor?.id ?? null, ip, autorTipo: actor ? 'empleado' : 'sistema' });
  if (resultados.every((r) => r === 'suprimido' || r === 'error')) {
    await pool.query(`UPDATE credito_autorizaciones SET estado = 'sin_destinatario' WHERE id = $1`, [ronda.id]);
    await notificarUsuario(s.asesor_uuid, { tipo: 'creditos', modulo: 'creditos', mensaje: `El correo de autorización de la solicitud ${s.radicado} no pudo enviarse: verifica la dirección de la empresa` }).catch(() => {});
    return { resultado: 'sin_destinatario', ronda_id: ronda.id };
  }
  return { resultado: 'solicitada', ronda_id: ronda.id, enviada_a: dest };
};

export const enviarAutorizacion = async (user, id, { emails }, ip) => {
  const s = await cargarSolicitud(id, user, { paraEditar: true });
  if (!s.autorizacion_requerida) throw new ErrorNegocio(409, 'Esta solicitud no requiere autorización de la empresa');
  const { rows: [ult] } = await pool.query('SELECT estado FROM credito_autorizaciones WHERE solicitud_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [id]);
  if (ult?.estado === 'aprobada') throw new ErrorNegocio(409, 'La autorización ya fue aprobada');
  return dispararCorreoAutorizacion(id, { emails, actor: user, ip, forzar: true });
};

// La empresa responde por correo: el asesor marca la decisión y anexa el PDF del correo como soporte
export const registrarAutorizacion = async (user, id, data, file, ip) => {
  const s = await cargarSolicitud(id, user, { paraEditar: true });
  if (!s.autorizacion_requerida) throw new ErrorNegocio(409, 'Esta solicitud no requiere autorización de la empresa');
  if (data.fecha_autorizacion && data.fecha_autorizacion > new Date().toISOString().slice(0, 10)) throw new ErrorNegocio(400, 'La fecha de la autorización no puede ser futura');
  let archivoId = null;
  if (data.decision === 'aprobada' || file) {
    const t = validarUpload(file, { permitidos: ['pdf', 'jpg', 'png'] });   // soporte obligatorio al aprobar
    archivoId = (await subirBuffer(ENTIDAD.autorizacion, s.id, file.buffer, { nombre: nombreSeguro(file.originalname, t.ext), mime: t.mime }, user.id)).id;
  }
  const { rows: [ult] } = await pool.query(`SELECT * FROM credito_autorizaciones WHERE solicitud_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [id]);
  if (ult?.estado === 'aprobada') throw new ErrorNegocio(409, 'La autorización ya fue aprobada');
  const estado = data.decision;
  let ronda;
  if (ult && ['solicitada', 'sin_destinatario'].includes(ult.estado)) {
    ({ rows: [ronda] } = await pool.query(
      `UPDATE credito_autorizaciones SET estado = $2, fecha_autorizacion = $3, archivo_id = $4, canal = $5, cuota_autorizada = $6,
              motivo_rechazo = $7, registrada_at = NOW(), registrado_por = $8 WHERE id = $1 RETURNING *`,
      [ult.id, estado, data.fecha_autorizacion ?? null, archivoId, data.canal, data.cuota_autorizada ?? null, data.motivo_rechazo ?? null, user.id]));
  } else {
    // No hubo correo (p. ej. la empresa respondió por otro medio): se registra igual, como una ronda nueva
    ({ rows: [ronda] } = await pool.query(
      `INSERT INTO credito_autorizaciones (solicitud_id, estado, canal, fecha_autorizacion, archivo_id, cuota_autorizada, motivo_rechazo, registrada_at, registrado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8) RETURNING *`,
      [id, estado, data.canal, data.fecha_autorizacion ?? null, archivoId, data.cuota_autorizada ?? null, data.motivo_rechazo ?? null, user.id]));
  }
  await evento(id, estado === 'aprobada' ? 'autorizacion_aprobada' : 'autorizacion_rechazada',
    { ronda: ronda.id, fecha: data.fecha_autorizacion ?? null, canal: data.canal, ...(data.motivo_rechazo ? { motivo: data.motivo_rechazo } : {}) }, { autorUuid: user.id, ip });
  return ronda;
};

// ── Consultas ─────────────────────────────────────────────────────────────────
const COLUMNAS_LISTA = `
  s.id, s.radicado, s.asociado_codigo, (a.nombre || ' ' || a.apellido) AS asociado_nombre, e.nombre AS empresa_nombre,
  c.nombre AS categoria, s.valor_solicitado, s.monto_desembolso, s.forma_desembolso, s.modalidad_firma, s.estado, s.created_at,
  s.entregada_at, s.recibida_at, s.devuelta_at, s.completada_at, u.nombre AS asesor_nombre,
  p.a_firmar, p.firmados, p.firma_completa, p.autorizacion_requerida, p.autorizacion_estado, p.autorizacion_ok,
  p.tiene_desprendible, p.certificado_requerido, p.tiene_certificado, p.documentos_ok, p.listo, p.expediente_completo,
  GREATEST(0, (CURRENT_DATE - (s.created_at AT TIME ZONE 'America/Bogota')::date)) AS dias`;
const FROM_LISTA = `
  FROM credito_solicitudes s
  JOIN v_credito_pistas p ON p.solicitud_id = s.id
  JOIN asociados a ON a.codigo = s.asociado_codigo
  JOIN empresas e ON e.codigo = s.empresa_codigo
  JOIN credito_categorias c ON c.id = s.categoria_id
  JOIN global_usuarios u ON u.id = s.asesor_uuid`;

export const listar = async (user, { estado, q, todas } = {}) => {
  const where = ['s.is_active = true'];
  const params = [];
  if (!(todas && (await veTodas(user)))) { params.push(user.id); where.push(`s.asesor_uuid = $${params.length}`); }
  if (estado) { params.push(estado); where.push(`s.estado = $${params.length}`); }
  if (q && String(q).trim().length >= 2) {
    params.push(`%${String(q).trim()}%`);
    where.push(`(s.radicado ILIKE $${params.length} OR s.asociado_codigo ILIKE $${params.length} OR (a.nombre || ' ' || a.apellido) ILIKE $${params.length})`);
  }
  const { rows } = await pool.query(`SELECT ${COLUMNAS_LISTA} ${FROM_LISTA} WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC LIMIT 200`, params);
  return rows;
};

// Bandeja de Cartera por pestaña
export const listarCartera = async ({ tab = 'entregadas', q } = {}) => {
  const estados = { por_llegar: ['en_tramite'], entregadas: ['entregada'], recibidas: ['recibida'], completadas: ['completada'], devueltas: ['devuelta'] }[tab];
  if (!estados) throw new ErrorNegocio(400, 'Pestaña inválida');
  const params = [estados];
  let filtro = '';
  if (q && String(q).trim().length >= 2) { params.push(`%${String(q).trim()}%`); filtro = `AND (s.radicado ILIKE $2 OR s.asociado_codigo ILIKE $2 OR (a.nombre || ' ' || a.apellido) ILIKE $2)`; }
  const { rows } = await pool.query(
    `SELECT ${COLUMNAS_LISTA} ${FROM_LISTA} WHERE s.is_active = true AND s.estado = ANY($1) ${filtro}
      ORDER BY COALESCE(s.entregada_at, s.created_at) ASC LIMIT 300`, params);
  return rows;
};

export const faltantes = (p, s) => {
  const f = [];
  if (!p.a_firmar) f.push('Sube los documentos a firmar');
  else if (!p.firma_completa) f.push(`Firma: ${p.firmados} de ${p.a_firmar} documentos firmados`);
  if (s.autorizacion_requerida && !p.autorizacion_ok) {
    f.push({ rechazada: 'La empresa rechazó la autorización', sin_destinatario: 'Falta el correo de la empresa para pedir la autorización', invalidada: 'La autorización perdió vigencia: hay que pedirla de nuevo' }[p.autorizacion_estado] ?? 'Falta la autorización de la empresa');
  }
  if (!p.tiene_desprendible) f.push('Falta el desprendible de nómina');
  if (p.certificado_requerido && !p.tiene_certificado) f.push('Falta el certificado bancario (desembolso por transferencia)');
  return f;
};

export const detalle = async (user, id) => {
  const s = await cargarSolicitud(id, user);
  const [{ rows: [head] }, { rows: docs }, { rows: auts }, { rows: eventos }, { rows: [pistas] }, { rows: [asoc] }] = await Promise.all([
    pool.query(`SELECT ${COLUMNAS_LISTA}, s.*, s.id AS id FROM credito_solicitudes s JOIN v_credito_pistas p ON p.solicitud_id = s.id JOIN asociados a ON a.codigo = s.asociado_codigo
                JOIN empresas e ON e.codigo = s.empresa_codigo JOIN credito_categorias c ON c.id = s.categoria_id JOIN global_usuarios u ON u.id = s.asesor_uuid WHERE s.id = $1`, [id]),
    pool.query(`SELECT d.id, d.clase, d.tipo, d.nombre, d.sha256, d.borrador_id, d.folio, d.lote_id, d.proveedor, d.id_transaccion, d.fecha_firma, d.vigente,
                       d.invalidado_motivo, d.etapa, d.archivo_id, d.created_at, ar.mime_type, ar.size_bytes, u.nombre AS subido_por_nombre
                  FROM credito_documentos d JOIN archivos ar ON ar.id = d.archivo_id LEFT JOIN global_usuarios u ON u.id = d.subido_por
                 WHERE d.solicitud_id = $1 ORDER BY d.created_at`, [id]),
    pool.query(`SELECT a.*, ar.nombre AS archivo_nombre, u.nombre AS registrado_por_nombre FROM credito_autorizaciones a
                  LEFT JOIN archivos ar ON ar.id = a.archivo_id LEFT JOIN global_usuarios u ON u.id = a.registrado_por
                 WHERE a.solicitud_id = $1 ORDER BY a.created_at DESC`, [id]),
    pool.query(`SELECT ev.id, ev.tipo, ev.detalle, ev.autor_tipo, ev.created_at, u.nombre AS autor_nombre FROM credito_eventos ev
                  LEFT JOIN global_usuarios u ON u.id = ev.autor_uuid WHERE ev.solicitud_id = $1 ORDER BY ev.created_at, ev.id`, [id]),
    pool.query('SELECT * FROM v_credito_pistas WHERE solicitud_id = $1', [id]),
    pool.query(`SELECT a.codigo, a.nombre, a.apellido, a.movil, a.email, a.fecha_ingreso, a.saldo_aporte, a.valor_aporte FROM asociados a WHERE a.codigo = $1`, [s.asociado_codigo]),
  ]);
  return {
    solicitud: head, asociado: asoc, documentos: docs, autorizaciones: auts, eventos, pistas, faltantes: faltantes(pistas, s),
    puede_editar: puedeModificar(s, user) && ESTADOS_EDITABLES.includes(s.estado),
    puede_reasignar: user.rol === 'admin' && !ESTADOS_TERMINALES.includes(s.estado),
  };
};

// URL temporal (5 min) de un archivo de la solicitud; cada vista queda en la línea de tiempo
export const urlArchivo = async (user, id, archivoId, ip, origen = null) => {
  const s = await cargarSolicitud(id, user);
  const { rows: [d] } = await pool.query(
    `SELECT 'documento' AS origen, clase, tipo FROM credito_documentos WHERE solicitud_id = $1 AND archivo_id = $2
      UNION ALL SELECT 'autorizacion', 'autorizacion', 'soporte' FROM credito_autorizaciones WHERE solicitud_id = $1 AND archivo_id = $2 LIMIT 1`, [s.id, archivoId]);
  if (!d) throw new ErrorNegocio(404, 'Archivo no encontrado');
  const url = await generarPresignedDescarga(archivoId);
  if (!url) throw new ErrorNegocio(404, 'Archivo no encontrado');
  await evento(s.id, 'documento_visto', { archivo_id: archivoId, clase: d.clase, tipo: d.tipo, ...(origen ? { desde: origen } : {}) }, { autorUuid: user.id, ip });
  return url;
};

// ── Documentos de un asociado (pestaña del perfil) ────────────────────────────
// Todos los archivos de crédito del asociado, de todas sus solicitudes. El asesor ve solo los de las solicitudes que le pertenecen;
// Cartera, quien administra créditos y los admin ven los de todas.
export const documentosDeAsociado = async (user, codigo) => {
  const params = [codigo];
  let filtro = '';
  if (!(await veTodas(user))) { params.push(user.id); filtro = ' AND s.asesor_uuid = $2'; }
  const { rows } = await pool.query(
    `SELECT d.id::text AS id, d.clase, d.tipo, d.nombre, d.archivo_id, d.vigente, d.created_at, d.folio, s.id AS solicitud_id, s.radicado,
            s.estado AS solicitud_estado, ar.size_bytes, ar.mime_type, u.nombre AS subido_por_nombre
       FROM credito_documentos d JOIN credito_solicitudes s ON s.id = d.solicitud_id JOIN archivos ar ON ar.id = d.archivo_id
       LEFT JOIN global_usuarios u ON u.id = d.subido_por
      WHERE s.asociado_codigo = $1 AND s.is_active = true${filtro}
     UNION ALL
     SELECT a.id::text, 'autorizacion', 'soporte', ar.nombre, a.archivo_id, (a.estado <> 'invalidada'), a.created_at, NULL::uuid, s.id, s.radicado,
            s.estado, ar.size_bytes, ar.mime_type, u.nombre
       FROM credito_autorizaciones a JOIN credito_solicitudes s ON s.id = a.solicitud_id JOIN archivos ar ON ar.id = a.archivo_id
       LEFT JOIN global_usuarios u ON u.id = a.registrado_por
      WHERE s.asociado_codigo = $1 AND s.is_active = true AND a.archivo_id IS NOT NULL${filtro}
      ORDER BY created_at DESC`, params);
  return rows;
};

// Abre un archivo del asociado desde su perfil: mismas reglas de acceso, y la consulta queda en el historial de la solicitud
export const urlArchivoDeAsociado = async (user, codigo, archivoId, ip) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(archivoId))) throw new ErrorNegocio(404, 'Archivo no encontrado');
  const { rows: [s] } = await pool.query(
    `SELECT s.id FROM credito_solicitudes s
      WHERE s.asociado_codigo = $1 AND s.is_active = true
        AND (EXISTS (SELECT 1 FROM credito_documentos d WHERE d.solicitud_id = s.id AND d.archivo_id = $2)
          OR EXISTS (SELECT 1 FROM credito_autorizaciones a WHERE a.solicitud_id = s.id AND a.archivo_id = $2))
      LIMIT 1`, [codigo, archivoId]);
  if (!s) throw new ErrorNegocio(404, 'Archivo no encontrado');
  return urlArchivo(user, s.id, archivoId, ip, 'perfil_asociado');   // aplica el acceso por solicitud (un asesor ajeno recibe 404)
};

// Recalcula el hash de lo guardado y lo compara con el registrado (y, en firma presencial, con el del motor)
export const verificarIntegridad = async (user, id) => {
  await cargarSolicitud(id, user);
  const { rows: docs } = await pool.query(
    `SELECT d.id, d.archivo_id, d.nombre, d.tipo, d.sha256, d.folio, fe.h_final FROM credito_documentos d LEFT JOIN firma_eventos fe ON fe.folio = d.folio
      WHERE d.solicitud_id = $1 AND d.clase IN ('firmado', 'a_firmar') AND d.vigente`, [id]);
  const out = [];
  for (const d of docs) {
    const buf = await leerBuffer(d.archivo_id);
    const hashActual = buf ? sha256(buf) : null;
    out.push({ id: d.id, nombre: d.nombre, tipo: d.tipo, integro: hashActual === d.sha256 && (!d.folio || d.h_final === d.sha256) });
  }
  return out;
};

// ── Expediente completo (ZIP para Cartera) ────────────────────────────────────
const CARPETAS = { firmado: '1_documentos_firmados', autorizacion: '2_autorizacion_empresa', adjunto: '3_documentos_del_asociado', evidencia_externa: '4_evidencia_firma_externa' };
const NOMBRE_TIPO = {
  carta_instrucciones: 'Carta_de_instrucciones', libranza: 'Libranza', pagare: 'Pagare', solicitud_credito: 'Solicitud', proyeccion: 'Proyeccion',
  desprendible_nomina: 'Desprendible_de_nomina', certificado_bancario: 'Certificado_bancario', otro_adjunto: 'Otro_adjunto',
};
const limpiar = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w.\-]+/g, '_').replace(/_+/g, '_').slice(0, 90);

/**
 * Arma un ZIP con todo el expediente de una solicitud entregada: documentos firmados, soporte de la autorización de la empresa,
 * documentos del asociado y evidencia de la firma externa, más un resumen con la huella SHA-256 de cada archivo (recalculada al empacar,
 * y comparada con la registrada). Solo incluye lo vigente. Contiene datos personales y biométricos: cada descarga queda en el historial.
 */
export const armarExpediente = async (user, id, ip) => {
  const s = await cargarSolicitud(id, user);
  if (!['entregada', 'recibida'].includes(s.estado)) throw new ErrorNegocio(409, 'Solo se descarga el expediente de solicitudes entregadas a Cartera');
  const d = await detalle(user, id);
  const h = d.solicitud;

  const entradas = {};
  const lineas = [];
  const usados = new Set();
  const agregar = async (carpeta, base, nombreOriginal, archivoId, hashRegistrado, nota = '') => {
    const buf = await leerBuffer(archivoId);
    const ext = (String(nombreOriginal).match(/\.([A-Za-z0-9]{2,4})$/) ?? [null, 'pdf'])[1].toLowerCase();
    let ruta = `${carpeta}/${limpiar(base)}.${ext}`;
    for (let n = 2; usados.has(ruta); n++) ruta = `${carpeta}/${limpiar(base)}_${n}.${ext}`;
    usados.add(ruta);
    if (!buf) { lineas.push(`${ruta}\n    NO SE ENCONTRÓ EL ARCHIVO EN EL ALMACENAMIENTO`); return; }
    const hash = sha256(buf);
    entradas[ruta] = [buf, { level: 0 }];   // los PDF e imágenes ya vienen comprimidos
    const integridad = hashRegistrado ? (hash === hashRegistrado ? 'íntegro (coincide con el registro)' : '¡NO COINCIDE CON EL REGISTRO!') : 'sin huella registrada para comparar';
    lineas.push(`${ruta}\n    SHA-256 ${hash}\n    ${integridad}${nota ? `\n    ${nota}` : ''}`);
  };

  for (const doc of d.documentos.filter((x) => x.vigente)) {
    const carpeta = CARPETAS[doc.clase];
    if (!carpeta) continue;   // los borradores sin firmar no son parte del expediente
    const etiqueta = NOMBRE_TIPO[doc.tipo] ?? doc.tipo;
    const nota = doc.clase === 'firmado'
      ? (doc.folio ? `Firma presencial · folio ${doc.folio}` : `Firma externa · ${doc.proveedor ?? ''}${doc.id_transaccion ? ` · transacción ${doc.id_transaccion}` : ''}${doc.fecha_firma ? ` · ${String(doc.fecha_firma).slice(0, 10)}` : ''}`)
      : '';
    await agregar(carpeta, `${etiqueta}${doc.clase === 'firmado' ? '_firmado' : doc.clase === 'evidencia_externa' ? '_evidencia' : ''}`, doc.nombre, doc.archivo_id, doc.sha256, nota);
  }
  for (const a of [...d.autorizaciones].reverse().filter((x) => x.archivo_id)) {
    const fecha = a.fecha_autorizacion ? new Date(a.fecha_autorizacion).toISOString().slice(0, 10) : 'sin_fecha';
    await agregar(CARPETAS.autorizacion, `Autorizacion_${a.estado}_${fecha}`, a.archivo_nombre ?? 'soporte.pdf', a.archivo_id, null,
      `Respuesta de la empresa (${a.estado})${a.canal ? ` por ${a.canal}` : ''}${a.cuota_autorizada ? ` · cuota autorizada $${Number(a.cuota_autorizada).toLocaleString('es-CO')}` : ''}${a.motivo_rechazo ? ` · motivo: ${a.motivo_rechazo}` : ''}`);
  }

  const aso = d.asociado;
  const pesos = (n) => `$${Number(n).toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;
  const resumen = [
    `EXPEDIENTE DE CRÉDITO ${h.radicado}`,
    `Cooperativa Progresemos — generado el ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })} por ${user.nombre ?? user.email ?? user.id}`,
    '',
    `Asociado:            ${aso.nombre} ${aso.apellido} — C.C. ${aso.codigo}`,
    `Empresa:             ${h.empresa_nombre}`,
    `Categoría:           ${h.categoria}`,
    `Valor solicitado:    ${pesos(h.valor_solicitado)}`,
    `Desembolso neto:     ${h.monto_desembolso == null ? 'se calcula en Cartera (valor solicitado − aval − firma electrónica)' : pesos(h.monto_desembolso)}`,
    `Forma de desembolso: ${h.forma_desembolso}`,
    `Cuotas:              ${h.cuotas ? `${h.cuotas} × ${pesos(h.cuota_mensual ?? 0)}` : '—'}`,
    `Tipo de firma:       ${h.modalidad_firma === 'presencial' ? 'presencial (tableta / huellero)' : `externa (${h.proveedor_externo ?? ''})`}`,
    `Asesor:              ${h.asesor_nombre}`,
    `Radicada:            ${new Date(h.created_at).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`,
    `Entregada a Cartera: ${h.entregada_at ? new Date(h.entregada_at).toLocaleString('es-CO', { timeZone: 'America/Bogota' }) : '—'}`,
    '',
    `Firma:               ${d.pistas.firmados} de ${d.pistas.a_firmar} documentos firmados`,
    `Autorización:        ${h.autorizacion_requerida ? (d.pistas.autorizacion_estado ?? 'pendiente') : 'la empresa no la exige'}`,
    `Expediente completo: ${d.pistas.expediente_completo ? 'sí' : 'NO'}`,
    '',
    'ARCHIVOS (huella SHA-256 recalculada al empacar)',
    '------------------------------------------------',
    ...lineas.flatMap((l) => [l, '']),
    'Este paquete contiene datos personales y biométricos protegidos por la Ley 1581 de 2012. Uso exclusivo de Cartera; no lo reenvíes ni lo guardes fuera de los sistemas de la cooperativa.',
  ].join('\n');
  entradas['0_resumen.txt'] = [strToU8(resumen), { level: 6 }];

  await evento(id, 'expediente_descargado', { archivos: Object.keys(entradas).length - 1 }, { autorUuid: user.id, ip });
  return { buf: Buffer.from(zipSync(entradas)), nombre: `expediente_${h.radicado}.zip` };
};

// ── Transiciones ──────────────────────────────────────────────────────────────
export const entregar = async (user, id, ip) => {
  const s = await cargarSolicitud(id, user, { paraEditar: true });
  const { rows: [p] } = await pool.query('SELECT * FROM v_credito_pistas WHERE solicitud_id = $1', [id]);
  if (!p.listo) throw new ErrorNegocio(409, 'La solicitud aún no está lista para Cartera', { faltantes: faltantes(p, s) });
  await pool.query(`UPDATE credito_solicitudes SET estado = 'entregada', entregada_at = NOW(), entregada_por = $2, updated_at = NOW() WHERE id = $1`, [id, user.id]);
  await evento(id, 'entregada_a_cartera', {}, { autorUuid: user.id, ip });
  await notificarPorPermiso('cartera', { tipo: 'creditos', mensaje: `Nueva solicitud de crédito para Cartera: ${s.radicado}` }).catch(() => {});
};

export const cerrar = async (user, id, { estado, motivo }, ip) => {
  const s = await cargarSolicitud(id, user, { paraEditar: true });
  await pool.query(`UPDATE credito_solicitudes SET estado = $2, cierre_motivo = $3, updated_at = NOW() WHERE id = $1`, [id, estado, motivo]);
  await evento(id, `solicitud_${estado}`, { motivo }, { autorUuid: user.id, ip });
  return s.radicado;
};

export const recibir = async (user, id, ip) => {
  const { rows: [s] } = await pool.query('SELECT * FROM credito_solicitudes WHERE id = $1 AND is_active', [id]);
  if (!s) throw new ErrorNegocio(404, 'Solicitud no encontrada');
  if (s.estado !== 'entregada') throw new ErrorNegocio(409, 'Solo se pueden recibir solicitudes entregadas');
  await pool.query(`UPDATE credito_solicitudes SET estado = 'recibida', recibida_at = NOW(), recibida_por = $2, updated_at = NOW() WHERE id = $1`, [id, user.id]);
  await evento(id, 'recibida_por_cartera', {}, { autorUuid: user.id, ip });
  await notificarUsuario(s.asesor_uuid, { tipo: 'creditos', modulo: 'creditos', mensaje: `Cartera recibió la solicitud ${s.radicado}` }).catch(() => {});
};

export const devolver = async (user, id, { motivo }, ip) => {
  const { rows: [s] } = await pool.query('SELECT * FROM credito_solicitudes WHERE id = $1 AND is_active', [id]);
  if (!s) throw new ErrorNegocio(404, 'Solicitud no encontrada');
  if (s.estado !== 'entregada') throw new ErrorNegocio(409, 'Solo se pueden devolver solicitudes entregadas');
  await pool.query(`UPDATE credito_solicitudes SET estado = 'devuelta', devuelta_at = NOW(), devuelta_motivo = $2, updated_at = NOW() WHERE id = $1`, [id, motivo]);
  await evento(id, 'devuelta_por_cartera', { motivo }, { autorUuid: user.id, ip });
  await notificarUsuario(s.asesor_uuid, { tipo: 'creditos', modulo: 'creditos', mensaje: `Cartera devolvió la solicitud ${s.radicado}: ${motivo}` }).catch(() => {});
};

// ── Reasignación (solo administradores) ───────────────────────────────────────
// Nadie modifica el trabajo de otro asesor; si el asesor se va o se ausenta, un administrador pasa la solicitud a otro.
export const listarAsesores = async (user) => {
  if (user.rol !== 'admin') throw new ErrorNegocio(403, 'Solo un administrador puede reasignar solicitudes');
  const { rows } = await pool.query(
    `SELECT u.id, u.nombre, u.email FROM global_usuarios u
      WHERE u.is_active = true AND (u.rol = 'admin' OR EXISTS (
        SELECT 1 FROM permisos p JOIN modulos m ON m.id = p.modulo_id JOIN acciones a ON a.id = p.accion_id
         WHERE p.usuario_uuid = u.id AND m.nombre = 'creditos' AND a.nombre = 'WRITE'))
      ORDER BY u.nombre`);
  return rows;
};

export const reasignar = async (user, id, { asesor_uuid: nuevoId, motivo }, ip) => {
  if (user.rol !== 'admin') throw new ErrorNegocio(403, 'Solo un administrador puede reasignar solicitudes');
  const { rows: [s] } = await pool.query('SELECT s.*, u.nombre AS asesor_nombre FROM credito_solicitudes s JOIN global_usuarios u ON u.id = s.asesor_uuid WHERE s.id = $1 AND s.is_active', [id]);
  if (!s) throw new ErrorNegocio(404, 'Solicitud no encontrada');
  if (ESTADOS_TERMINALES.includes(s.estado)) throw new ErrorNegocio(409, 'La solicitud ya está cerrada y no se puede reasignar');
  if (nuevoId === s.asesor_uuid) throw new ErrorNegocio(400, 'Esa persona ya es el asesor de la solicitud');
  const { rows: [nuevo] } = await pool.query('SELECT id, nombre, rol FROM global_usuarios WHERE id = $1 AND is_active = true', [nuevoId]);
  if (!nuevo) throw new ErrorNegocio(400, 'Usuario no válido');
  if (nuevo.rol !== 'admin' && !(await tieneAccion(nuevo, 'creditos', 'WRITE'))) throw new ErrorNegocio(400, 'Esa persona no tiene permiso para gestionar créditos');
  await pool.query('UPDATE credito_solicitudes SET asesor_uuid = $2, updated_at = NOW() WHERE id = $1', [id, nuevoId]);
  await evento(id, 'reasignada', { de: s.asesor_nombre, a: nuevo.nombre, motivo }, { autorUuid: user.id, ip });
  await notificarUsuario(nuevoId, { tipo: 'creditos', modulo: 'creditos', mensaje: `Se te asignó la solicitud de crédito ${s.radicado}` }).catch(() => {});
  await notificarUsuario(s.asesor_uuid, { tipo: 'creditos', modulo: 'creditos', mensaje: `La solicitud ${s.radicado} fue reasignada a ${nuevo.nombre}` }).catch(() => {});
  return { asesor: nuevo };
};

// ── Configuración ─────────────────────────────────────────────────────────────
export const listarCategorias = async () =>
  (await pool.query('SELECT id, codigo, nombre, linea_id FROM credito_categorias WHERE is_active = true ORDER BY orden, nombre')).rows;

export const listarConfigEmpresas = async (q) => {
  const params = [];
  let filtro = '';
  if (q && String(q).trim().length >= 2) { params.push(`%${String(q).trim()}%`); filtro = 'WHERE e.nombre ILIKE $1 OR e.codigo ILIKE $1'; }
  const { rows } = await pool.query(
    `SELECT e.codigo, e.nombre, e.contacto_email, (c.empresa_codigo IS NOT NULL) AS configurada,
            COALESCE(c.requiere_autorizacion, true) AS requiere_autorizacion, COALESCE(c.momento_autorizacion, 'indiferente') AS momento_autorizacion,
            COALESCE(c.emails_autorizacion, '{}') AS emails_autorizacion
       FROM empresas e LEFT JOIN credito_config_empresa c ON c.empresa_codigo = e.codigo ${filtro} ORDER BY e.nombre LIMIT 200`, params);
  return rows;
};

export const guardarConfigEmpresa = async (user, codigo, d) => {
  const { rowCount } = await pool.query('SELECT 1 FROM empresas WHERE codigo = $1', [codigo]);
  if (!rowCount) throw new ErrorNegocio(404, 'Empresa no encontrada');
  const { rows: [c] } = await pool.query(
    `INSERT INTO credito_config_empresa (empresa_codigo, requiere_autorizacion, momento_autorizacion, emails_autorizacion, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (empresa_codigo) DO UPDATE SET requiere_autorizacion = EXCLUDED.requiere_autorizacion, momento_autorizacion = EXCLUDED.momento_autorizacion,
       emails_autorizacion = EXCLUDED.emails_autorizacion, updated_by = EXCLUDED.updated_by, updated_at = NOW() RETURNING *`,
    [codigo, d.requiere_autorizacion, d.momento_autorizacion, d.emails_autorizacion, user.id]);
  return c;
};
