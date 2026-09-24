import { manejar } from '../http.js';
import * as svc from '../services/creditoService.js';
import {
  radicarSchema, actualizarSchema, borradorSchema, adjuntoSchema, firmaExternaSchema, firmadoSchema,
  autorizacionEnviarSchema, autorizacionRegistrarSchema, cierreSchema, configEmpresaSchema, reasignarSchema, listarSchema,
} from '../schemas/creditosSchema.js';

// ── Catálogos y búsqueda ──────────────────────────────────────────────────────
export const categorias = manejar(async (req, res) => res.json(await svc.listarCategorias()));
export const buscarAsociados = manejar(async (req, res) => res.json(await svc.buscarAsociados(req.query.q)));
export const documentosDeAsociado = manejar(async (req, res) => res.json(await svc.documentosDeAsociado(req.user, req.params.codigo)));
export const urlArchivoDeAsociado = manejar(async (req, res) => res.json(await svc.urlArchivoDeAsociado(req.user, req.params.codigo, req.params.archivoId, req.ip)));
export const infoAsociado = manejar(async (req, res) => res.json(await svc.infoAsociado(req.params.codigo)));

// ── Solicitudes ───────────────────────────────────────────────────────────────
export const listar = manejar(async (req, res) => res.json(await svc.listar(req.user, listarSchema.parse(req.query))));
export const resumen = manejar(async (req, res) => res.json(await svc.resumenLista(req.user, listarSchema.parse(req.query))));
export const filtros = manejar(async (req, res) => res.json(await svc.opcionesFiltros(req.user, { todas: req.query.todas === '1' })));

export const radicar = manejar(async (req, res) => {
  const data = radicarSchema.parse(req.body);
  const r = await svc.radicar(req.user, data, req.ip);
  res.status(r.duplicada ? 200 : 201).json(r);
});

export const obtener = manejar(async (req, res) => res.json(await svc.detalle(req.user, req.params.id)));

export const actualizar = manejar(async (req, res) => {
  res.json(await svc.actualizar(req.user, req.params.id, actualizarSchema.parse(req.body), req.ip));
});

// ── Documentos ────────────────────────────────────────────────────────────────
export const subirBorrador = manejar(async (req, res) => {
  res.status(201).json(await svc.subirBorrador(req.user, req.params.id, borradorSchema.parse(req.body), req.file, req.ip));
});

export const subirAdjunto = manejar(async (req, res) => {
  res.status(201).json(await svc.subirAdjunto(req.user, req.params.id, adjuntoSchema.parse(req.body), req.file, req.ip));
});

export const quitarDocumento = manejar(async (req, res) => {
  await svc.quitarDocumento(req.user, req.params.id, req.params.docId, req.ip);
  res.json({ ok: true });
});

export const firmaExterna = manejar(async (req, res) => {
  const data = firmaExternaSchema.parse(req.body);
  res.status(201).json(await svc.registrarFirmaExterna(req.user, req.params.id, data, req.files?.archivo?.[0], req.files?.evidencia?.[0], req.ip));
});

export const registrarFirmado = manejar(async (req, res) => {
  res.status(201).json(await svc.registrarFirmadoPresencial(req.user, req.params.id, firmadoSchema.parse(req.body), req.file, req.ip));
});

export const contenidoParaFirma = manejar(async (req, res) => {
  const { buf, nombre } = await svc.contenidoParaFirma(req.user, req.params.id, req.params.docId);
  res.set({ 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store', 'Content-Disposition': `inline; filename="${encodeURIComponent(nombre)}"` }).send(buf);
});

export const urlArchivo = manejar(async (req, res) => res.json(await svc.urlArchivo(req.user, req.params.id, req.params.archivoId, req.ip)));
export const integridad = manejar(async (req, res) => res.json(await svc.verificarIntegridad(req.user, req.params.id)));

// ── Autorización de la empresa ────────────────────────────────────────────────
export const enviarAutorizacion = manejar(async (req, res) => {
  res.json(await svc.enviarAutorizacion(req.user, req.params.id, autorizacionEnviarSchema.parse(req.body ?? {}), req.ip));
});

export const registrarAutorizacion = manejar(async (req, res) => {
  res.status(201).json(await svc.registrarAutorizacion(req.user, req.params.id, autorizacionRegistrarSchema.parse(req.body), req.file, req.ip));
});

// ── Transiciones ──────────────────────────────────────────────────────────────
export const entregar = manejar(async (req, res) => {
  await svc.entregar(req.user, req.params.id, req.ip);
  res.json({ ok: true });
});

export const cerrar = manejar(async (req, res) => {
  await svc.cerrar(req.user, req.params.id, cierreSchema.parse(req.body), req.ip);
  res.json({ ok: true });
});

export const listarAsesores = manejar(async (req, res) => res.json(await svc.listarAsesores(req.user)));
export const reasignar = manejar(async (req, res) => {
  res.json(await svc.reasignar(req.user, req.params.id, reasignarSchema.parse(req.body), req.ip));
});

// ── Configuración por empresa ─────────────────────────────────────────────────
export const listarConfigEmpresas = manejar(async (req, res) => res.json(await svc.listarConfigEmpresas(req.query.q)));
export const guardarConfigEmpresa = manejar(async (req, res) => {
  res.json(await svc.guardarConfigEmpresa(req.user, req.params.codigo, configEmpresaSchema.parse(req.body)));
});
