import { manejar } from '../../creditos/http.js';
import * as svc from '../../creditos/services/desembolsoService.js';
import { pagoSchema, devolverTesoreriaSchema, listarOrdenesSchema } from '../../creditos/schemas/desembolsoSchema.js';

// Tesorería paga los créditos aprobados por Control Interno: una orden de pago por crédito
export const listar = manejar(async (req, res) => res.json(await svc.listarOrdenes(req.user, listarOrdenesSchema.parse(req.query))));
export const resumen = manejar(async (req, res) => res.json(await svc.resumenOrdenes(listarOrdenesSchema.parse(req.query))));
export const filtros = manejar(async (req, res) => res.json(await svc.opcionesOrdenes()));
export const pagar = manejar(async (req, res) => res.json(await svc.pagar(req.user, req.params.ordenId, pagoSchema.parse(req.body), req.ip)));
export const devolver = manejar(async (req, res) => res.json(await svc.devolverAControlInterno(req.user, req.params.ordenId, devolverTesoreriaSchema.parse(req.body), req.ip)));
