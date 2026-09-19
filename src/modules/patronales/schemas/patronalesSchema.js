import { z } from 'zod';

export const causarSchema = z.object({
  periodo:  z.string().regex(/^\d{4}-\d{2}$/, 'Formato requerido: YYYY-MM'),
  quincena: z.preprocess(
    (v) => (v === null || v === undefined || v === '') ? null : Number(v),
    z.number().int().min(1).max(2).nullable().optional()
  ),
}).strict();

export const previewSchema = z.object({
  periodo:        z.string().regex(/^\d{4}-\d{2}$/, 'Formato requerido: YYYY-MM'),
  quincena:       z.preprocess(
    (v) => (v === undefined || v === '' || v === 'null') ? null : Number(v),
    z.number().int().min(1).max(2).nullable().optional().default(null)
  ),
  empresa_codigo: z.string().optional(),
});

export const registrarPagoSchema = z.object({
  // A-10: validar formato para que un string inválido dé 400 en lugar de 500 desde Postgres
  fecha_pago: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato requerido: YYYY-MM-DD'),
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
  // A-10: validar formato de fecha para que un string inválido dé 400, no 500
  fecha_desde:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato requerido: YYYY-MM-DD'),
  motivo:            z.string().min(1, 'El motivo es obligatorio'),
  soporte:           z.string().optional(),
}).strict();
