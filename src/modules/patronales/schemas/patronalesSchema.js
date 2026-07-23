import { z } from 'zod';

export const causarSchema = z.object({
  periodo: z.string().regex(/^\d{4}-\d{2}$/, 'Formato requerido: YYYY-MM'),
}).strict();

export const registrarPagoSchema = z.object({
  fecha_pago: z.string().min(1, 'La fecha es obligatoria'),
  monto:      z.preprocess((v) => Number(v), z.number().positive('El monto debe ser positivo')),
  referencia: z.string().optional(),
}).strict();

export const anularSchema = z.object({
  motivo: z.string().min(1, 'El motivo es obligatorio'),
}).strict();

export const configEmpresaSchema = z.object({
  facturacion:      z.enum(['unica', 'separada']),
  dias_vencimiento: z.preprocess((v) => Number(v), z.number().int().min(1).max(365)),
  email_contacto:   z.string().email().optional().or(z.literal('')),
  activa:           z.boolean(),
}).strict();

export const activarPortalEmpresaSchema = z.object({
  email: z.string().email('Email inválido'),
}).strict();

export const loginEmpresaSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
}).strict();

export const cambiarPasswordEmpresaSchema = z.object({
  password_actual: z.string().min(1),
  password_nueva:  z.string().min(8, 'Mínimo 8 caracteres'),
}).strict();

export const actualizarAporteSchema = z.object({
  valor_aporte:      z.preprocess((v) => Number(v), z.number().positive('El aporte debe ser positivo')),
  fecha_desde:       z.string().min(1, 'La fecha de inicio es obligatoria'),
  motivo:            z.string().min(1, 'El motivo es obligatorio'),
  soporte:           z.string().optional(),
}).strict();
