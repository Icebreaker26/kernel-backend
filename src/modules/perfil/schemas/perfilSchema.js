import { z } from 'zod';

export const actualizarPerfilSchema = z.object({
  nombre: z.string().min(1, 'El nombre es obligatorio'),
  email:  z.string().email('Email inválido'),
}).strict();

export const cambiarPasswordSchema = z.object({
  password_actual: z.string().min(6),
  password_nueva:  z.string().min(6, 'Mínimo 6 caracteres'),
}).strict();
