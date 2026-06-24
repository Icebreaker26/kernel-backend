import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET:   z.string().min(16),
  PORT:         z.string().default('4000').transform(Number),
  NODE_ENV:     z.enum(['development', 'production', 'test']).default('development'),
  FRONTEND_URL: z.string().url(),
});

const _env = envSchema.safeParse(process.env);
if (!_env.success) {
  console.error('Variables de entorno inválidas:', _env.error.format());
  process.exit(1);
}

export const env = _env.data;
