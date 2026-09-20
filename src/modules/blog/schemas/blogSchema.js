import { z } from 'zod';

const titulo    = z.string().trim().min(1, 'El título es obligatorio').max(200, 'El título admite hasta 200 caracteres');
const resumen   = z.string().trim().max(300, 'El resumen admite hasta 300 caracteres').nullable();
const contenido = z.string().max(200000, 'El contenido es demasiado largo');
// El editor puede enviar '' cuando no hay categoría elegida
const categoriaId = z.preprocess((v) => (v === '' ? null : v), z.string().uuid().nullable());

export const crearEntradaSchema = z.object({
  titulo,
  resumen:      resumen.optional(),
  contenido:    contenido.optional(),
  categoria_id: categoriaId.optional(),
}).strict();

export const actualizarEntradaSchema = z.object({
  titulo:       titulo.optional(),
  resumen:      resumen.optional(),
  contenido:    contenido.optional(),
  categoria_id: categoriaId.optional(),
  estado:       z.enum(['borrador', 'publicado']).optional(),
}).strict();

export const crearCategoriaSchema = z.object({
  nombre: z.string().trim().min(2, 'El nombre es muy corto').max(60),
}).strict();

export const IMAGEN_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_PORTADA = 5 * 1024 * 1024;
export const POR_PAGINA = 9;
