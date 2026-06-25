import { z } from 'zod';

export const loginSchema = z.object({
  email:    z.string().email('Email inválido'),
  password: z.string().min(6, 'Mínimo 6 caracteres'),
});

export const registerSchema = z.object({
  nombre:   z.string().min(2, 'El nombre es obligatorio'),
  email:    z.string().email('Email inválido'),
  password: z.string().min(6, 'Mínimo 6 caracteres'),
  rol:      z.enum(['usuario', 'comercial', 'financiero', 'control_interno']).default('usuario'),
});
