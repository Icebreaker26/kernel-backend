import pool from '../db/database.js';
import { redisClient } from '../config/redis.js';
import logger from '../config/logger.js';
import { emitirAlertaSeguridad } from './notificationService.js';

// TTL del estado de lockdown en Redis (5 min — db es la fuente de verdad)
const CACHE_TTL = 300;

// ── Helpers de cache ──────────────────────────────────────────────────────────

const cacheKey = (alcance, objetivo) => `lockdown:${alcance}:${objetivo}`;

const invalidarCache = async (alcance, objetivo) => {
  if (!redisClient) return;
  await redisClient.del(cacheKey(alcance, objetivo)).catch(() => {});
  // También invalidar la clave global — impacta a todas las rutas
  if (alcance !== 'global') {
    await redisClient.del(cacheKey('global', '*')).catch(() => {});
  }
};

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * Activa un lockdown de nivel 2 ó 3.
 * Idempotente: si ya existe uno activo para (alcance, objetivo) no hace nada.
 * Retorna { activado: bool, registro }.
 */
export const activarLockdown = async ({
  nivel,
  alcance = 'global',
  objetivo = '*',
  motivo,
  reglas = [],
  puntaje = null,
  alerta_ids = [],
  origen = 'auto',
  activado_por_uuid = null,
  expira_at = null,
}) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // INSERT … ON CONFLICT DO NOTHING — el índice parcial garantiza idempotencia
    const { rows: [row] } = await client.query(
      `INSERT INTO security_lockdown
         (nivel, alcance, objetivo, motivo, reglas, puntaje, alerta_ids,
          origen, activado_por_uuid, expira_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT ON CONSTRAINT security_lockdown_activo_unico DO NOTHING
       RETURNING *`,
      [nivel, alcance, objetivo, motivo,
       reglas.length ? reglas : null,
       puntaje, alerta_ids.length ? alerta_ids : null,
       origen, activado_por_uuid, expira_at]
    );

    await client.query('COMMIT');

    if (!row) {
      // Ya existía — no re-activar ni re-emitir
      return { activado: false, registro: null };
    }

    await invalidarCache(alcance, objetivo);

    const msg = `Lockdown N${nivel} activado [${alcance}:${objetivo}] — ${motivo}`;
    logger.warn(msg, { nivel, alcance, objetivo, puntaje, reglas });
    emitirAlertaSeguridad({
      tipo: 'lockdown_activado',
      nivel, alcance, objetivo, motivo, puntaje,
      id: row.id,
    });

    return { activado: true, registro: row };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

/**
 * Resetea (cierra) un lockdown activo por ID.
 * reset_tipo: 'auto' | 'manual'
 */
export const resetearLockdown = async ({
  id,
  reset_por_uuid = null,
  reset_tipo = 'manual',
  reset_nota = null,
}) => {
  const { rows: [row] } = await pool.query(
    `UPDATE security_lockdown
        SET reset_at       = NOW(),
            reset_por_uuid = $2,
            reset_tipo     = $3,
            reset_nota     = $4
      WHERE id = $1 AND reset_at IS NULL
      RETURNING *`,
    [id, reset_por_uuid, reset_tipo, reset_nota]
  );

  if (!row) return { reseteado: false };

  await invalidarCache(row.alcance, row.objetivo);
  logger.info(`Lockdown reseteado [${row.alcance}:${row.objetivo}]`, { id, reset_tipo });

  return { reseteado: true, registro: row };
};

/**
 * Resetea automáticamente todos los lockdowns cuyo expira_at ya pasó.
 * Llamado por el scheduler cada 5 min.
 */
export const resetearVencidos = async () => {
  const { rows } = await pool.query(
    `UPDATE security_lockdown
        SET reset_at   = NOW(),
            reset_tipo = 'auto',
            reset_nota = 'Expiración automática'
      WHERE reset_at IS NULL
        AND expira_at IS NOT NULL
        AND expira_at <= NOW()
      RETURNING alcance, objetivo`
  );

  for (const r of rows) {
    await invalidarCache(r.alcance, r.objetivo);
  }

  if (rows.length) {
    logger.info(`Lockdowns vencidos reseteados: ${rows.length}`, { objetivos: rows });
  }
  return rows.length;
};

/**
 * Cuarentena dirigida (L3) — bloquea un usuario + su IP por 30 min.
 * Se activa desde anomalyDetector cuando exito_tras_fallos dispara.
 * No activa un L3 global (eso es siempre manual).
 */
export const cuarentenaDirigida = async ({
  usuario_uuid,
  ip,
  motivo,
  alerta_ids = [],
  duracion_min = 30,
}) => {
  const expira = new Date(Date.now() + duracion_min * 60_000).toISOString();
  const resultados = [];

  if (usuario_uuid) {
    const r = await activarLockdown({
      nivel: 3,
      alcance: 'usuario',
      objetivo: usuario_uuid,
      motivo,
      alerta_ids,
      origen: 'auto',
      expira_at: expira,
    });
    resultados.push({ alcance: 'usuario', ...r });
  }

  if (ip) {
    const r = await activarLockdown({
      nivel: 3,
      alcance: 'ip',
      objetivo: ip,
      motivo,
      alerta_ids,
      origen: 'auto',
      expira_at: expira,
    });
    resultados.push({ alcance: 'ip', ...r });
  }

  return resultados;
};

/**
 * Consulta si hay lockdown activo para una combinación (alcance, objetivo).
 * Usa Redis como cache de primer nivel (TTL 5 min).
 * El middleware lockdown.js usa esta función.
 */
export const obtenerLockdownActivo = async (alcance, objetivo) => {
  const key = cacheKey(alcance, objetivo);

  if (redisClient) {
    try {
      const cached = await redisClient.get(key);
      if (cached !== null) {
        return cached === 'none' ? null : JSON.parse(cached);
      }
    } catch { /* fallo transitorio — caer a DB */ }
  }

  const { rows: [row] } = await pool.query(
    `SELECT id, nivel, alcance, objetivo, motivo, expira_at
       FROM security_lockdown
      WHERE alcance = $1 AND objetivo = $2
        AND reset_at IS NULL
        AND (expira_at IS NULL OR expira_at > NOW())
      LIMIT 1`,
    [alcance, objetivo]
  );

  if (redisClient) {
    const val = row ? JSON.stringify(row) : 'none';
    await redisClient.set(key, val, { EX: CACHE_TTL }).catch(() => {});
  }

  return row ?? null;
};

/**
 * Verifica si una request está afectada por algún lockdown activo.
 * Orden: global → ip → usuario (del más amplio al más específico).
 * Retorna el primer lockdown que aplica, o null si libre.
 */
export const verificarLockdown = async ({ ip, usuario_uuid }) => {
  // L2 global — afecta todos
  const global = await obtenerLockdownActivo('global', '*');
  if (global) return global;

  // L3 por IP
  if (ip) {
    const porIp = await obtenerLockdownActivo('ip', ip);
    if (porIp) return porIp;
  }

  // L3 por usuario
  if (usuario_uuid) {
    const porUsuario = await obtenerLockdownActivo('usuario', usuario_uuid);
    if (porUsuario) return porUsuario;
  }

  return null;
};

/**
 * Lista todos los lockdowns activos (para panel admin).
 */
export const listarLockdownsActivos = async () => {
  const { rows } = await pool.query(
    `SELECT ld.*, u.nombre AS activado_por_nombre
       FROM security_lockdown ld
       LEFT JOIN global_usuarios u ON u.id = ld.activado_por_uuid
      WHERE ld.reset_at IS NULL
        AND (ld.expira_at IS NULL OR ld.expira_at > NOW())
      ORDER BY ld.activado_at DESC`
  );
  return rows;
};

/**
 * Historial de lockdowns (activos + reseteados) — para audit trail.
 */
export const historialLockdowns = async ({ limit = 50, offset = 0 } = {}) => {
  const { rows } = await pool.query(
    `SELECT ld.*,
            ua.nombre AS activado_por_nombre,
            ur.nombre AS reset_por_nombre
       FROM security_lockdown ld
       LEFT JOIN global_usuarios ua ON ua.id = ld.activado_por_uuid
       LEFT JOIN global_usuarios ur ON ur.id = ld.reset_por_uuid
      ORDER BY ld.activado_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
};
