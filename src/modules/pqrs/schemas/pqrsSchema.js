import { z } from 'zod';

export const TIPOS = {
  peticion:     'Petición',
  queja:        'Queja',
  reclamo:      'Reclamo',
  sugerencia:   'Sugerencia',
  felicitacion: 'Felicitación',
};
export const ESTADOS = ['recibida', 'en_revision', 'respondida', 'cerrada'];

// Texto de la autorización de tratamiento de datos que ve quien radica; súbelo si cambia la redacción
export const VERSION_HABEAS_DATA = 'pqrs-hd-v1.0';

const texto = (min, max, mensaje) => z.string().trim().min(min, mensaje).max(max);

export const crearPqrsSchema = z.object({
  tipo:     z.enum(Object.keys(TIPOS), { errorMap: () => ({ message: 'Elige el tipo de solicitud' }) }),
  nombre:   texto(3, 120, 'Escribe tu nombre'),
  email:    z.string().trim().toLowerCase().email('Escribe un correo válido').max(254),
  telefono: z.string().trim().regex(/^[0-9 +()-]{7,20}$/, 'Escribe un teléfono válido').optional().or(z.literal('')),
  empresa:  z.string().trim().max(120).optional().or(z.literal('')),
  asunto:   texto(3, 150, 'Escribe el asunto'),
  mensaje:  texto(10, 4000, 'Cuéntanos con un poco más de detalle (mínimo 10 caracteres)'),
  acepta_habeas_data: z.literal(true, { errorMap: () => ({ message: 'Debes aceptar el tratamiento de datos personales' }) }),
  version_habeas_data: z.string().min(1),
  // Campo trampa para robots: una persona no lo ve ni lo llena
  sitio_web: z.string().optional(),
}).strict();

export const consultaSchema = z.object({
  radicado: z.string().trim().toUpperCase().regex(/^PQRS-\d{4}-\d{6}$/, 'El radicado tiene el formato PQRS-2026-000123'),
  codigo:   z.string().trim().toUpperCase().regex(/^[A-Z0-9]{8}$/, 'El código tiene 8 caracteres'),
}).strict();

export const estadoSchema = z.object({ estado: z.enum(['en_revision', 'cerrada']) }).strict();
export const asignarSchema = z.object({ usuario_uuid: z.string().uuid().nullable() }).strict();
export const responderSchema = z.object({ respuesta: texto(10, 5000, 'La respuesta debe tener al menos 10 caracteres') }).strict();
export const notaSchema = z.object({ nota: texto(1, 2000, 'Escribe la nota') }).strict();
