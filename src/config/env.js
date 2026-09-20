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
  // Respaldo de correo por API (Amazon SES, HTTPS): se usa si el relay falla. Credenciales: SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY.
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
