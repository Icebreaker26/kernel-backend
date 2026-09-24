import { manejar } from '../../creditos/http.js';
import * as svc from '../../creditos/services/creditoService.js';
import { devolverSchema } from '../../creditos/schemas/creditosSchema.js';

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
