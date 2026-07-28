import { z } from 'zod';

export const loginAsociadoSchema = z.object({
  codigo:   z.string().min(1, 'El código es obligatorio'),
  password: z.string().min(1, 'La contraseña es obligatoria'),
});

export const solicitarPortalSchema = z.object({
  codigo: z.string().min(1, 'El código es obligatorio'),
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
