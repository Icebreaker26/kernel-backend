import { z } from 'zod';

// Segmento mixto: cualquier combinación de empresas + sorteos + codigos.
// Arrays vacíos = enviar a todos los asociados con email.
export const segmentoSchema = z.object({
  empresas: z.array(z.string()).default([]),
  sorteos:  z.array(z.string().uuid()).default([]),
  codigos:  z.array(z.string()).default([]),
}).default({ empresas: [], sorteos: [], codigos: [] });

// Plantilla visual — estructura de campos por tipo de template.
// El frontend genera cuerpo_html a partir de estos campos.
const camposComun = { boton_texto: z.string().optional(), boton_url: z.string().optional() };

export const plantillaSchema = z.discriminatedUnion('tipo', [
  z.object({
    tipo:   z.literal('comunicado'),
    campos: z.object({ titulo: z.string().min(1), cuerpo: z.string().min(1), ...camposComun }),
  }),
  z.object({
    tipo:   z.literal('promocion'),
    campos: z.object({ titulo: z.string().min(1), descripcion: z.string().min(1), puntos: z.string().optional(), boton_texto: z.string().min(1), boton_url: z.string().min(1) }),
  }),
  z.object({
    tipo:   z.literal('recordatorio'),
    campos: z.object({ titulo: z.string().min(1), evento: z.string().min(1), fecha: z.string().min(1), mensaje: z.string().optional(), ...camposComun }),
  }),
]).nullable().optional();

export const crearCampanaSchema = z.object({
  asunto:       z.string().min(1, 'El asunto es obligatorio'),
  cuerpo_html:  z.string().min(1, 'El cuerpo HTML es obligatorio'),
  cuerpo_texto: z.string().optional(),
  segmento:     segmentoSchema,
  plantilla:    plantillaSchema,
});

export const actualizarCampanaSchema = z.object({
  asunto:       z.string().min(1).optional(),
  cuerpo_html:  z.string().min(1).optional(),
  cuerpo_texto: z.string().optional(),
  segmento:     segmentoSchema.optional(),
  plantilla:    plantillaSchema,
}).strict();
