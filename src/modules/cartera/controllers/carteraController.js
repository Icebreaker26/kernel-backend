import { manejar } from '../../creditos/http.js';
import * as svc from '../../creditos/services/creditoService.js';
import { devolverSchema } from '../../creditos/schemas/creditosSchema.js';
import * as cierre from '../services/cierreService.js';
import { cierreSchema, tipoDocumentoSchema, firmadoSchema, tarifaSchema, mesSchema } from '../schemas/carteraSchema.js';

// Cartera trabaja sobre los mismos expedientes que Créditos (misma lógica y misma regla de "listo"); aquí solo cambia el ACL
export const listar = manejar(async (req, res) => res.json(await svc.listarCartera({ tab: req.query.tab, q: req.query.q })));
export const obtener = manejar(async (req, res) => res.json(await svc.detalle(req.user, req.params.id)));
export const urlArchivo = manejar(async (req, res) => res.json(await svc.urlArchivo(req.user, req.params.id, req.params.archivoId, req.ip)));
export const integridad = manejar(async (req, res) => res.json(await svc.verificarIntegridad(req.user, req.params.id)));

export const expediente = manejar(async (req, res) => {
  const { buf, nombre } = await svc.armarExpediente(req.user, req.params.id, req.ip);
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${nombre}"`, 'Cache-Control': 'no-store' }).send(buf);
});

export const recibir = manejar(async (req, res) => {
  await svc.recibir(req.user, req.params.id, req.ip);
  res.json({ ok: true });
});

export const devolver = manejar(async (req, res) => {
  await svc.devolver(req.user, req.params.id, devolverSchema.parse(req.body), req.ip);
  res.json({ ok: true });
});

// ── Cierre: documentos de Cartera, aval, sellos, PDF final, completar ─────────

export const obtenerCierre = manejar(async (req, res) => res.json(await cierre.obtenerCierre(req.user, req.params.id)));
export const guardarCierre = manejar(async (req, res) => res.json(await cierre.guardarCierre(req.user, req.params.id, cierreSchema.parse(req.body), req.ip)));
export const subirDocumento = manejar(async (req, res) => res.status(201).json(await cierre.subirDocumento(req.user, req.params.id, tipoDocumentoSchema.parse(req.body), req.file, req.ip)));
export const contenidoDocumento = manejar(async (req, res) => {
  const { buf, nombre } = await cierre.contenidoParaFirma(req.user, req.params.id, req.params.docId);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${encodeURIComponent(nombre)}"`, 'Cache-Control': 'no-store' }).send(buf);
});
export const registrarFirmado = manejar(async (req, res) => res.status(201).json(await cierre.registrarFirmado(req.user, req.params.id, firmadoSchema.parse(req.body), req.file, req.ip)));
export const completar = manejar(async (req, res) => res.json(await cierre.completar(req.user, req.params.id, req.ip)));

export const pdfFinal = manejar(async (req, res) => {
  const { buf, nombre, omitidos } = await cierre.generarPdfFinal(req.user, req.params.id, req.ip);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${nombre}"`, 'Cache-Control': 'no-store', 'X-Documentos-Omitidos': String(omitidos.length) }).send(buf);
});

export const obtenerParametros = manejar(async (req, res) => res.json({ tarifa_firma_electronica: await cierre.obtenerTarifa(), puede_configurar: await svc.tieneAccion(req.user, 'cartera', 'CONFIGURAR') }));
export const guardarTarifa = manejar(async (req, res) => res.json({ tarifa_firma_electronica: await cierre.guardarTarifa(req.user, tarifaSchema.parse(req.body).valor) }));

const reporte = (buscar, columnas, prefijo) => manejar(async (req, res) => {
  const { mes, formato } = mesSchema.parse(req.query);
  const filas = await buscar(mes);
  if (formato === 'csv') {
    return res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${prefijo}_${mes}.csv"`, 'Cache-Control': 'no-store' }).send(cierre.aCsv(columnas, filas));
  }
  return res.json({ mes, filas });
});
export const avalesDelMes = reporte(cierre.avalesDelMes, cierre.COLUMNAS_AVALES, 'avales');
export const firmasElectronicasDelMes = reporte(cierre.firmasElectronicasDelMes, cierre.COLUMNAS_FIRMAS, 'firmas_electronicas');

export const comprobante = manejar(async (req, res) => {
  const { buf, nombre } = await cierre.contenidoComprobante(req.user, req.params.id);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${encodeURIComponent(nombre)}"`, 'Cache-Control': 'no-store' }).send(buf);
});
