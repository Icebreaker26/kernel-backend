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

// Lista de desembolsos de Tesorería (todos los filtros son opcionales; llegan como texto en la URL)
const vacioAUndef = (v) => (v === '' || v === null ? undefined : v);
const uuidOpc = z.preprocess(vacioAUndef, z.string().uuid().optional());
const fechaOpc = z.preprocess(vacioAUndef, z.string().regex(hoyMax, 'Fecha inválida (AAAA-MM-DD)').optional());
const numeroOpc = z.preprocess((v) => (v === '' || v == null ? undefined : Number(v)), z.number().min(0).max(9_999_999_999).optional());
export const ESTADOS_ORDEN = ['pendiente', 'pagada', 'anulada'];
export const ORDEN_DESEMBOLSOS = ['aprobada', 'monto', 'dias', 'asociado', 'radicado', 'pago'];
export const listarOrdenesSchema = z.object({
  estado:   z.preprocess(vacioAUndef, z.enum([...ESTADOS_ORDEN, 'todas']).default('pendiente')),
  q:        z.preprocess(vacioAUndef, z.string().trim().max(80).optional()),
  forma:    z.preprocess(vacioAUndef, z.enum(['transferencia', 'cheque', 'efectivo']).optional()),
  empresa:  z.preprocess(vacioAUndef, z.string().trim().max(60).optional()),
  aprobador: uuidOpc,
  cuenta:   uuidOpc,                      // cuenta de la cooperativa de la que salió el pago
  desde:    fechaOpc,                     // fecha de aprobación en Control Interno
  hasta:    fechaOpc,
  min:      numeroOpc,                    // monto
  max:      numeroOpc,
  dias:     z.preprocess((v) => (v === '' || v == null ? undefined : Number(v)), z.number().int().min(0).max(3650).optional()),   // días de espera
  tercero:  z.preprocess((v) => v === '1' || v === 'true' || v === true, z.boolean()).optional(),   // solo cuentas de un tercero
  orden:    z.preprocess(vacioAUndef, z.enum(ORDEN_DESEMBOLSOS).optional()),
  dir:      z.preprocess(vacioAUndef, z.enum(['asc', 'desc']).optional()),
}).strict().superRefine((d, ctx) => {
  if (d.desde && d.hasta && d.desde > d.hasta) ctx.addIssue({ code: 'custom', path: ['hasta'], message: 'La fecha final es anterior a la inicial' });
  if (d.min != null && d.max != null && d.min > d.max) ctx.addIssue({ code: 'custom', path: ['max'], message: 'El monto máximo es menor que el mínimo' });
});
