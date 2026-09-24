import { z } from 'zod';

const hoyMax = /^\d{4}-\d{2}-\d{2}$/;

// Control Interno: aprueba (con la lista de verificación) o devuelve (a Cartera o al asesor, con motivo)
export const revisionSchema = z.object({
  decision: z.enum(['aprobada', 'devuelta']),
  lista:    z.record(z.string().max(30), z.boolean()).default({}),
  destino:  z.enum(['cartera', 'asesor']).optional(),
  motivo:   z.string().trim().min(3, 'Explica qué está mal').max(1000).optional(),
}).strict().superRefine((d, ctx) => {
  if (d.decision === 'devuelta') {
    if (!d.destino) ctx.addIssue({ code: 'custom', path: ['destino'], message: 'Indica a quién se devuelve (Cartera o asesor)' });
    if (!d.motivo) ctx.addIssue({ code: 'custom', path: ['motivo'], message: 'Explica qué está mal' });
  }
});

// Tesorería: paga una orden aprobada
export const pagoSchema = z.object({
  cuenta_origen_id: z.string().uuid('Elige la cuenta de la cooperativa de la que sale el dinero'),
  referencia:       z.string().trim().min(3, 'Escribe la referencia del banco (o el número de cheque / recibo)').max(100),
  fecha_pago:       z.string().regex(hoyMax, 'Fecha inválida'),
}).strict();

export const devolverTesoreriaSchema = z.object({ motivo: z.string().trim().min(3, 'Explica por qué no se puede pagar').max(1000) }).strict();
