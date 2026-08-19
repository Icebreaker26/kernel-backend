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
  SMTP_HOST:    z.string().optional(),
  SMTP_PORT:    z.string().optional().transform((v) => (v ? Number(v) : 587)),
  SMTP_USER:    z.string().optional(),
  SMTP_PASS:    z.string().optional(),
  SMTP_FROM:    z.string().optional(),
  RELAY_URL:    z.string().url().optional(),
  RELAY_SECRET: z.string().optional(),
});

const _env = envSchema.safeParse(process.env);
if (!_env.success) {
  console.error('Variables de entorno inválidas:', _env.error.format());
  process.exit(1);
}

export const env = _env.data;
