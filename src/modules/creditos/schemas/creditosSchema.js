import { z } from 'zod';

const uuid = z.string().uuid();
const vacioAUndef = (v) => (v === '' || v === null ? undefined : v);
const dinero = z.preprocess((v) => (v === '' || v == null ? undefined : Number(v)), z.number({ invalid_type_error: 'Valor inválido' }).positive().max(9_999_999_999));
const entero = (min, max) => z.preprocess((v) => (v === '' || v == null ? undefined : Number(v)), z.number().int().min(min).max(max));
const email = z.string().trim().toLowerCase().email().max(254);
const texto = (max) => z.preprocess(vacioAUndef, z.string().trim().max(max).optional());
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha inválida (AAAA-MM-DD)');

export const FORMAS_DESEMBOLSO = ['transferencia', 'cheque', 'efectivo'];
// Documentos que el asesor sube para firmar (los define la cooperativa)
export const TIPOS_A_FIRMAR = ['carta_instrucciones', 'libranza', 'pagare', 'solicitud_credito', 'proyeccion'];
export const TIPOS_ADJUNTO = ['desprendible_nomina', 'certificado_bancario', 'otro_adjunto'];

const cuerpoBase = {
  categoria_id:      uuid,
  canal_origen:      z.enum(['whatsapp', 'presencial']),
  valor_solicitado:  dinero,
  monto_desembolso:  dinero,
  motivo_diferencia: texto(500),
  cuotas:            entero(1, 240).optional(),
  cuota_mensual:     dinero.optional(),
  forma_desembolso:  z.enum(FORMAS_DESEMBOLSO),
  modalidad_firma:   z.enum(['presencial', 'externa']),
  proveedor_externo: texto(80),
  observaciones:     texto(1000),
};

export const radicarSchema = z.object({
  clave:           uuid.optional(),   // idempotencia: la misma clave no crea otra solicitud
  asociado_codigo: z.string().trim().min(3).max(20),
  ...cuerpoBase,
  // Excepción a la política de la empresa (con motivo obligatorio)
  autorizacion_requerida: z.boolean().optional(),
  override_motivo:        texto(500),
  emails_autorizacion:    z.array(email).max(5).optional(),
}).strict().superRefine((d, ctx) => {
  if (d.monto_desembolso > d.valor_solicitado) ctx.addIssue({ code: 'custom', path: ['monto_desembolso'], message: 'El monto a desembolsar no puede superar el valor solicitado' });
  if (d.monto_desembolso < d.valor_solicitado && !d.motivo_diferencia) ctx.addIssue({ code: 'custom', path: ['motivo_diferencia'], message: 'Explica la diferencia entre el valor solicitado y el monto a desembolsar' });
  if (d.modalidad_firma === 'externa' && !d.proveedor_externo) ctx.addIssue({ code: 'custom', path: ['proveedor_externo'], message: 'Indica el proveedor de la firma electrónica externa' });
});

export const actualizarSchema = z.object({
  categoria_id:      uuid.optional(),
  valor_solicitado:  dinero.optional(),
  monto_desembolso:  dinero.optional(),
  motivo_diferencia: texto(500),
  cuotas:            entero(1, 240).optional(),
  cuota_mensual:     dinero.optional(),
  forma_desembolso:  z.enum(FORMAS_DESEMBOLSO).optional(),
  proveedor_externo: texto(80),
  observaciones:     texto(1000),
}).strict();

export const borradorSchema = z.object({ tipo: z.enum(TIPOS_A_FIRMAR) }).strict();
export const adjuntoSchema  = z.object({ tipo: z.enum(TIPOS_ADJUNTO) }).strict();

export const firmaExternaSchema = z.object({
  borrador_id:    uuid,
  proveedor:      z.string().trim().min(2).max(80),
  id_transaccion: texto(120),
  fecha_firma:    fecha,
}).strict();

// El PDF firmado llega como archivo (multipart) junto con el folio del motor de firma
export const firmadoSchema = z.object({ folio: uuid }).strict();

export const autorizacionEnviarSchema = z.object({ emails: z.array(email).min(1).max(5).optional() }).strict();

export const autorizacionRegistrarSchema = z.object({
  decision:           z.enum(['aprobada', 'rechazada']),
  fecha_autorizacion: fecha.optional(),
  canal:              z.enum(['correo', 'telefono', 'fisico', 'otro']).default('correo'),
  cuota_autorizada:   dinero.optional(),
  motivo_rechazo:     texto(500),
}).strict().superRefine((d, ctx) => {
  if (d.decision === 'aprobada' && !d.fecha_autorizacion) ctx.addIssue({ code: 'custom', path: ['fecha_autorizacion'], message: 'Indica la fecha de la autorización' });
  if (d.decision === 'rechazada' && !d.motivo_rechazo) ctx.addIssue({ code: 'custom', path: ['motivo_rechazo'], message: 'Indica el motivo del rechazo' });
});

export const cierreSchema = z.object({ estado: z.enum(['rechazada', 'desistida']), motivo: z.string().trim().min(3).max(500) }).strict();
export const reasignarSchema = z.object({ asesor_uuid: uuid, motivo: z.string().trim().min(3).max(500) }).strict();
export const devolverSchema = z.object({ motivo: z.string().trim().min(3).max(500) }).strict();

export const configEmpresaSchema = z.object({
  requiere_autorizacion: z.boolean(),
  momento_autorizacion:  z.enum(['antes_firma', 'despues_firma', 'indiferente']),
  emails_autorizacion:   z.array(email).max(5),
}).strict();
