// Tramo final del crédito: Control Interno revisa (aprueba o devuelve) y Tesorería paga.
// La ORDEN DE PAGO es una foto inmutable de asociado, cuenta y monto tomada al aprobar: es lo único que Tesorería paga.
import crypto from 'crypto';
import pool from '../../../db/database.js';
import logger from '../../../config/logger.js';
import { notificarPorPermiso, notificarUsuario } from '../../../services/notificationService.js';
import { generarPresignedDescarga } from '../../../services/archivoService.js';
import { ErrorNegocio } from '../http.js';
import { evento, tieneAccion } from './creditoService.js';

const norm = (v) => String(v ?? '').replace(/[\s.-]/g, '').toUpperCase();
export const ultimos4 = (n) => (n ? String(n).slice(-4) : '');

/** Huella de la foto de la orden: si algo cambia en la base, deja de coincidir */
export const huellaOrden = (o) => crypto.createHash('sha256').update(JSON.stringify([
  o.solicitud_id, o.radicado, o.asociado_codigo, o.asociado_nombre, o.forma_pago, Number(o.monto).toFixed(2),
  o.banco ?? null, o.tipo_cuenta ?? null, o.numero_cuenta ?? null, o.titular_nombre ?? null, o.titular_documento ?? null,
])).digest('hex');

const conTransaccion = async (fn) => {
  const cn = await pool.connect();
  try {
    await cn.query('BEGIN');
    const r = await fn(cn);
    await cn.query('COMMIT');
    return r;
  } catch (err) {
    await cn.query('ROLLBACK');
    throw err;
  } finally { cn.release(); }
};

// ── Lista de verificación de Control Interno ─────────────────────────────────
export const LISTA = {
  documentos:     'Los documentos firmados están completos y legibles (pagaré, libranza, carta, solicitud, proyección, comprobante y estudio)',
  autorizacion:   'La autorización de la empresa está y es vigente',
  valores:        'El valor solicitado, el aval, la firma electrónica y el desembolso neto son correctos',
  datos_bancarios: 'Banco, tipo, número y titular de la cuenta coinciden con el certificado bancario',
  titular_tercero: 'El titular de la cuenta NO es el asociado: confirmo que está autorizado y que los datos son correctos',
};

/** Qué ítems aplican a este crédito */
export const itemsAplicables = ({ solicitud, cierre }) => {
  const claves = ['documentos'];
  if (solicitud.autorizacion_requerida) claves.push('autorizacion');
  claves.push('valores');
  if (solicitud.forma_desembolso === 'transferencia') {
    claves.push('datos_bancarios');
    if (norm(cierre.titular_documento) !== norm(solicitud.asociado_codigo)) claves.push('titular_tercero');
  }
  return claves;
};

const cargarCierre = async (id, db = pool, { bloquear = false } = {}) => {
  const { rows: [s] } = await db.query(`SELECT * FROM credito_solicitudes WHERE id = $1 AND is_active = true ${bloquear ? 'FOR UPDATE' : ''}`, [id]);
  if (!s) throw new ErrorNegocio(404, 'Solicitud no encontrada');
  const { rows: [c] } = await db.query('SELECT * FROM credito_cierre WHERE solicitud_id = $1', [id]);
  return { solicitud: s, cierre: c };
};

// ── Control Interno ───────────────────────────────────────────────────────────
export const detalleRevision = async (user, id) => {
  const { solicitud: s, cierre: c } = await cargarCierre(id);
  if (!['completada', 'en_tesoreria', 'pagada'].includes(s.estado)) throw new ErrorNegocio(404, 'Este crédito no está en Control Interno');
  const [{ rows: [aso] }, { rows: docs }, { rows: [aut] }, { rows: revisiones }, { rows: [orden] }, { rows: [cat] }, { rows: [cpor] }, { rows: eventos }, { rows: [ase] }] = await Promise.all([
    pool.query(`SELECT a.codigo, a.nombre, a.apellido, e.nombre AS empresa FROM asociados a LEFT JOIN empresas e ON e.codigo = a.empresa_dsto WHERE a.codigo = $1`, [s.asociado_codigo]),
    pool.query(`SELECT d.id, d.clase, d.tipo, d.nombre, d.etapa, d.folio, d.proveedor, d.created_at, ar.mime_type, ar.size_bytes, u.nombre AS subido_por_nombre
                  FROM credito_documentos d JOIN archivos ar ON ar.id = d.archivo_id LEFT JOIN global_usuarios u ON u.id = d.subido_por
                 WHERE d.solicitud_id = $1 AND d.vigente AND d.clase IN ('firmado', 'adjunto', 'evidencia_externa') ORDER BY d.etapa, d.created_at`, [id]),
    pool.query(`SELECT estado, fecha_autorizacion, canal FROM credito_autorizaciones WHERE solicitud_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]),
    pool.query(`SELECT r.id, r.decision, r.destino, r.motivo, r.created_at, u.nombre AS revisor FROM credito_revisiones_ci r LEFT JOIN global_usuarios u ON u.id = r.revisor_uuid WHERE r.solicitud_id = $1 ORDER BY r.created_at DESC`, [id]),
    pool.query(`SELECT id, estado FROM credito_ordenes_pago WHERE solicitud_id = $1 AND estado IN ('pendiente', 'pagada')`, [id]),
    pool.query('SELECT nombre FROM credito_categorias WHERE id = $1', [s.categoria_id]),
    pool.query('SELECT nombre FROM global_usuarios WHERE id = $1', [s.completada_por]),
    pool.query(`SELECT ev.id, ev.tipo, ev.detalle, ev.autor_tipo, ev.created_at, u.nombre AS autor_nombre FROM credito_eventos ev LEFT JOIN global_usuarios u ON u.id = ev.autor_uuid WHERE ev.solicitud_id = $1 ORDER BY ev.created_at, ev.id`, [id]),
    pool.query('SELECT nombre FROM global_usuarios WHERE id = $1', [s.asesor_uuid]),
  ]);
  if (!c) throw new ErrorNegocio(409, 'El crédito no tiene cierre de Cartera');
  const claves = itemsAplicables({ solicitud: s, cierre: c });
  const nombre = `${aso?.nombre ?? ''} ${aso?.apellido ?? ''}`.replace(/\s+/g, ' ').trim();
  const bloqueo = s.estado !== 'completada' ? 'Este crédito ya no está pendiente de revisión' : (s.completada_por === user.id ? 'Tú completaste este crédito en Cartera: lo debe revisar otra persona' : null);
  return {
    id: s.id, radicado: s.radicado, estado: s.estado, categoria: cat?.nombre, empresa: aso?.empresa, forma_desembolso: s.forma_desembolso, modalidad_firma: s.modalidad_firma,
    completada_at: s.completada_at, completada_por_nombre: cpor?.nombre, entregada_at: s.entregada_at, recibida_at: s.recibida_at, radicada_at: s.created_at,
    asesor_nombre: ase?.nombre, proveedor_externo: s.proveedor_externo ?? null, observaciones: s.observaciones ?? null,
    asociado: { codigo: s.asociado_codigo, nombre },
    valores: {
      valor_solicitado: Number(s.valor_solicitado), aval_porcentaje: c.con_aval ? Number(c.aval_porcentaje) : null, aval_valor: Number(c.aval_valor),
      firma_electronica_valor: Number(c.firma_electronica_valor), desembolso_neto: Number(c.desembolso_neto),
    },
    cuenta: s.forma_desembolso === 'transferencia'
      ? { banco: c.banco, tipo_cuenta: c.tipo_cuenta, numero_cuenta: c.numero_cuenta, titular_nombre: c.titular_nombre, titular_documento: c.titular_documento, titular_es_asociado: norm(c.titular_documento) === norm(s.asociado_codigo) }
      : null,
    autorizacion: { requerida: s.autorizacion_requerida, estado: aut?.estado ?? null, fecha: aut?.fecha_autorizacion ?? null, canal: aut?.canal ?? null },
    documentos: docs, revisiones, eventos, orden: orden ?? null,
    lista: claves.map((k) => ({ clave: k, texto: LISTA[k] })),
    puede_revisar: !bloqueo, motivo_bloqueo: bloqueo,
  };
};

export const urlCertificado = async (id) => {
  const { rows: [d] } = await pool.query(
    `SELECT archivo_id FROM credito_documentos WHERE solicitud_id = $1 AND clase = 'adjunto' AND tipo = 'certificado_bancario' AND vigente ORDER BY created_at DESC LIMIT 1`, [id]);
  if (!d) throw new ErrorNegocio(404, 'Este crédito no tiene certificado bancario');
  const url = await generarPresignedDescarga(d.archivo_id);
  if (!url) throw new ErrorNegocio(404, 'No se encontró el certificado');
  return url;   // { url, nombre, mime }
};

export const revisar = async (user, id, { decision, lista = {}, destino, motivo }, ip) => {
  const res = await conTransaccion(async (cn) => {
    const { solicitud: s, cierre: c } = await cargarCierre(id, cn, { bloquear: true });
    if (s.estado !== 'completada') throw new ErrorNegocio(409, 'Este crédito no está pendiente de revisión de Control Interno');
    if (s.completada_por === user.id) throw new ErrorNegocio(403, 'No puedes revisar un crédito que tú mismo completaste en Cartera');
    if (!c) throw new ErrorNegocio(409, 'El crédito no tiene cierre de Cartera');

    if (decision === 'devuelta') {
      if (!motivo || motivo.trim().length < 3) throw new ErrorNegocio(400, 'Explica qué está mal (motivo obligatorio)');
      const nuevo = destino === 'asesor' ? 'devuelta' : 'recibida';
      await cn.query(
        `UPDATE credito_solicitudes SET estado = $2::varchar, completada_at = NULL, completada_por = NULL, monto_desembolso = NULL,
                devuelta_at = CASE WHEN $2::text = 'devuelta' THEN NOW() ELSE devuelta_at END, devuelta_motivo = CASE WHEN $2::text = 'devuelta' THEN $3::text ELSE devuelta_motivo END,
                updated_at = NOW() WHERE id = $1`, [id, nuevo, motivo.trim()]);
      await cn.query(`INSERT INTO credito_revisiones_ci (solicitud_id, decision, destino, motivo, lista, revisor_uuid) VALUES ($1, 'devuelta', $2, $3, $4, $5)`, [id, destino, motivo.trim(), JSON.stringify(lista), user.id]);
      await evento(id, 'devuelta_por_control_interno', { destino, motivo: motivo.trim() }, { autorUuid: user.id, ip }, cn);
      return { estado: nuevo, s };
    }

    // Aprobar: todos los ítems que aplican deben estar marcados
    const claves = itemsAplicables({ solicitud: s, cierre: c });
    const sinMarcar = claves.filter((k) => lista[k] !== true);
    if (sinMarcar.length) throw new ErrorNegocio(400, 'Falta marcar la verificación de: ' + sinMarcar.map((k) => LISTA[k]).join(' | '), { faltantes: sinMarcar });
    const neto = Number(c.desembolso_neto);
    if (!(neto > 0)) throw new ErrorNegocio(409, 'El desembolso neto debe ser mayor que cero');

    const asoc = (await cn.query(`SELECT nombre, apellido FROM asociados WHERE codigo = $1`, [s.asociado_codigo])).rows[0];
    const nombre = `${asoc?.nombre ?? ''} ${asoc?.apellido ?? ''}`.replace(/\s+/g, ' ').trim().toUpperCase();
    const transferencia = s.forma_desembolso === 'transferencia';
    const foto = {
      solicitud_id: s.id, radicado: s.radicado, asociado_codigo: s.asociado_codigo, asociado_nombre: nombre, forma_pago: s.forma_desembolso, monto: neto,
      banco: transferencia ? c.banco : null, tipo_cuenta: transferencia ? c.tipo_cuenta : null, numero_cuenta: transferencia ? c.numero_cuenta : null,
      titular_nombre: transferencia ? c.titular_nombre : null, titular_documento: transferencia ? c.titular_documento : null,
    };
    const esAsociado = !transferencia || norm(c.titular_documento) === norm(s.asociado_codigo);
    const { rows: [orden] } = await cn.query(
      `INSERT INTO credito_ordenes_pago (solicitud_id, radicado, asociado_codigo, asociado_nombre, forma_pago, monto, banco, tipo_cuenta, numero_cuenta, titular_nombre, titular_documento,
                                         titular_es_asociado, huella, aprobada_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [s.id, foto.radicado, foto.asociado_codigo, foto.asociado_nombre, foto.forma_pago, foto.monto, foto.banco, foto.tipo_cuenta, foto.numero_cuenta, foto.titular_nombre, foto.titular_documento,
        esAsociado, huellaOrden(foto), user.id]);
    await cn.query(`UPDATE credito_solicitudes SET estado = 'en_tesoreria', updated_at = NOW() WHERE id = $1`, [id]);
    await cn.query(`INSERT INTO credito_revisiones_ci (solicitud_id, decision, lista, revisor_uuid) VALUES ($1, 'aprobada', $2, $3)`, [id, JSON.stringify(lista), user.id]);
    await evento(id, 'aprobada_por_control_interno', { orden_id: orden.id, monto: neto, forma_pago: s.forma_desembolso, titular_es_asociado: esAsociado }, { autorUuid: user.id, ip }, cn);
    return { estado: 'en_tesoreria', s, orden_id: orden.id };
  });

  if (res.estado === 'en_tesoreria') {
    await notificarPorPermiso('tesoreria', { tipo: 'creditos', mensaje: `Desembolso por pagar: crédito ${res.s.radicado}` }).catch(() => {});
    await notificarUsuario(res.s.asesor_uuid, { tipo: 'creditos', modulo: 'creditos', mensaje: `Control Interno aprobó el crédito ${res.s.radicado}: pasa a Tesorería` }).catch(() => {});
  } else {
    await notificarUsuario(res.s.asesor_uuid, { tipo: 'creditos', modulo: 'creditos', mensaje: `Control Interno devolvió el crédito ${res.s.radicado}: ${motivo}` }).catch(() => {});
    if (destino === 'cartera') await notificarPorPermiso('cartera', { tipo: 'creditos', mensaje: `Control Interno devolvió el crédito ${res.s.radicado} a Cartera: ${motivo}` }).catch(() => {});
  }
  return { estado: res.estado, orden_id: res.orden_id ?? null };
};

// ── Tesorería ─────────────────────────────────────────────────────────────────
const HOY_BOGOTA = "(NOW() AT TIME ZONE 'America/Bogota')::date";
const DIA = (col) => `(${col} AT TIME ZONE 'America/Bogota')::date`;
// Días que lleva esperando (pendiente) o que esperó hasta pagarse (pagada); una orden devuelta no tiene un cierre registrado
const DIAS_ESPERA = `CASE WHEN o.estado = 'pendiente' THEN GREATEST(0, ${HOY_BOGOTA} - ${DIA('o.aprobada_at')})
                         WHEN o.estado = 'pagada' THEN GREATEST(0, ${DIA('o.pagada_at')} - ${DIA('o.aprobada_at')}) END`;
const COLUMNAS_ORDEN = `
  o.id, o.solicitud_id, o.estado, o.radicado, o.asociado_codigo, o.asociado_nombre, o.forma_pago, o.monto, o.banco, o.tipo_cuenta, o.numero_cuenta,
  o.titular_nombre, o.titular_documento, o.titular_es_asociado, o.aprobada_at, o.fecha_pago, o.referencia_pago, o.pagada_at, o.anulada_motivo,
  o.cuenta_origen_id, ct.nombre AS cuenta_origen_nombre, ua.nombre AS aprobada_por_nombre, up.nombre AS pagada_por_nombre, o.aprobada_por,
  s.empresa_codigo, e.nombre AS empresa_nombre, ${DIAS_ESPERA} AS dias_espera`;
const FROM_ORDEN = `
  FROM credito_ordenes_pago o
  JOIN credito_solicitudes s ON s.id = o.solicitud_id
  JOIN empresas e ON e.codigo = s.empresa_codigo
  LEFT JOIN tesoreria_cuentas ct ON ct.id = o.cuenta_origen_id
  LEFT JOIN global_usuarios ua ON ua.id = o.aprobada_por
  LEFT JOIN global_usuarios up ON up.id = o.pagada_por`;
const ORDEN_SQL_ORDENES = { aprobada: 'o.aprobada_at', monto: 'o.monto', dias: 'o.aprobada_at', asociado: 'o.asociado_nombre', radicado: 'o.radicado', pago: 'o.fecha_pago' };
export const LIMITE_ORDENES = 500;

/** WHERE de la lista. `sinEstado` lo omite (para los contadores de cada pestaña). */
const filtrosOrdenes = (f = {}, { sinEstado = false } = {}) => {
  const where = ['1 = 1'];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (!sinEstado && f.estado && f.estado !== 'todas') where.push(`o.estado = ${p(f.estado)}`);
  if (f.q && String(f.q).trim().length >= 2) {
    const n = p(`%${String(f.q).trim()}%`);
    where.push(`(o.radicado ILIKE ${n} OR o.asociado_codigo ILIKE ${n} OR o.asociado_nombre ILIKE ${n} OR o.titular_nombre ILIKE ${n} OR o.referencia_pago ILIKE ${n})`);
  }
  if (f.forma) where.push(`o.forma_pago = ${p(f.forma)}`);
  if (f.empresa) where.push(`s.empresa_codigo = ${p(f.empresa)}`);
  if (f.aprobador) where.push(`o.aprobada_por = ${p(f.aprobador)}`);
  if (f.cuenta) where.push(`o.cuenta_origen_id = ${p(f.cuenta)}`);
  if (f.desde) where.push(`${DIA('o.aprobada_at')} >= ${p(f.desde)}::date`);
  if (f.hasta) where.push(`${DIA('o.aprobada_at')} <= ${p(f.hasta)}::date`);
  if (f.min != null) where.push(`o.monto >= ${p(f.min)}`);
  if (f.max != null) where.push(`o.monto <= ${p(f.max)}`);
  if (f.dias != null) where.push(`(${DIAS_ESPERA}) >= ${p(f.dias)}`);
  if (f.tercero) where.push('o.titular_es_asociado = false');
  return { where: where.join(' AND '), params };
};

export const listarOrdenes = async (user, f = {}) => {
  if (f.estado && !['pendiente', 'pagada', 'anulada', 'todas'].includes(f.estado)) throw new ErrorNegocio(400, 'Estado inválido');
  const estado = f.estado ?? 'pendiente';
  const { where, params } = filtrosOrdenes({ ...f, estado });
  const columna = ORDEN_SQL_ORDENES[f.orden];
  // "dias" ordena por espera: la aprobación más vieja es la de más días
  const dir = f.orden === 'dias' ? (f.dir === 'asc' ? 'DESC' : 'ASC') : (f.dir === 'asc' ? 'ASC' : 'DESC');
  // Sin orden elegido: lo por pagar, lo más antiguo primero (FIFO); lo demás, lo más reciente primero
  const orden = columna ? `${columna} ${dir}`
    : estado === 'pendiente' ? 'o.aprobada_at ASC'
      : estado === 'todas' ? "CASE WHEN o.estado = 'pendiente' THEN o.aprobada_at END ASC NULLS LAST, COALESCE(o.pagada_at, o.aprobada_at) DESC"
        : 'COALESCE(o.pagada_at, o.aprobada_at) DESC';
  const { rows } = await pool.query(`SELECT ${COLUMNAS_ORDEN} ${FROM_ORDEN} WHERE ${where} ORDER BY ${orden}, o.id LIMIT ${LIMITE_ORDENES}`, params);
  // Quién puede pagar cada orden: hay que tener el permiso y no haber sido quien la aprobó en Control Interno (segregación de funciones)
  const tienePermiso = await tieneAccion(user, 'tesoreria', 'PAGAR_CREDITOS');
  return rows.map(({ aprobada_por: aprobadaPor, ...o }) => {
    const bloqueo = o.estado !== 'pendiente' ? null
      : !tienePermiso ? 'No tienes el permiso para pagar desembolsos'
        : aprobadaPor === user.id ? 'Tú aprobaste este crédito en Control Interno: lo debe pagar otra persona' : null;
    // Devolver una orden que no se puede pagar solo pide el permiso: quien la aprobó también puede señalar que hay un problema
    return { ...o, puede_pagar: o.estado === 'pendiente' && !bloqueo, puede_devolver: o.estado === 'pendiente' && tienePermiso, motivo_bloqueo: bloqueo };
  });
};

/** Conteo y monto por estado con los mismos filtros (sin estado): contadores de las pestañas y columnas del tablero */
export const resumenOrdenes = async (f = {}) => {
  const { where, params } = filtrosOrdenes(f, { sinEstado: true });
  const { rows } = await pool.query(`SELECT o.estado, COUNT(*)::int AS n, COALESCE(SUM(o.monto), 0)::numeric AS valor ${FROM_ORDEN} WHERE ${where} GROUP BY o.estado`, params);
  return { limite: LIMITE_ORDENES, estados: rows.map((r) => ({ estado: r.estado, n: r.n, valor: Number(r.valor) })) };
};

/** Empresas, quienes aprobaron y cuentas de origen que aparecen en las órdenes, para armar los filtros */
export const opcionesOrdenes = async () => {
  const [{ rows: empresas }, { rows: aprobadores }, { rows: cuentas }] = await Promise.all([
    pool.query(`SELECT DISTINCT e.codigo, e.nombre ${FROM_ORDEN} ORDER BY e.nombre`),
    pool.query(`SELECT DISTINCT ua.id, ua.nombre ${FROM_ORDEN} WHERE ua.id IS NOT NULL ORDER BY ua.nombre`),
    pool.query(`SELECT DISTINCT ct.id, ct.nombre ${FROM_ORDEN} WHERE ct.id IS NOT NULL ORDER BY ct.nombre`),
  ]);
  return { empresas, aprobadores, cuentas };
};

const cargarOrden = async (id, db = pool, bloquear = false) => {
  const { rows: [o] } = await db.query(`SELECT * FROM credito_ordenes_pago WHERE id = $1 ${bloquear ? 'FOR UPDATE' : ''}`, [id]);
  if (!o) throw new ErrorNegocio(404, 'Orden de pago no encontrada');
  return o;
};

export const pagar = async (user, id, { cuenta_origen_id: cuentaId, referencia, fecha_pago: fechaPago }, ip) => {
  const res = await conTransaccion(async (cn) => {
    const o = await cargarOrden(id, cn, true);
    if (o.estado !== 'pendiente') throw new ErrorNegocio(409, o.estado === 'pagada' ? 'Esta orden ya fue pagada' : 'Esta orden fue anulada');
    if (o.aprobada_por === user.id) throw new ErrorNegocio(403, 'No puedes pagar un desembolso que tú mismo aprobaste en Control Interno');
    // Que la foto no se haya alterado desde la aprobación
    if (huellaOrden(o) !== o.huella) {
      logger.error(`creditos: la huella de la orden ${o.id} no coincide (posible alteración)`);
      throw new ErrorNegocio(409, 'Los datos de la orden no coinciden con lo aprobado. No se paga: avisa a Control Interno');
    }
    const { rows: [cuenta] } = await cn.query(`SELECT id, nombre, tipo, is_active FROM tesoreria_cuentas WHERE id = $1`, [cuentaId]);
    if (!cuenta || !cuenta.is_active) throw new ErrorNegocio(400, 'La cuenta de origen no existe o está inactiva');
    if (cuenta.tipo === 'tarjeta') throw new ErrorNegocio(400, 'No se paga un desembolso con una tarjeta de crédito');
    if (o.forma_pago !== 'efectivo' && cuenta.tipo !== 'banco') throw new ErrorNegocio(400, 'Una transferencia o un cheque salen de una cuenta bancaria de la cooperativa');
    if (fechaPago > new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' })) throw new ErrorNegocio(400, 'La fecha de pago no puede ser futura');
    const diaAprobacion = new Date(o.aprobada_at).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    if (fechaPago < diaAprobacion) throw new ErrorNegocio(400, `La fecha de pago no puede ser anterior a la aprobación de Control Interno (${diaAprobacion})`);
    const { rowCount: repetida } = await cn.query(
      `SELECT 1 FROM credito_ordenes_pago WHERE estado = 'pagada' AND cuenta_origen_id = $1 AND lower(referencia_pago) = lower($2)`, [cuentaId, referencia]);
    if (repetida) throw new ErrorNegocio(409, 'Esa referencia ya se usó en otro desembolso desde esta cuenta');

    const { rows: [per] } = await cn.query(`SELECT id, estado FROM tesoreria_periodos WHERE fecha_inicio <= $1 AND fecha_fin >= $1 ORDER BY fecha_inicio DESC LIMIT 1`, [fechaPago]);
    if (per?.estado === 'cerrado') throw new ErrorNegocio(400, 'El período contable de esa fecha está cerrado');
    const { rows: [cat] } = await cn.query(`SELECT id FROM tesoreria_categorias WHERE nombre = 'Desembolso de crédito' AND is_active LIMIT 1`);
    const destino = o.forma_pago === 'transferencia' ? ` por transferencia a ${o.banco} ${o.tipo_cuenta} ****${ultimos4(o.numero_cuenta)}` : ` en ${o.forma_pago}`;
    const { rows: [mov] } = await cn.query(
      `INSERT INTO tesoreria_movimientos (tipo, monto, fecha, descripcion, referencia, tercero_nombre, cuenta_id, categoria_id, periodo_id, registrado_por)
       VALUES ('egreso', $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [o.monto, fechaPago, `Desembolso crédito ${o.radicado} — ${o.asociado_nombre} C.C. ${o.asociado_codigo}${destino}`, referencia, o.asociado_nombre, cuentaId, cat?.id ?? null, per?.id ?? null, user.id]);
    await cn.query(
      `UPDATE credito_ordenes_pago SET estado = 'pagada', cuenta_origen_id = $2, referencia_pago = $3, fecha_pago = $4, movimiento_id = $5, pagada_por = $6, pagada_at = NOW() WHERE id = $1`,
      [id, cuentaId, referencia, fechaPago, mov.id, user.id]);
    await cn.query(`UPDATE credito_solicitudes SET estado = 'pagada', updated_at = NOW() WHERE id = $1`, [o.solicitud_id]);
    await evento(o.solicitud_id, 'desembolso_pagado', { orden_id: id, monto: Number(o.monto), referencia, cuenta_origen: cuenta.nombre, fecha_pago: fechaPago, movimiento_id: mov.id }, { autorUuid: user.id, ip }, cn);
    return { o, movimiento_id: mov.id };
  });
  const { rows: [s] } = await pool.query('SELECT asesor_uuid FROM credito_solicitudes WHERE id = $1', [res.o.solicitud_id]);
  await notificarUsuario(s.asesor_uuid, { tipo: 'creditos', modulo: 'creditos', mensaje: `Tesorería pagó el desembolso del crédito ${res.o.radicado}` }).catch(() => {});
  return { ok: true, movimiento_id: res.movimiento_id };
};

/** Tesorería no puede pagar (datos dudosos): anula la orden y el crédito vuelve a Control Interno */
export const devolverAControlInterno = async (user, id, { motivo }, ip) => {
  const res = await conTransaccion(async (cn) => {
    const o = await cargarOrden(id, cn, true);
    if (o.estado !== 'pendiente') throw new ErrorNegocio(409, 'Solo se devuelve una orden pendiente');
    await cn.query(`UPDATE credito_ordenes_pago SET estado = 'anulada', anulada_motivo = $2 WHERE id = $1`, [id, motivo.trim()]);
    await cn.query(`UPDATE credito_solicitudes SET estado = 'completada', updated_at = NOW() WHERE id = $1`, [o.solicitud_id]);
    await evento(o.solicitud_id, 'devuelta_por_tesoreria', { orden_id: id, motivo: motivo.trim() }, { autorUuid: user.id, ip }, cn);
    return o;
  });
  await notificarPorPermiso('control_interno', { tipo: 'creditos', mensaje: `Tesorería devolvió el crédito ${res.radicado}: ${motivo}` }).catch(() => {});
  return { ok: true };
};
