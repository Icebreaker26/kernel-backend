import { manejar } from '../../creditos/http.js';
import * as cierre from '../../cartera/services/cierreService.js';

// Bandeja de Control Interno: créditos que Cartera marcó como COMPLETADOS (por ahora solo la cola y el PDF final; la validación se define aparte)
export const listar = manejar(async (req, res) => res.json(await cierre.listarCompletadas()));

import * as desembolso from '../../creditos/services/desembolsoService.js';
import { revisionSchema } from '../../creditos/schemas/desembolsoSchema.js';

export const detalle = manejar(async (req, res) => res.json(await desembolso.detalleRevision(req.user, req.params.id)));
export const certificado = manejar(async (req, res) => res.json(await desembolso.urlCertificado(req.params.id)));
export const revisar = manejar(async (req, res) => res.json(await desembolso.revisar(req.user, req.params.id, revisionSchema.parse(req.body), req.ip)));

export const pdfFinal = manejar(async (req, res) => {
  const { buf, nombre } = await cierre.generarPdfFinal(req.user, req.params.id, req.ip, { ambitoCartera: false });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${nombre}"`, 'Cache-Control': 'no-store' }).send(buf);
});
