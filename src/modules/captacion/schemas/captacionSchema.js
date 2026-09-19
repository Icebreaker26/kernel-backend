import { z } from 'zod';

export const crearProspectoSchema = z.object({
  empresa_codigo : z.string().min(1),
  nombres        : z.string().min(1),
  apellidos      : z.string().min(1),
  cedula         : z.string().min(3),
  celular        : z.string().min(7),
  correo         : z.string().email().optional().or(z.literal('')),
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
});

export const stepUpSchema = z.object({
  digitos: z.string().length(4).regex(/^\d{4}$/),
});

export const valoresAsesorSchema = z.object({
  valor_aporte  : z.preprocess(v => Number(v), z.number().nonnegative()).optional(),
  cuota_admision: z.preprocess(v => Number(v), z.number().nonnegative()).optional(),
}).strict();
