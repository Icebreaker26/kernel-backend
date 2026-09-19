import { z } from 'zod';

export const CATEGORIAS = {
  rut:                 'RUT',
  acta_asamblea:       'Actas de asamblea',
  informe_gestion:     'Informes de gestión',
  estados_financieros: 'Estados financieros',
  renta:               'Declaración de renta',
  certificado:         'Certificados',
  formato:             'Formatos',
  otro:                'Otros documentos',
};

const categoria = z.enum(Object.keys(CATEGORIAS));
const anio = z.preprocess((v) => (v === '' || v === null || v === undefined ? null : Number(v)), z.number().int().min(1970).max(2100).nullable());

export const crearDocumentoSchema = z.object({
  titulo:    z.string().trim().min(1, 'El título es obligatorio').max(200),
  categoria,
  anio,
}).strict();

export const actualizarDocumentoSchema = z.object({
  titulo:    z.string().trim().min(1).max(200).optional(),
  categoria: categoria.optional(),
  anio:      anio.optional(),
  publicado: z.boolean().optional(),
}).strict();
