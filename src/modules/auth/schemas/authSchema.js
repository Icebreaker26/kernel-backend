import { z } from 'zod';

export const loginSchema = z.object({
  email:    z.string().email('Email inválido'),
  password: z.string().min(1, 'La contraseña es requerida'),
});

export const registerSchema = z.object({
  nombre:   z.string().min(2, 'El nombre es obligatorio'),
  email:    z.string().email('Email inválido'),
  password: z.string()
    .min(10, 'La contraseña debe tener al menos 10 caracteres')
    .regex(/[A-Z]/, 'Debe contener al menos una mayúscula')
    .regex(/[0-9]/, 'Debe contener al menos un número'),
  rol:      z.enum(['usuario', 'comercial', 'financiero', 'control_interno']).default('usuario'),
});
