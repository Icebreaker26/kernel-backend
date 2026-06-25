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
  numero: z.preprocess((v) => Number(v), z.number().int().min(0).max(999)),
}).strict();

export const solicitarBonoSchema = z.object({
  numero:    z.preprocess((v) => Number(v), z.number().int().min(0).max(999)),
  sorteo_id: z.string().uuid(),
}).strict();

export const solicitarRetiroSchema = z.object({
  numero:    z.preprocess((v) => Number(v), z.number().int().min(0).max(999)),
  sorteo_id: z.string().uuid(),
}).strict();
