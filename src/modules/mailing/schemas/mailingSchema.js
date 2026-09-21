import { z } from 'zod';

// Segmento mixto: cualquier combinación de empresas + sorteos + codigos.
// Arrays vacíos = enviar a todos los asociados con email.
export const segmentoSchema = z.object({
  empresas: z.array(z.string()).default([]),
  sorteos:  z.array(z.string().uuid()).default([]),
  codigos:  z.array(z.string()).default([]),
  // Solo aplica a audiencia 'contactos': nombres de jornada. Vacío = todos los contactos activos.
  jornadas: z.array(z.string()).default([]),
}).default({ empresas: [], sorteos: [], codigos: [], jornadas: [] });

export const audienciaSchema = z.enum(['asociados', 'contactos']);

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
  audiencia:    audienciaSchema.default('asociados'),
  segmento:     segmentoSchema,
  plantilla:    plantillaSchema,
});

// Persona que no es asociada y deja su correo en una jornada presencial
export const contactoSchema = z.object({
  nombre:             z.string().trim().min(2, 'El nombre es obligatorio').max(150),
  email:              z.string().trim().toLowerCase().email('Correo inválido').max(254),
  telefono:           z.string().trim().max(30).optional().or(z.literal('')),
  jornada:            z.string().trim().min(2, 'La jornada es obligatoria').max(150),
  autorizacion_datos: z.literal(true, { errorMap: () => ({ message: 'Se requiere la autorización de tratamiento de datos' }) }),
});

export const actualizarCampanaSchema = z.object({
  asunto:       z.string().min(1).optional(),
  cuerpo_html:  z.string().min(1).optional(),
  cuerpo_texto: z.string().optional(),
  audiencia:    audienciaSchema.optional(),
  segmento:     segmentoSchema.optional(),
  plantilla:    plantillaSchema,
}).strict();
