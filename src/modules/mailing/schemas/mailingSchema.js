import { z } from 'zod';

export const crearCampanaSchema = z.object({
  asunto:       z.string().min(1, 'El asunto es obligatorio'),
  cuerpo_html:  z.string().min(1, 'El cuerpo HTML es obligatorio'),
  cuerpo_texto: z.string().optional(),
});

export const actualizarCampanaSchema = z.object({
  asunto:       z.string().min(1).optional(),
  cuerpo_html:  z.string().min(1).optional(),
  cuerpo_texto: z.string().optional(),
}).strict();
