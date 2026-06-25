import { z } from 'zod';

export const loginAsociadoSchema = z.object({
  codigo:   z.string().min(1, 'El código es obligatorio'),
  password: z.string().min(1, 'La contraseña es obligatoria'),
});

export const importarFilaSchema = z.object({
  codigo:         z.string().min(1),
  apellido:       z.string().min(1),
  nombre:         z.string().min(1),
  direccion:      z.string().optional().default(''),
  movil:          z.string().optional().default(''),
  clase_cuota:    z.string().optional().default(''),
  empresa_dsto:   z.string().optional().default(''),
  nombre_empresa: z.string().optional().default(''),
  ciudad:         z.string().optional().default(''),
});
