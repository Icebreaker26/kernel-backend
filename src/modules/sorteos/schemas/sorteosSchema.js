import { z } from 'zod';

export const crearSorteoSchema = z.object({
  nombre:      z.string().min(1, 'El nombre es obligatorio'),
  descripcion: z.string().optional(),
}).strict();

export const asignarDirectoSchema = z.object({
  numero:          z.preprocess((v) => Number(v), z.number().int().min(0).max(999)),
  asociado_codigo: z.string().min(1),
}).strict();

export const retirarDirectoSchema = z.object({
  numero: z.preprocess((v) => Number(v), z.number().int().min(0).max(999)),
  motivo: z.string().optional(),
}).strict();

export const gestionarSolicitudSchema = z.object({
  notas: z.string().optional(),
}).strict();

export const registrarGanadorSchema = z.object({
  numero:          z.preprocess((v) => Number(v), z.number().int().min(0).max(999)),
  mes_premiacion:  z.string().regex(/^\d{4}-\d{2}$/, 'Formato requerido: YYYY-MM'),
  asociado_codigo: z.string().min(1).optional(),
}).strict();

export const actualizarSorteoSchema = z.object({
  precio_boleto: z.preprocess((v) => Number(v), z.number().nonnegative('El precio no puede ser negativo')).optional(),
  tipo_pago:     z.enum(['recurrente', 'unico']).optional(),
  premio:        z.string().max(200).optional().nullable(),
}).strict().refine((d) => d.precio_boleto !== undefined || d.tipo_pago !== undefined || d.premio !== undefined, {
  message: 'Se requiere al menos un campo para actualizar',
});

export const solicitarBonoSchema = z.object({
  numero:    z.preprocess((v) => Number(v), z.number().int().min(0).max(999)),
  sorteo_id: z.string().uuid(),
}).strict();

export const solicitarRetiroSchema = z.object({
  numero:    z.preprocess((v) => Number(v), z.number().int().min(0).max(999)),
  sorteo_id: z.string().uuid(),
}).strict();

