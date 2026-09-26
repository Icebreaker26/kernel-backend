import { z } from 'zod';

export const CATALOGOS = ['ciudad', 'profesion', 'cargo', 'empresa', 'banco', 'agencia'];

export const encolarSchema = z.object({
  vinculacion_id: z.string().uuid(),
}).strict();

export const equivalenciaSchema = z.object({
  catalogo     : z.enum(CATALOGOS),
  texto        : z.string().trim().min(1).max(150),
  // Solo para ciudades: distingue homónimas (p. ej. Santa Rosa de Cabal / Santa Rosa de Osos)
  departamento : z.string().trim().min(1).max(100).optional(),
  codigo_solido: z.string().trim().min(1).max(30),
  descripcion  : z.string().trim().max(200).optional(),
}).strict();

export const equivalenciaUpdateSchema = z.object({
  codigo_solido: z.string().trim().min(1).max(30).optional(),
  descripcion  : z.string().trim().max(200).optional(),
}).strict().refine((d) => Object.keys(d).length > 0, { message: 'Nada que actualizar' });

export const cedulaUsuarioSchema = z.object({
  cedula: z.string().trim().regex(/^\d{4,15}$/, 'La cédula debe tener solo números (entre 4 y 15)').nullable(),
}).strict();

export const crearAgenteSchema = z.object({
  nombre: z.string().trim().min(3).max(80),
}).strict();

export const estadoAgenteSchema = z.object({
  pausado        : z.boolean().optional(),
  permite_guardar: z.boolean().optional(),
}).strict().refine((d) => Object.keys(d).length > 0, { message: 'Nada que actualizar' });

export const latidoSchema = z.object({
  version : z.string().max(30).optional(),
  huella_ui: z.string().max(64).optional(),
  // true si la pantalla de Windows del PC de SOLIDO está bloqueada (el agente espera sin tomar trabajos)
  sesion_bloqueada: z.boolean().optional(),
}).strict();

export const resultadoSchema = z.object({
  resultado : z.enum(['llenado_ok', 'ya_existe', 'guardado_ok', 'guardado_con_diferencias', 'guardado_incierto', 'fallido']),
  detalle   : z.record(z.any()).optional(),
  error     : z.string().max(2000).optional(),
  // Solo un fallo antes de guardar puede reintentarse solo (red, tiempo de espera). Tras un Guardar jamás.
  reintentable: z.boolean().default(false),
  // Diálogo desconocido, huella de interfaz distinta, etc.: se pausa el agente hasta que una persona lo reactive
  fatal     : z.boolean().default(false),
  // En la fase de guardar: true si el fallo fue ANTES de pulsar Guardar (no hay nada que verificar en SOLIDO)
  antes_de_guardar: z.boolean().default(false),
  capturas  : z.array(z.object({
    etiqueta: z.string().min(1).max(60),
    mime    : z.enum(['image/jpeg', 'image/png']).default('image/jpeg'),
    base64  : z.string().min(100).max(2_000_000),
  })).max(10).default([]),
}).strict();

export const resolverRevisionSchema = z.object({
  resultado: z.enum(['cargado', 'no_cargado']),
  nota     : z.string().trim().min(5).max(500),
}).strict();
