import { manejar } from '../../creditos/http.js';
import * as cierre from '../../cartera/services/cierreService.js';
import * as ci from '../services/creditosCIService.js';
import { listarCISchema } from '../../creditos/schemas/creditosSchema.js';

// Bandeja de Control Interno: por pestaña (por revisar, en Tesorería, pagados, devueltos), con filtros, orden y resumen
export const listar = manejar(async (req, res) => res.json(await ci.listarCI(listarCISchema.parse(req.query))));
export const resumen = manejar(async (req, res) => res.json(await ci.resumenCI(listarCISchema.parse(req.query))));
export const filtros = manejar(async (req, res) => res.json(await ci.opcionesCI()));

import * as desembolso from '../../creditos/services/desembolsoService.js';
import { revisionSchema } from '../../creditos/schemas/desembolsoSchema.js';

export const detalle = manejar(async (req, res) => res.json(await desembolso.detalleRevision(req.user, req.params.id)));
export const certificado = manejar(async (req, res) => res.json(await desembolso.urlCertificado(req.params.id)));
export const revisar = manejar(async (req, res) => res.json(await desembolso.revisar(req.user, req.params.id, revisionSchema.parse(req.body), req.ip)));

export const pdfFinal = manejar(async (req, res) => {
  const { buf, nombre } = await cierre.generarPdfFinal(req.user, req.params.id, req.ip, { ambitoCartera: false });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${nombre}"`, 'Cache-Control': 'no-store' }).send(buf);
});
