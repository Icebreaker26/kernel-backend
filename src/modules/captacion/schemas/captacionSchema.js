import { z } from 'zod';
import { TARIFAS, PERIODICIDADES } from '../tarifas.js';

export const crearProspectoSchema = z.object({
  empresa_codigo    : z.string().min(1),
  nombres           : z.string().min(1),
  apellidos         : z.string().min(1),
  cedula            : z.string().min(3),
  celular           : z.string().min(7),
  correo            : z.string().email().optional().or(z.literal('')),
  acepta_habeas_data: z.literal(true, { errorMap: () => ({ message: 'Debe aceptar el tratamiento de datos personales' }) }),
  interes_principal : z.enum(['credito','ahorro','seguros','sorteos','otro']).optional(),
});

export const toqueSchema = z.object({
  resultado: z.enum(['enviado_link', 'contesto', 'no_contesto', 'interesado', 'no_interesado', 'reagendado']),
  notas    : z.string().optional(),
});

export const updateProspectoSchema = z.object({
  estado : z.enum(['nuevo','contactado','link_enviado','vio_landing','interesado','convertido','frio']).optional(),
  correo : z.string().email().optional().or(z.literal('')),
  celular: z.string().min(7).optional(),
}).strict();

// ── Secciones del formulario público ─────────────────────────────────────────

export const seccionPersonalSchema = z.object({
  nombres                 : z.string().min(1).optional(),
  apellidos               : z.string().min(1).optional(),
  cedula                  : z.string().min(1).optional(),
  // Contacto: se guarda en captacion_prospectos (no en la vinculación)
  celular                 : z.string().trim().min(7).max(20).optional(),
  correo                  : z.string().trim().email().max(150).optional(),
  tipo_documento          : z.enum(['CC','TI','CE','PAS']).optional(),
  ciudad_expedicion       : z.string().optional(),
  fecha_expedicion        : z.string().optional(),
  fecha_nacimiento        : z.string().optional(),
  ciudad_nacimiento       : z.string().optional(),
  departamento_nacimiento : z.string().optional(),
  direccion_residencia    : z.string().optional(),
  ciudad_residencia       : z.string().optional(),
  departamento_residencia : z.string().optional(),
  telefono_fijo           : z.string().optional(),
  genero                  : z.enum(['M','F']).optional(),
  nivel_academico         : z.string().optional(),
  profesion               : z.string().optional(),
  estado_civil            : z.enum(['soltero','casado','union_libre','separado','divorciado','viudo']).optional(),
  tipo_vivienda           : z.enum(['propia','arrendada','familiar']).optional(),
  estrato                 : z.preprocess(v => v === '' || v == null ? undefined : Number(v), z.number().int().min(1).max(6).optional()),
  cabeza_de_hogar         : z.boolean().optional(),
  personas_a_cargo        : z.preprocess(v => v === '' || v == null ? undefined : Number(v), z.number().int().min(0).optional()),
  instruccion_cooperativa : z.boolean().optional(),
  declarante_de_renta     : z.boolean().optional(),
  conyuge_nombre          : z.string().optional(),
  conyuge_cedula          : z.string().optional(),
  conyuge_fecha_nacimiento: z.string().optional(),
  conyuge_actividad       : z.string().optional(),
});

export const seccionLaboralSchema = z.object({
  cargo                    : z.string().optional(),
  fecha_ingreso            : z.string().optional(),
  tipo_contrato            : z.enum(['fijo','indefinido','prestacion_servicios','otro']).optional(),
  direccion_trabajo        : z.string().optional(),
  telefono_trabajo         : z.string().optional(),
  ciudad_trabajo           : z.string().optional(),
  departamento_trabajo     : z.string().optional(),
  maneja_recursos_publicos : z.boolean().optional(),
  maneja_recursos_desc     : z.string().optional(),
});

export const seccionPepSchema = z.object({
  pep_maneja_recursos_publicos: z.boolean(),
  pep_reconocimiento_publico  : z.boolean(),
  pep_poder_publico           : z.boolean(),
  pep_vinculo_expuesto        : z.boolean(),
});

export const seccionFinancieraSchema = z.object({
  actividad_financiera      : z.string().optional(),
  ciiu                      : z.string().optional(),
  ingresos_mensuales        : z.preprocess(v => v === '' || v == null ? undefined : Number(v), z.number().nonnegative().optional()),
  egresos_mensuales         : z.preprocess(v => v === '' || v == null ? undefined : Number(v), z.number().nonnegative().optional()),
  otros_ingresos            : z.preprocess(v => v === '' || v == null ? undefined : Number(v), z.number().nonnegative().optional()),
  otros_ingresos_desc       : z.string().optional(),
  total_activos             : z.preprocess(v => v === '' || v == null ? undefined : Number(v), z.number().nonnegative().optional()),
  total_pasivos             : z.preprocess(v => v === '' || v == null ? undefined : Number(v), z.number().nonnegative().optional()),
  origen_fondos             : z.string().optional(),
  moneda_extranjera         : z.boolean().optional(),
  moneda_extranjera_detalle : z.array(z.object({
    banco  : z.string().optional(),
    ciudad : z.string().optional(),
    pais   : z.string().optional(),
    monto  : z.number().optional(),
    moneda : z.string().optional(),
    cuenta : z.string().optional(),
  })).optional(),
});

// El asociado solo elige: cuánto aporta, cada cuánto le descuentan y si toma seguro/bono.
// Los valores de fondo, seguro, bono y cuota los fija el servidor (tarifas.js).
const pesos = (n) => `$${n.toLocaleString('es-CO')}`;
export const seccionAportesSchema = z.object({
  valor_aporte: z.number({ invalid_type_error: 'El aporte debe ser un número' }).int()
    .min(TARIFAS.aporte_minimo, `El aporte mínimo es ${pesos(TARIFAS.aporte_minimo)}`)
    .refine((v) => v % TARIFAS.aporte_paso === 0, { message: `El aporte debe ser múltiplo de ${pesos(TARIFAS.aporte_paso)}` }),
  periodicidad: z.enum(PERIODICIDADES),
  seguro_vida : z.boolean(),
  bono_sorteo : z.boolean(),
});

export const seccionBeneficiariosSchema = z.object({
  beneficiarios: z.array(z.object({
    orden           : z.number().int().min(1),
    identificacion  : z.string().optional(),
    nombres         : z.string().min(1),
    porcentaje      : z.number().min(0).max(100),
    fecha_nacimiento: z.string().optional(),
    parentesco      : z.string().optional(),
  })).max(5),
});

export const seccionReferenciasSchema = z.object({
  referencias: z.array(z.object({
    tipo         : z.enum(['personal','familiar']),
    nombres      : z.string().optional(),
    telefono_fijo: z.string().optional(),
    celular      : z.string().optional(),
  })).max(2),
});

export const seccionFirmaSchema = z.object({
  firma_png             : z.string().min(1),
  firma_trazos          : z.array(z.object({ x: z.number(), y: z.number(), t: z.number() })),
  version_consentimiento: z.string().min(1),
  acepta_terminos       : z.literal(true),
  // Consentimiento explícito a firmar electrónicamente (Ley 527 de 1999); equivale a la firma manuscrita
  acepta_firma_electronica: z.literal(true),
  version_firma_electronica: z.string().min(1),
});

// Código de un solo uso que se envía al correo del asociado
// Autorización de tratamiento de datos aceptada por el titular en el formulario
export const habeasDataSchema = z.object({
  acepta : z.literal(true),
  version: z.string().min(1),
});

export const stepUpSchema = z.object({
  codigo: z.string().regex(/^\d{6}$/, 'El código tiene 6 dígitos'),
});

export const valoresAsesorSchema = z.object({
  valor_aporte  : z.preprocess(v => Number(v), z.number().nonnegative()).optional(),
  cuota_admision: z.preprocess(v => Number(v), z.number().nonnegative()).optional(),
}).strict();
