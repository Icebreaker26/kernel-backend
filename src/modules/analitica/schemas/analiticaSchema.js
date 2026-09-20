import { z } from 'zod';

// Clics clave del sitio que se cuentan por nombre (el resto de la navegación son "vistas")
export const EVENTOS = {
  asociarme: 'Quiero asociarme',
  pagos:     'Pagos en línea',
  whatsapp:  'WhatsApp',
  pqrs:      'PQRS',
  portal:    'Portal de asociados',
  telefono:  'Llamada telefónica',
  convenio:  'Convenio de empresas',
};

// Solo rutas normales del sitio: sin consulta, sin espacios ni caracteres raros
const ruta = z.string().trim().min(1).max(200).regex(/^\/[A-Za-z0-9\-_/.]*$/, 'Ruta no válida');

export const eventoSchema = z.object({
  tipo:   z.enum(['vista', 'clic']),
  ruta,
  ref:    z.string().trim().max(300).optional(),
  evento: z.enum(Object.keys(EVENTOS)).optional(),
}).strict().refine((d) => d.tipo !== 'clic' || !!d.evento, { message: 'Un clic necesita el nombre del evento' });

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');

export const resumenSchema = z.object({
  dias:  z.coerce.number().int().min(1).max(730).optional(),
  desde: fecha.optional(),
  hasta: fecha.optional(),
});
