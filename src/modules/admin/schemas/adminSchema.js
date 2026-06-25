import { z } from 'zod';

export const cambiarRolSchema = z.object({
  rol: z.enum(['admin', 'usuario', 'comercial', 'financiero', 'control_interno']),
});

export const resetearPasswordSchema = z.object({
  nueva_password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
});

export const asignarPermisosSchema = z.object({
  usuario_uuid: z.string().uuid(),
  permisos: z.array(z.object({
    modulo: z.string().min(1),
    acciones: z.array(z.enum(['READ', 'WRITE', 'DELETE'])).min(1),
  })).min(1),
});
