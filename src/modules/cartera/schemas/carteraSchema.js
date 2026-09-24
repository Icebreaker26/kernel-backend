import { z } from 'zod';

const fraccion = z.number().min(0).max(1);
const posicion = z.object({ pagina: z.number().int().min(0).max(2000), x: fraccion, y: fraccion }).strict();

// Cuenta a la que se paga el crédito (solo si el desembolso es por transferencia). Se normaliza: nombres en mayúsculas, número solo con dígitos.
export const cuentaSchema = z.object({
  banco:             z.string().trim().min(3, 'Indica el banco').max(80),
  tipo_cuenta:       z.enum(['ahorros', 'corriente']),
  numero_cuenta:     z.string().trim().transform((v) => v.replace(/[\s-]/g, '')).pipe(z.string().regex(/^\d{6,20}$/, 'El número de cuenta debe tener entre 6 y 20 dígitos')),
  titular_nombre:    z.string().trim().min(3, 'Indica el nombre del titular').max(150).transform((v) => v.replace(/\s+/g, ' ').toUpperCase()),
  titular_documento: z.string().trim().transform((v) => v.replace(/[\s.-]/g, '')).pipe(z.string().regex(/^[0-9A-Za-z]{5,20}$/, 'Documento del titular inválido')),
}).strict();

export const cierreSchema = z.object({
  con_aval: z.boolean(),
  aval_porcentaje: z.number().positive('El porcentaje debe ser mayor que 0').max(100, 'El porcentaje no puede pasar de 100').nullable().optional(),
  sellos: z.object({ aval: posicion.optional(), firma: posicion.optional(), desembolso: posicion.optional() }).strict().optional(),
  cuenta: cuentaSchema.optional(),
}).strict().superRefine((d, ctx) => {
  if (d.con_aval && !d.aval_porcentaje) ctx.addIssue({ code: 'custom', path: ['aval_porcentaje'], message: 'Indica el porcentaje del aval' });
});

export const tipoDocumentoSchema = z.object({ tipo: z.enum(['comprobante_aprobacion', 'formato_estudio_credito']) }).strict();
export const firmadoSchema = z.object({ folio: z.string().uuid() }).strict();
export const tarifaSchema = z.object({ valor: z.number().min(0).max(100000000) }).strict();
export const mesSchema = z.object({
  mes: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mes inválido (AAAA-MM)'),
  formato: z.enum(['json', 'csv']).optional(),
});
