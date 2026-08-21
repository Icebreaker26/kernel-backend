import pool from '../db/database.js';
import logger from '../config/logger.js';
import { enviarEmail } from './emailService.js';
import { buildCampanaHtml } from './emailTemplates.js';

// ── Ritmo de envío ────────────────────────────────────────────────────────────
// El relay tiene límite de 500 emails/hora (global).
// 4 emails cada 30 segundos = 480/hora — margen de 20 para otros envíos del sistema.
const TICK_MS        = 30_000;
const EMAILS_POR_TICK = 4;

let timer = null;

const tick = async () => {
  // Tomar los próximos N pendientes de la cola (cualquier campaña, FIFO)
  const { rows: trabajos } = await pool.query(`
    SELECT cm.id, cm.campana_id, cm.email, cm.asociado_codigo,
           c.asunto, c.cuerpo_html, c.cuerpo_texto
    FROM cola_mailing cm
    JOIN campanas c ON c.id = cm.campana_id
    WHERE cm.estado = 'pendiente'
    ORDER BY cm.created_at
    LIMIT $1
    FOR UPDATE OF cm SKIP LOCKED
  `, [EMAILS_POR_TICK]);

  if (!trabajos.length) return;

  await Promise.allSettled(trabajos.map(async (j) => {
    try {
      const html = buildCampanaHtml(j.asunto, j.cuerpo_html);
      await enviarEmail(j.email, j.asunto, html, j.cuerpo_texto ?? '');

      await pool.query(`
        UPDATE cola_mailing SET estado = 'enviado', procesado_at = NOW() WHERE id = $1
      `, [j.id]);

      await pool.query(`
        UPDATE campanas SET enviados = enviados + 1, updated_at = NOW() WHERE id = $1
      `, [j.campana_id]);

      await pool.query(`
        INSERT INTO email_logs (tipo, destinatario, asociado_codigo, estado)
        VALUES ('campana', $1, $2, 'enviado')
      `, [j.email, j.asociado_codigo]);

    } catch (err) {
      logger.error(`dispatcher — campana ${j.campana_id} → ${j.email}: ${err.message}`);

      await pool.query(`
        UPDATE cola_mailing SET estado = 'error', error_msg = $2, procesado_at = NOW() WHERE id = $1
      `, [j.id, err.message]);

      await pool.query(`
        UPDATE campanas SET errores = errores + 1, updated_at = NOW() WHERE id = $1
      `, [j.campana_id]);

      await pool.query(`
        INSERT INTO email_logs (tipo, destinatario, asociado_codigo, estado, error_msg)
        VALUES ('campana', $1, $2, 'error', $3)
      `, [j.email, j.asociado_codigo, err.message]);
    }
  }));

  // Cerrar campañas cuya cola ya no tiene pendientes
  const campanasAfectadas = [...new Set(trabajos.map(j => j.campana_id))];
  for (const id of campanasAfectadas) {
    const { rows: [res] } = await pool.query(`
      SELECT COUNT(*) FILTER (WHERE estado = 'pendiente') AS pendientes,
             COUNT(*) FILTER (WHERE estado = 'error')    AS errores_total,
             COUNT(*)                                    AS total
      FROM cola_mailing WHERE campana_id = $1
    `, [id]);

    if (Number(res.pendientes) === 0) {
      const estadoFinal = Number(res.errores_total) === Number(res.total) ? 'error' : 'enviada';
      await pool.query(`
        UPDATE campanas
        SET estado = $2, enviada_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND estado = 'enviando'
      `, [id, estadoFinal]);
      logger.info(`dispatcher — campaña ${id} completada: ${estadoFinal}`);
    }
  }
};

// ── API pública ───────────────────────────────────────────────────────────────
export const startDispatcher = () => {
  if (timer) return;
  timer = setInterval(async () => {
    try { await tick(); }
    catch (err) { logger.error(`dispatcher tick error: ${err.message}`); }
  }, TICK_MS);
  logger.info(`mailing dispatcher iniciado — ${EMAILS_POR_TICK} emails cada ${TICK_MS / 1000}s (${EMAILS_POR_TICK * (3600 / (TICK_MS / 1000))}/hora)`);
};

export const stopDispatcher = () => {
  if (timer) { clearInterval(timer); timer = null; }
};
