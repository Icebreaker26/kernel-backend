import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET:   z.string().min(32),
  PORT:         z.string().default('4000').transform(Number),
  NODE_ENV:     z.enum(['development', 'production', 'test']).default('development'),
  FRONTEND_URL: z.string().url(),
  PORTAL_URL:   z.string().url().optional(),
  // Origen del sitio público de la cooperativa cuando vive en otro dominio (p. ej. https://cooperativaprogresemos.coop):
  // se agrega a los orígenes permitidos por CORS para que ese sitio lea la API pública.
  SITIO_URL:    z.string().url().optional(),
  // Clave con la que se protege el código de seguimiento de las PQRS (HMAC). Si no se define se usa JWT_SECRET; cambiarla invalida los códigos ya entregados.
  PQRS_PEPPER:  z.string().min(16).optional(),
  // Sal con la que se calcula el hash diario del visitante en la analítica del sitio (sin cookies). Si no se define se usa JWT_SECRET.
  ANALITICA_SALT: z.string().min(16).optional(),
  SMTP_HOST:    z.string().optional(),
  SMTP_PORT:    z.string().optional().transform((v) => (v ? Number(v) : 587)),
  SMTP_USER:    z.string().optional(),
  SMTP_PASS:    z.string().optional(),
  SMTP_FROM:    z.string().optional(),
  RELAY_URL:    z.string().url().optional(),
  RELAY_SECRET: z.string().optional(),
  AWS_REGION:            z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID:     z.string().min(16).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(32).optional(),
  S3_BUCKET:             z.string().min(3).optional(),
  // Años de retención (Object Lock) de la evidencia de firma. Solo se define cuando el bucket YA tiene Object Lock activo: sin esto no se pide bloqueo.
  S3_RETENCION_EVIDENCIA_ANIOS: z.string().optional().transform((v) => (v ? Number(v) : null)).pipe(z.number().int().min(1).max(30).nullable()),
  // GOVERNANCE (reversible por quien tenga permiso explícito) o COMPLIANCE (nadie puede borrar antes del plazo). Por defecto GOVERNANCE.
  S3_RETENCION_MODO:     z.enum(['GOVERNANCE', 'COMPLIANCE']).default('GOVERNANCE'),
  // Búsqueda en fuentes abiertas para la consulta de listas (Brave Search API). Sin llave, el asesor busca con los enlaces de ayuda.
  BRAVE_SEARCH_API_KEY:  z.string().min(10).optional(),
  // Buscar también por la cédula envía ese dato a un tercero: por defecto solo se busca por el nombre
  BUSQUEDA_INCLUIR_CEDULA: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Correo por API HTTPS (Resend): respaldo de SES si están ambas. RESEND_FROM p. ej. 'Cooperativa Progresemos <no-responder@cooperativaprogresemos.coop>'
  RESEND_API_KEY:        z.string().startsWith('re_').optional(),
  RESEND_FROM:           z.string().min(3).optional(),
  // Canal principal de correo (Amazon SES, HTTPS; cuota 50.000/día). Si falla se usa Resend y luego el relay. Credenciales: SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY.
  // Ritmo del dispatcher de campañas. Por defecto depende del canal: con SES 10 correos cada 5 s (7.200/h); sin SES, 4 cada 30 s (480/h, límite del relay).
  MAILING_POR_TICK:      z.string().optional().transform((v) => (v ? Number(v) : undefined)),
  MAILING_TICK_MS:       z.string().optional().transform((v) => (v ? Number(v) : undefined)),
  SES_FROM:              z.string().min(3).optional(),   // p. ej. 'Cooperativa Progresemos <no-responder@midominio.coop>' (dominio verificado en SES)
  SES_REGION:            z.string().optional(),          // por defecto AWS_REGION
  // ARN del tema SNS al que SES publica rebotes y quejas; solo se aceptan mensajes de ese tema en /api/email/ses-eventos
  SES_SNS_TOPIC_ARN:     z.string().startsWith('arn:aws:sns:').optional(),
  // Llaves propias de SES (usuario IAM distinto al de S3). Si no se definen, se usan AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.
  SES_ACCESS_KEY_ID:     z.string().min(16).optional(),
  SES_SECRET_ACCESS_KEY: z.string().min(32).optional(),
  REDIS_URL:             z.string().url().optional(),
  // true = lockdown middleware loguea pero NO bloquea (modo observación 2 semanas)
  LOCKDOWN_SHADOW_MODE:  z.string().optional().transform((v) => v === 'true'),
});

const _env = envSchema.safeParse(process.env);
if (!_env.success) {
  console.error('Variables de entorno inválidas:', _env.error.format());
  process.exit(1);
}

export const env = _env.data;
