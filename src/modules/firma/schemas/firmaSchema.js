import { z } from 'zod';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'Hash SHA-256 inválido');

const firmanteSchema = z.object({
  nombre:       z.string().trim().min(1).max(120),
  tipo_doc:     z.enum(['CC', 'CE', 'TI', 'NIT', 'PA', 'OTRO']),
  num_doc:      z.string().trim().min(3).max(20),
  rol:          z.string().trim().min(1).max(40),
  // Con qué se firmó: una firma hecha con mouse vale menos como prueba y así debe quedar dicho
  metodo_firma: z.enum(['pen', 'touch', 'mouse']),
  con_huella:   z.boolean(),
  h_firma_png:  sha256,
  h_huella_png: sha256.nullable().optional(),
  huella_dispositivo: z.string().max(80).nullable().optional(),
}).strict();

// Tanda de hasta 10 documentos firmados de una sola pasada; el cliente genera el id y lo repite en cada documento
export const MAX_DOCS_LOTE = 10;
const loteSchema = z.object({
  id:    z.string().uuid(),
  pos:   z.number().int().min(1).max(MAX_DOCS_LOTE),
  total: z.number().int().min(2).max(MAX_DOCS_LOTE),
}).strict().refine((l) => l.pos <= l.total, 'pos no puede superar el total');

export const selloSchema = z.object({
  h_original:     sha256,
  nombre_archivo: z.string().trim().min(1).max(255),
  paginas:        z.number().int().min(1).max(2000),
  firmantes:      z.array(firmanteSchema).min(1).max(10),
  lote:           loteSchema.optional(),
}).strict();

export const registroSchema = z.object({
  folio:   z.string().uuid(),
  h_final: sha256,
}).strict();
