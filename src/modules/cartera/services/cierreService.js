// Cierre de Cartera: documentos firmados de Cartera, aval del fondo regional, desembolso neto, sellos, PDF final y paso a Control Interno.
import pool from '../../../db/database.js';
import logger from '../../../config/logger.js';
import { notificarPorPermiso, notificarUsuario } from '../../../services/notificationService.js';
import { subirBuffer, leerBuffer } from '../../../services/archivoService.js';
import { ErrorNegocio } from '../../creditos/http.js';
import {
  cargarSolicitud, evento, guardarDocumento, sha256, validarUpload, detectarTipo,
} from '../../creditos/services/creditoService.js';
import { armarPdfFinal, ordenarDocumentos, sellosAplicables } from './pdfFinal.js';

export const TIPOS_CARTERA = ['comprobante_aprobacion', 'formato_estudio_credito'];
const ETIQUETA = { comprobante_aprobacion: 'Comprobante de aprobación de crédito', formato_estudio_credito: 'Formato estudio de crédito' };

const redondear = (n) => Math.round(Number(n) * 100) / 100;

// ── Tarifa de la firma electrónica externa ────────────────────────────────────
export const obtenerTarifa = async (db = pool) => {
  const { rows: [r] } = await db.query(`SELECT valor FROM credito_parametros WHERE clave = 'tarifa_firma_electronica'`);
  return Number(r?.valor ?? 0);
};

export const guardarTarifa = async (user, valor) => {
  await pool.query(
    `INSERT INTO credito_parametros (clave, valor, updated_by) VALUES ('tarifa_firma_electronica', $1, $2)
     ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_by = EXCLUDED.updated_by, updated_at = NOW()`, [valor, user.id]);
  logger.info(`cartera: tarifa de firma electrónica = ${valor} (por ${user.id})`);
  return valor;
};

// ── Cálculo ───────────────────────────────────────────────────────────────────
/** Aval = % sobre el valor solicitado. Firma electrónica = tarifa por crédito firmado con proveedor externo. Neto = monto − aval − firma. */
export const calcularDesembolso = ({ monto, conAval, porcentaje, externa, tarifa }) => {
  const aval = conAval ? redondear((Number(monto) * Number(porcentaje)) / 100) : 0;
  const firma = externa ? redondear(tarifa) : 0;
  const neto = redondear(Number(monto) - aval - firma);
  if (neto < 0) throw new ErrorNegocio(400, 'Los descuentos superan el valor solicitado');
  return { aval, firma, neto };
};

// ── Carga ─────────────────────────────────────────────────────────────────────
const cargarParaCierre = async (user, id, { editar = false } = {}) => {
  const s = await cargarSolicitud(id, user);
  if (editar && s.estado !== 'recibida') throw new ErrorNegocio(409, 'El cierre solo se trabaja sobre solicitudes recibidas por Cartera');
  return s;
};

const documentosCartera = async (solicitudId, db = pool) => {
  const { rows } = await db.query(
    `SELECT d.id, d.clase, d.tipo, d.nombre, d.sha256, d.borrador_id, d.folio, d.vigente, d.archivo_id, d.created_at
       FROM credito_documentos d WHERE d.solicitud_id = $1 AND d.etapa = 'cartera' ORDER BY d.created_at`, [solicitudId]);
  return rows;
};

export const cuentaCompleta = (c) => !!(c && c.banco && c.tipo_cuenta && c.numero_cuenta && c.titular_nombre && c.titular_documento);

const faltantesCierre = (s, docs, cierre) => {
  const f = [];
  for (const tipo of TIPOS_CARTERA) {
    const b = docs.find((d) => d.clase === 'a_firmar' && d.tipo === tipo && d.vigente);
    if (!b) f.push(`Carga el ${ETIQUETA[tipo]}`);
    else if (!docs.some((d) => d.clase === 'firmado' && d.borrador_id === b.id && d.vigente)) f.push(`Falta firmar el ${ETIQUETA[tipo]}`);
  }
  if (!cierre) { f.push('Guarda el desembolso (aval y sellos)'); return f; }
  if (cierre.con_aval && !cierre.aval_porcentaje) f.push('Indica el porcentaje del aval');
  if (s.forma_desembolso === 'transferencia' && !cuentaCompleta(cierre)) f.push('Captura los datos de la cuenta bancaria del asociado (banco, tipo, número y titular)');
  const rotulo = { aval: 'AVAL FONDO REGIONAL', firma: 'FIRMA ELECTRONICA', desembolso: 'DESEMBOLSO' };
  for (const clave of sellosAplicables(cierre, s)) if (!cierre.sellos?.[clave]) f.push(`Ubica el sello ${rotulo[clave]} en el comprobante`);
  return f;
};

export const obtenerCierre = async (user, id) => {
  const s = await cargarParaCierre(user, id);
  const [docs, { rows: [cierre] }, tarifa] = await Promise.all([
    documentosCartera(s.id),
    pool.query('SELECT * FROM credito_cierre WHERE solicitud_id = $1', [s.id]),
    obtenerTarifa(),
  ]);
  const externa = s.modalidad_firma === 'externa';
  // Sin cierre guardado se muestra la simulación sin aval; después de completar los valores están congelados
  const previo = cierre ?? { con_aval: false, aval_porcentaje: null, sellos: {}, ...(() => { const c = calcularDesembolso({ monto: s.valor_solicitado, conAval: false, externa, tarifa }); return { aval_valor: c.aval, firma_electronica_valor: c.firma, desembolso_neto: c.neto }; })() };
  const faltantes = s.estado === 'recibida' ? faltantesCierre(s, docs, cierre) : [];
  return {
    solicitud_id: s.id, estado: s.estado, radicado: s.radicado, valor_solicitado: Number(s.valor_solicitado), firma_externa: externa,
    forma_desembolso: s.forma_desembolso, asociado: { codigo: s.asociado_codigo },
    tarifa_firma_electronica: tarifa, cierre: previo, documentos: docs, faltantes,
    sellos_aplicables: sellosAplicables(previo, s),
    puede_editar: s.estado === 'recibida', puede_completar: s.estado === 'recibida' && faltantes.length === 0,
  };
};

// ── Documentos de Cartera ─────────────────────────────────────────────────────
export const subirDocumento = async (user, id, { tipo }, file, ip) => {
  const s = await cargarParaCierre(user, id, { editar: true });
  if (!TIPOS_CARTERA.includes(tipo)) throw new ErrorNegocio(400, 'Tipo de documento inválido');
  validarUpload(file, { permitidos: ['pdf'] });
  // Reemplazar un documento deja sin vigencia el anterior y su firma (el firmado ya no corresponde al nuevo archivo)
  await pool.query(
    `UPDATE credito_documentos SET vigente = false, invalidado_motivo = 'Reemplazado por un documento nuevo'
      WHERE solicitud_id = $1 AND etapa = 'cartera' AND vigente AND tipo = $2`, [s.id, tipo]);
  const d = await guardarDocumento(user, s, { clase: 'a_firmar', tipo, file, extra: { etapa: 'cartera' } }, ip);
  return d;
};

export const contenidoParaFirma = async (user, id, docId) => {
  const s = await cargarParaCierre(user, id, { editar: true });
  const { rows: [d] } = await pool.query(
    `SELECT archivo_id, nombre FROM credito_documentos WHERE id = $1 AND solicitud_id = $2 AND clase = 'a_firmar' AND etapa = 'cartera' AND vigente`, [docId, s.id]);
  if (!d) throw new ErrorNegocio(404, 'Documento no encontrado');
  const buf = await leerBuffer(d.archivo_id);
  if (!buf) throw new ErrorNegocio(404, 'No se encontró el archivo');
  return { buf, nombre: d.nombre };
};

// El comprobante firmado (sin sellos) para que Cartera coloque los sellos sobre él; se sirve por el backend (sin CORS del bucket)
export const contenidoComprobante = async (user, id) => {
  const s = await cargarParaCierre(user, id);
  const { rows: [d] } = await pool.query(
    `SELECT archivo_id, nombre FROM credito_documentos WHERE solicitud_id = $1 AND clase = 'firmado' AND etapa = 'cartera' AND tipo = 'comprobante_aprobacion' AND vigente`, [s.id]);
  if (!d) throw new ErrorNegocio(404, 'Aún no hay comprobante de aprobación firmado');
  const buf = await leerBuffer(d.archivo_id);
  if (!buf) throw new ErrorNegocio(404, 'No se encontró el archivo');
  return { buf, nombre: d.nombre };
};

// El PDF firmado llega por el backend y se comprueba que ES el que produjo el motor de firma (folio + huella), firmado por este funcionario
export const registrarFirmado = async (user, id, { folio }, file, ip) => {
  const s = await cargarParaCierre(user, id, { editar: true });
  const t = validarUpload(file, { permitidos: ['pdf'], maxMB: 25 });
  const hash = sha256(file.buffer);
  const { rows: [fe] } = await pool.query('SELECT * FROM firma_eventos WHERE folio = $1', [folio]);
  if (!fe || fe.empleado_id !== user.id) throw new ErrorNegocio(404, 'Folio de firma no encontrado');
  if (fe.h_final !== hash) throw new ErrorNegocio(400, 'El archivo no coincide con el documento que produjo la firma (huella distinta)');
  if (!fe.firmantes.some((f) => f.num_doc === s.asociado_codigo)) throw new ErrorNegocio(400, 'El asociado de la solicitud no figura entre los firmantes');
  const { rows: [b] } = await pool.query(
    `SELECT id, tipo, EXISTS (SELECT 1 FROM credito_documentos x WHERE x.borrador_id = d.id AND x.clase = 'firmado' AND x.vigente) AS firmado
       FROM credito_documentos d WHERE d.solicitud_id = $1 AND d.clase = 'a_firmar' AND d.etapa = 'cartera' AND d.vigente AND d.sha256 = $2
      ORDER BY firmado, d.created_at LIMIT 1`, [s.id, fe.h_original]);
  if (!b) throw new ErrorNegocio(400, 'Este documento no corresponde a uno de los preparados por Cartera para esta solicitud');
  if (b.firmado) throw new ErrorNegocio(409, 'Este documento ya tiene su firma registrada');
  try {
    const nombre = `${ETIQUETA[b.tipo].replace(/\s+/g, '_')}_firmado.pdf`;
    const archivo = await subirBuffer('credito_firmado', s.id, file.buffer, { nombre, mime: t.mime }, user.id);
    const { rows: [d] } = await pool.query(
      `INSERT INTO credito_documentos (solicitud_id, clase, tipo, nombre, archivo_id, sha256, borrador_id, folio, lote_id, subido_por, etapa)
       VALUES ($1, 'firmado', $2, $3, $4, $5, $6, $7, $8, $9, 'cartera') RETURNING *`,
      [s.id, b.tipo, nombre, archivo.id, hash, b.id, folio, fe.lote_id, user.id]);
    await evento(s.id, 'cartera_documento_firmado', { tipo: b.tipo, folio, sha256: hash }, { autorUuid: user.id, ip });
    return d;
  } catch (err) {
    if (err.code === '23505') throw new ErrorNegocio(409, 'Este documento ya tiene su firma registrada');
    throw err;
  }
};

// ── Aval, desembolso neto y sellos ────────────────────────────────────────────
export const guardarCierre = async (user, id, { con_aval: conAval, aval_porcentaje: pct, sellos, cuenta }, ip) => {
  const s = await cargarParaCierre(user, id, { editar: true });
  const externa = s.modalidad_firma === 'externa';
  const tarifa = await obtenerTarifa();
  const c = calcularDesembolso({ monto: s.valor_solicitado, conAval, porcentaje: pct, externa, tarifa });
  if (cuenta && s.forma_desembolso !== 'transferencia') throw new ErrorNegocio(400, 'Esta solicitud no se desembolsa por transferencia: no lleva cuenta bancaria');
  const { rows: [antes] } = await pool.query('SELECT sellos, con_aval, aval_porcentaje, banco, tipo_cuenta, numero_cuenta, titular_nombre, titular_documento FROM credito_cierre WHERE solicitud_id = $1', [s.id]);
  const cta = cuenta ?? (antes ? { banco: antes.banco, tipo_cuenta: antes.tipo_cuenta, numero_cuenta: antes.numero_cuenta, titular_nombre: antes.titular_nombre, titular_documento: antes.titular_documento } : {});
  const nuevos = sellos ?? antes?.sellos ?? {};
  await pool.query(
    `INSERT INTO credito_cierre (solicitud_id, con_aval, aval_porcentaje, aval_valor, firma_electronica_valor, desembolso_neto, sellos, updated_by,
                                 banco, tipo_cuenta, numero_cuenta, titular_nombre, titular_documento)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (solicitud_id) DO UPDATE SET con_aval = EXCLUDED.con_aval, aval_porcentaje = EXCLUDED.aval_porcentaje, aval_valor = EXCLUDED.aval_valor,
       firma_electronica_valor = EXCLUDED.firma_electronica_valor, desembolso_neto = EXCLUDED.desembolso_neto, sellos = EXCLUDED.sellos,
       updated_by = EXCLUDED.updated_by, banco = EXCLUDED.banco, tipo_cuenta = EXCLUDED.tipo_cuenta, numero_cuenta = EXCLUDED.numero_cuenta,
       titular_nombre = EXCLUDED.titular_nombre, titular_documento = EXCLUDED.titular_documento, updated_at = NOW()`,
    [s.id, conAval, conAval ? pct : null, c.aval, c.firma, c.neto, JSON.stringify(nuevos), user.id,
      cta.banco ?? null, cta.tipo_cuenta ?? null, cta.numero_cuenta ?? null, cta.titular_nombre ?? null, cta.titular_documento ?? null]);
  if (cuenta) await evento(s.id, 'cartera_cuenta_registrada', { banco: cuenta.banco, tipo_cuenta: cuenta.tipo_cuenta, terminada_en: cuenta.numero_cuenta.slice(-4), titular_documento: cuenta.titular_documento }, { autorUuid: user.id, ip });
  if (!antes || antes.con_aval !== conAval || Number(antes.aval_porcentaje ?? 0) !== Number(pct ?? 0)) {
    await evento(s.id, 'cartera_desembolso_calculado', { con_aval: conAval, aval_porcentaje: conAval ? pct : null, aval: c.aval, firma_electronica: c.firma, desembolso_neto: c.neto }, { autorUuid: user.id, ip });
  }
  return obtenerCierre(user, id);
};

// ── PDF final ─────────────────────────────────────────────────────────────────
// `soloIds`: la carga del expediente no necesita el ámbito del usuario (Control Interno no es asesor ni Cartera): el permiso lo exige la ruta.
export const generarPdfFinal = async (user, id, ip, { ambitoCartera = true } = {}) => {
  let s;
  if (ambitoCartera) s = await cargarSolicitud(id, user);
  else {
    ({ rows: [s] } = await pool.query('SELECT * FROM credito_solicitudes WHERE id = $1 AND is_active = true', [id]));
    if (!s) throw new ErrorNegocio(404, 'Solicitud no encontrada');
  }
  if (!['recibida', 'completada'].includes(s.estado)) throw new ErrorNegocio(409, 'El PDF final se genera cuando Cartera ya recibió el expediente');

  const [{ rows: docs }, { rows: auts }, { rows: [cierre] }] = await Promise.all([
    pool.query(
      `SELECT d.id, d.clase, d.tipo, d.nombre, d.archivo_id, d.sha256, d.created_at, d.etapa, ar.mime_type
         FROM credito_documentos d JOIN archivos ar ON ar.id = d.archivo_id
        WHERE d.solicitud_id = $1 AND d.vigente AND d.clase IN ('firmado', 'adjunto', 'evidencia_externa')`, [s.id]),
    pool.query(
      `SELECT a.id, a.archivo_id, a.created_at, ar.nombre, ar.mime_type FROM credito_autorizaciones a JOIN archivos ar ON ar.id = a.archivo_id
        WHERE a.solicitud_id = $1 AND a.estado = 'aprobada' ORDER BY a.created_at DESC LIMIT 1`, [s.id]),
    pool.query('SELECT * FROM credito_cierre WHERE solicitud_id = $1', [s.id]),
  ]);
  for (const tipo of TIPOS_CARTERA) {
    if (!docs.some((d) => d.clase === 'firmado' && d.etapa === 'cartera' && d.tipo === tipo)) throw new ErrorNegocio(409, `Falta el ${ETIQUETA[tipo]} firmado`);
  }
  const lista = ordenarDocumentos([
    ...docs.map((d) => ({ ...d, origen: 'documento' })),
    ...auts.map((a) => ({ id: a.id, clase: 'autorizacion', origen: 'autorizacion', tipo: 'soporte', nombre: a.nombre, archivo_id: a.archivo_id, created_at: a.created_at, mime_type: a.mime_type })),
  ]);

  const entradas = [];
  for (const d of lista) {
    const bytes = await leerBuffer(d.archivo_id);
    if (!bytes) throw new ErrorNegocio(409, `No se encontró en el almacenamiento el archivo ${d.nombre}`);
    const t = detectarTipo(bytes);
    entradas.push({ nombre: d.nombre, tipo: d.tipo, clase: d.clase, origen: d.origen, bytes, mime: t?.mime ?? d.mime_type, comprobante: d.clase === 'firmado' && d.etapa === 'cartera' && d.tipo === 'comprobante_aprobacion' });
  }
  let resultado;
  try {
    resultado = await armarPdfFinal(entradas, cierre, s);
  } catch (err) {
    throw new ErrorNegocio(409, err.message);
  }
  await evento(s.id, 'pdf_final_generado', { paginas: resultado.paginas, documentos: entradas.length, omitidos: resultado.omitidos }, { autorUuid: user.id, ip });
  return { buf: Buffer.from(resultado.bytes), nombre: `credito_${s.radicado}.pdf`, omitidos: resultado.omitidos };
};

// ── Completar y pasar a Control Interno ───────────────────────────────────────
export const completar = async (user, id, ip) => {
  const s = await cargarParaCierre(user, id, { editar: true });
  const [docs, { rows: [cierre] }, tarifa] = await Promise.all([
    documentosCartera(s.id), pool.query('SELECT * FROM credito_cierre WHERE solicitud_id = $1', [s.id]), obtenerTarifa(),
  ]);
  const f = faltantesCierre(s, docs, cierre);
  if (f.length) throw new ErrorNegocio(409, 'El cierre aún no está completo', { faltantes: f });

  // Al completar se congelan los valores con la tarifa vigente
  const c = calcularDesembolso({ monto: s.valor_solicitado, conAval: cierre.con_aval, porcentaje: cierre.aval_porcentaje, externa: s.modalidad_firma === 'externa', tarifa });
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query('UPDATE credito_cierre SET aval_valor = $2, firma_electronica_valor = $3, desembolso_neto = $4, updated_at = NOW() WHERE solicitud_id = $1', [s.id, c.aval, c.firma, c.neto]);
    const { rowCount } = await cliente.query(
      `UPDATE credito_solicitudes SET estado = 'completada', completada_at = NOW(), completada_por = $2, monto_desembolso = $3, updated_at = NOW() WHERE id = $1 AND estado = 'recibida'`, [s.id, user.id, c.neto]);
    if (!rowCount) throw new ErrorNegocio(409, 'La solicitud ya no está en estado recibida');
    await evento(s.id, 'completada_por_cartera', { aval: c.aval, firma_electronica: c.firma, desembolso_neto: c.neto }, { autorUuid: user.id, ip }, cliente);
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK');
    throw err;
  } finally {
    cliente.release();
  }
  await notificarPorPermiso('control_interno', { tipo: 'creditos', mensaje: `Crédito ${s.radicado} completado por Cartera: pendiente de validación` }).catch(() => {});
  await notificarUsuario(s.asesor_uuid, { tipo: 'creditos', modulo: 'creditos', mensaje: `Cartera completó el crédito ${s.radicado}` }).catch(() => {});
  return { desembolso_neto: c.neto };
};

// ── Reportes mensuales ────────────────────────────────────────────────────────
const rangoMes = (mes) => {
  const [a, m] = mes.split('-').map(Number);
  const desde = `${a}-${String(m).padStart(2, '0')}-01`;
  const hasta = m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`;
  return { desde, hasta };
};

const BASE_REPORTE = `
  FROM credito_solicitudes s
  JOIN credito_cierre c ON c.solicitud_id = s.id
  JOIN asociados a ON a.codigo = s.asociado_codigo
  JOIN empresas e ON e.codigo = s.empresa_codigo
  JOIN credito_categorias ca ON ca.id = s.categoria_id
 WHERE s.is_active AND s.estado IN ('completada', 'en_tesoreria', 'pagada')   -- ya completado por Cartera, esté donde esté después
   AND (s.completada_at AT TIME ZONE 'America/Bogota')::date >= $1::date
   AND (s.completada_at AT TIME ZONE 'America/Bogota')::date <  $2::date`;

export const avalesDelMes = async (mes) => {
  const { desde, hasta } = rangoMes(mes);
  const { rows } = await pool.query(
    `SELECT s.radicado, s.asociado_codigo AS cedula, (a.nombre || ' ' || a.apellido) AS asociado, e.nombre AS empresa, ca.nombre AS categoria,
            s.valor_solicitado, s.monto_desembolso, c.aval_porcentaje, c.aval_valor, c.firma_electronica_valor, c.desembolso_neto,
            (s.completada_at AT TIME ZONE 'America/Bogota')::date AS fecha_completado
     ${BASE_REPORTE} AND c.con_aval ORDER BY s.completada_at, s.radicado`, [desde, hasta]);
  return rows;
};

export const firmasElectronicasDelMes = async (mes) => {
  const { desde, hasta } = rangoMes(mes);
  const { rows } = await pool.query(
    `SELECT s.radicado, s.asociado_codigo AS cedula, (a.nombre || ' ' || a.apellido) AS asociado, e.nombre AS empresa,
            s.proveedor_externo AS proveedor, c.firma_electronica_valor AS valor,
            (SELECT COUNT(*)::int FROM credito_documentos d WHERE d.solicitud_id = s.id AND d.clase = 'firmado' AND d.vigente AND d.etapa = 'asesor') AS documentos,
            (s.completada_at AT TIME ZONE 'America/Bogota')::date AS fecha_completado
     ${BASE_REPORTE} AND s.modalidad_firma = 'externa' ORDER BY s.completada_at, s.radicado`, [desde, hasta]);
  return rows;
};

// CSV para Excel en español: separador ';', UTF-8 con BOM, comillas cuando hace falta y sin fórmulas inyectadas
const celda = (v) => {
  if (v === null || v === undefined) return '';
  let t = v instanceof Date ? v.toISOString().slice(0, 10) : String(v);
  if (/^[=+\-@\t\r]/.test(t) && Number.isNaN(Number(t))) t = `'${t}`;
  return /[;"\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
export const aCsv = (columnas, filas) =>
  `﻿${[columnas.map((c) => celda(c.titulo)).join(';'), ...filas.map((f) => columnas.map((c) => celda(f[c.campo])).join(';'))].join('\r\n')}\r\n`;

export const COLUMNAS_AVALES = [
  { campo: 'fecha_completado', titulo: 'FECHA' }, { campo: 'radicado', titulo: 'RADICADO' }, { campo: 'cedula', titulo: 'CEDULA' },
  { campo: 'asociado', titulo: 'ASOCIADO' }, { campo: 'empresa', titulo: 'EMPRESA' }, { campo: 'categoria', titulo: 'CATEGORIA' },
  { campo: 'valor_solicitado', titulo: 'VALOR_SOLICITADO' },
  { campo: 'aval_porcentaje', titulo: 'PORCENTAJE_AVAL' }, { campo: 'aval_valor', titulo: 'VALOR_AVAL' },
  { campo: 'firma_electronica_valor', titulo: 'VALOR_FIRMA_ELECTRONICA' }, { campo: 'desembolso_neto', titulo: 'DESEMBOLSO_NETO' },
];
export const COLUMNAS_FIRMAS = [
  { campo: 'fecha_completado', titulo: 'FECHA' }, { campo: 'radicado', titulo: 'RADICADO' }, { campo: 'cedula', titulo: 'CEDULA' },
  { campo: 'asociado', titulo: 'ASOCIADO' }, { campo: 'empresa', titulo: 'EMPRESA' }, { campo: 'proveedor', titulo: 'PROVEEDOR' },
  { campo: 'documentos', titulo: 'DOCUMENTOS_FIRMADOS' }, { campo: 'valor', titulo: 'VALOR' },
];

// ── Bandeja de Control Interno (solo la cola por ahora) ───────────────────────
export const listarCompletadas = async () => {
  const { rows } = await pool.query(
    `SELECT s.id, s.radicado, s.asociado_codigo, (a.nombre || ' ' || a.apellido) AS asociado_nombre, e.nombre AS empresa_nombre,
            ca.nombre AS categoria, s.valor_solicitado, s.monto_desembolso, s.modalidad_firma, s.forma_desembolso, s.completada_at, s.completada_por,
            c.con_aval, c.aval_porcentaje, c.aval_valor, c.firma_electronica_valor, c.desembolso_neto
       FROM credito_solicitudes s JOIN credito_cierre c ON c.solicitud_id = s.id JOIN asociados a ON a.codigo = s.asociado_codigo
       JOIN empresas e ON e.codigo = s.empresa_codigo JOIN credito_categorias ca ON ca.id = s.categoria_id
      WHERE s.is_active AND s.estado = 'completada' ORDER BY s.completada_at ASC LIMIT 500`);
  return rows;
};
