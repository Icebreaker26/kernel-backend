import { verificarLockdown } from '../services/lockdownService.js';
import { env } from '../config/env.js';
import pool from '../db/database.js';
import logger from '../config/logger.js';

/**
 * Middleware de circuit breaker.
 *
 * Modos:
 *   LOCKDOWN_SHADOW_MODE=true  → observación: detecta y registra, NO bloquea
 *   LOCKDOWN_SHADOW_MODE=false → enforcing: bloquea con 503 / 403
 *
 * - L2 global   → 503 { code: 'LOCKDOWN', nivel: 2, motivo }
 * - L3 targeted → 403 { code: 'IP_CUARENTENA' | 'USUARIO_CUARENTENA', nivel: 3 }
 *
 * Nunca bloquear GETs — llamar solo en mutations sensibles.
 */
const registrarShadow = (activo, req) => {
  const ip          = req.ip ?? req.socket?.remoteAddress ?? null;
  const usuario_uuid = req.user?.id ?? null;

  // Fire-and-forget: no bloquear la request si falla el log
  pool.query(
    `INSERT INTO security_lockdown_shadow
       (lockdown_nivel, lockdown_alcance, lockdown_objetivo, lockdown_motivo,
        request_method, request_path, request_ip, usuario_uuid)
     VALUES ($1,$2,$3,$4,$5,$6,$7::inet,$8)`,
    [
      activo.nivel, activo.alcance, activo.objetivo, activo.motivo,
      req.method, req.path, ip, usuario_uuid,
    ]
  ).catch(() => {});

  logger.warn('[LOCKDOWN SHADOW] habría bloqueado', {
    nivel: activo.nivel, alcance: activo.alcance, objetivo: activo.objetivo,
    method: req.method, path: req.path, ip, usuario_uuid,
  });
};

const crearLockdown = () => async (req, res, next) => {
  try {
    const ip           = req.ip ?? req.socket?.remoteAddress ?? null;
    const usuario_uuid = req.user?.id ?? null;

    const activo = await verificarLockdown({ ip, usuario_uuid });
    if (!activo) return next();

    // Shadow mode: observar sin bloquear
    if (env.LOCKDOWN_SHADOW_MODE) {
      registrarShadow(activo, req);
      return next();
    }

    // Enforcing mode
    if (activo.nivel === 3) {
      const code = activo.alcance === 'ip' ? 'IP_CUARENTENA' : 'USUARIO_CUARENTENA';
      return res.status(403).json({ code, nivel: 3 });
    }

    return res.status(503).json({
      code:   'LOCKDOWN',
      nivel:  activo.nivel,
      motivo: activo.motivo,
    });
  } catch {
    // Fallo transitorio → fail-open
    return next();
  }
};

export const lockdownFinanciero = crearLockdown();
export const lockdownRegistro   = crearLockdown();
