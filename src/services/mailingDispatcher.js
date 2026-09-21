import pool from '../db/database.js';
import logger from '../config/logger.js';
import { enviarEmail, sesConfigurado } from './emailService.js';
import { env } from '../config/env.js';
import { buildCampanaHtml } from './emailTemplates.js';
import { estaDeBaja, urlBaja } from './emailBajaService.js';

// ── Ritmo de envío ────────────────────────────────────────────────────────────
// Con Amazon SES (cuota 50.000/día): 10 correos cada 5 s = 7.200/h, muy por debajo del máximo por segundo de SES
// y suficiente para que los correos de una jornada presencial lleguen mientras la gente sigue ahí.
// Sin SES el canal es el relay, con tope de 500/h: 4 cada 30 s = 480/h (margen de 20 para otros envíos).
// MAILING_POR_TICK / MAILING_TICK_MS lo sobreescriben.
const ritmo = () => {
  const ses = sesConfigurado();
  return {
    tickMs:      env.MAILING_TICK_MS   ?? (ses ? 5_000 : 30_000),
    porTick:     env.MAILING_POR_TICK  ?? (ses ? 10 : 4),
  };
};

export const velocidadPorHora = () => {
  const { tickMs, porTick } = ritmo();
  return Math.round(porTick * (3_600_000 / tickMs));
};

let timer = null;
let enCurso = false;   // el SELECT ... FOR UPDATE no retiene el bloqueo fuera de una transacción: un solo tick a la vez

export const tick = async () => {
  const { porTick } = ritmo();
  // Tomar los próximos N pendientes de la cola (cualquier campaña, FIFO)
  const { rows: trabajos } = await pool.query(`
    SELECT cm.id, cm.campana_id, cm.email, cm.asociado_codigo,
           c.asunto, c.cuerpo_html, c.cuerpo_texto, c.audiencia
    FROM cola_mailing cm
    JOIN campanas c ON c.id = cm.campana_id
    WHERE cm.estado = 'pendiente'
    ORDER BY cm.created_at
    LIMIT $1
    FOR UPDATE OF cm SKIP LOCKED
  `, [porTick]);

  if (!trabajos.length) return;

  await Promise.allSettled(trabajos.map(async (j) => {
    try {
      // Baja voluntaria posterior al encolado: no se envía y no cuenta como error
      if (await estaDeBaja(j.email)) {
        await pool.query(
          `UPDATE cola_mailing SET estado = 'omitido', error_msg = 'Baja voluntaria', procesado_at = NOW() WHERE id = $1`, [j.id]
        );
        return;
      }
      const html = buildCampanaHtml(j.asunto, j.cuerpo_html, urlBaja(j.email), j.audiencia);
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
  const { tickMs, porTick } = ritmo();
  timer = setInterval(async () => {
    if (enCurso) return;
    enCurso = true;
    try { await tick(); }
    catch (err) { logger.error(`dispatcher tick error: ${err.message}`); }
    finally { enCurso = false; }
  }, tickMs);
  logger.info(`mailing dispatcher iniciado — ${porTick} emails cada ${tickMs / 1000}s (${velocidadPorHora()}/hora)`);
};

export const stopDispatcher = () => {
  if (timer) { clearInterval(timer); timer = null; }
};
