import { z } from 'zod';

export const loginAsociadoSchema = z.object({
  codigo:   z.string().min(1, 'El código es obligatorio'),
  password: z.string().min(1, 'La contraseña es obligatoria'),
});

export const solicitarPortalSchema = z.object({
  codigo: z.string().min(1, 'El código es obligatorio'),
});

export const cambiarPasswordSchema = z.object({
  password_actual: z.string().min(1),
  password_nueva:  z.string().min(8).max(128),
});

export const subsanarSchema = z.object({
  numeros:       z.array(z.number().int()).optional(),
  sorteo_id:     z.string().uuid().optional(),
  sorteo_nombre: z.string().max(200).optional(),
});

export const guardarEmailSchema = z.object({
  email:        z.string().email('Correo electrónico inválido'),
  emailConfirm: z.string().email(),
}).refine((d) => d.email === d.emailConfirm, { message: 'Los correos no coinciden', path: ['emailConfirm'] });

export const registroPortalSchema = z.object({
  codigo:           z.string().min(1, 'El código es obligatorio'),
  fecha_nacimiento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha inválido (YYYY-MM-DD)'),
  email:            z.string().email('Correo electrónico inválido'),
});

// DD/MM/YYYY → YYYY-MM-DD, vacío → null
const parseDate = z.preprocess((v) => {
  if (!v || String(v).trim() === '') return null;
  const [d, m, y] = String(v).trim().split('/');
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
}, z.string().nullable().optional());

// "1.500,00" o "-3.200,50" → número
const parseMoneda = z.preprocess((v) => {
  if (!v || String(v).trim() === '') return null;
  const n = parseFloat(String(v).trim().replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}, z.number().nullable().optional());

export const importarFilaSchema = z.object({
  codigo:              z.string().min(1),
  apellido:            z.string().min(1),
  nombre:              z.string().min(1),
  direccion:           z.string().optional().default(''),
  movil:               z.string().optional().default(''),
  clase_cuota:         z.string().optional().default(''),
  periodo_descto:      z.string().optional().default(''), // '1'=mensual, '2'=quincenal — fuente de verdad
  empresa_dsto:        z.string().optional().default(''),
  nombre_empresa:      z.string().optional().default(''),
  ciudad:              z.string().optional().default(''),
  fecha_credito:       parseDate,
  fecha_pri_decuento:  parseDate,   // nombre exacto del header CSV
  cuota:               parseMoneda, // → valor_aporte
  saldo:               parseMoneda, // → saldo_aporte (neg = a favor asociado)
  fecha_ingreso:       parseDate,
  fecha_reingreso:     parseDate,
  fecha_nacimiento:    parseDate,
});
