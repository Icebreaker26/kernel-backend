import pool from '../../../db/database.js';
import { crearCampanaSchema, actualizarCampanaSchema } from '../schemas/mailingSchema.js';
import { env } from '../../../config/env.js';
import logger from '../../../config/logger.js';

const BATCH_SIZE = 50;

// ── Template HTML de campaña ──────────────────────────────────────────────────
const buildCampanaHtml = (asunto, cuerpoHtml) => {
  const portalUrl = env.PORTAL_URL ?? 'https://kernel.cooperativaprogresemos.coop/portal';
  return /* html */`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${asunto}</title>
</head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f0f4f8;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
        style="max-width:580px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <tr>
          <td style="background:#003d4d;padding:28px 32px;text-align:center;">
            <p style="margin:0;color:#7dd3e8;font-size:10px;letter-spacing:4px;">COOPERATIVA PROGRESEMOS</p>
            <h1 style="margin:8px 0 4px;color:#ffffff;font-size:26px;letter-spacing:4px;font-weight:700;font-family:Courier New,monospace;">KERNEL</h1>
          </td>
        </tr>

        <tr>
          <td style="padding:36px 32px 28px;color:#334155;font-size:15px;line-height:1.7;">
            ${cuerpoHtml}
          </td>
        </tr>

        <tr>
          <td align="center" style="padding:0 32px 32px;">
            <a href="${portalUrl}" style="display:inline-block;background:#006680;color:#ffffff;text-decoration:none;padding:13px 36px;border-radius:5px;font-size:13px;font-weight:700;letter-spacing:2px;">
              IR AL PORTAL &rarr;
            </a>
          </td>
        </tr>

        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:18px 32px;text-align:center;">
            <p style="margin:0;color:#94a3b8;font-size:11px;">&copy; Cooperativa Progresemos &middot; Sistema KERNEL</p>
            <p style="margin:4px 0 0;color:#cbd5e1;font-size:10px;">Correo generado automáticamente &mdash; por favor no responder</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
};

// ── Enviar via relay (igual que emailService) ─────────────────────────────────
const sendViaRelay = async (to, subject, html, text) => {
  const res = await fetch(env.RELAY_URL + '/send-email', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.RELAY_SECRET}` },
    body:    JSON.stringify({ to, subject, html, text }),
    signal:  AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Relay error ${res.status}`);
  }
};

// ── Obtener destinatarios ──────────────────────────────────────────────────────
const getDestinatarios = async () => {
  const { rows } = await pool.query(`
    SELECT codigo, nombre, apellido, email
    FROM asociados
    WHERE is_active = true
      AND email IS NOT NULL
      AND email <> ''
    ORDER BY apellido, nombre
  `);
  return rows;
};

// ── Controladores ─────────────────────────────────────────────────────────────

export const listar = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.asunto, c.estado,
             c.destinatarios_total, c.enviados, c.errores,
             c.created_at, c.enviada_at,
             gu.nombre AS creado_por_nombre
      FROM campanas c
      LEFT JOIN global_usuarios gu ON gu.id = c.creado_por
      WHERE c.is_active = true
      ORDER BY c.created_at DESC
    `);
    res.json(rows);
  } catch (err) { next(err); }
};

export const crear = async (req, res, next) => {
  try {
    const data = crearCampanaSchema.parse(req.body);
    const { rows: [camp] } = await pool.query(
      `INSERT INTO campanas (asunto, cuerpo_html, cuerpo_texto, creado_por)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [data.asunto, data.cuerpo_html, data.cuerpo_texto ?? null, req.user.id]
    );
    res.status(201).json(camp);
  } catch (err) { next(err); }
};

export const actualizar = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: [camp] } = await pool.query(
      `SELECT estado FROM campanas WHERE id = $1 AND is_active = true`, [id]
    );
    if (!camp) return res.status(404).json({ error: 'Campaña no encontrada' });
    if (camp.estado !== 'borrador') return res.status(409).json({ error: 'Solo se pueden editar campañas en borrador' });

    const data = actualizarCampanaSchema.parse(req.body);
    const sets = []; const vals = [id];
    if (data.asunto      !== undefined) { vals.push(data.asunto);       sets.push(`asunto = $${vals.length}`); }
    if (data.cuerpo_html !== undefined) { vals.push(data.cuerpo_html);  sets.push(`cuerpo_html = $${vals.length}`); }
    if (data.cuerpo_texto !== undefined){ vals.push(data.cuerpo_texto); sets.push(`cuerpo_texto = $${vals.length}`); }
    if (!sets.length) return res.json(camp);

    sets.push(`updated_at = NOW()`);
    const { rows: [updated] } = await pool.query(
      `UPDATE campanas SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals
    );
    res.json(updated);
  } catch (err) { next(err); }
};

export const eliminar = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: [camp] } = await pool.query(
      `UPDATE campanas SET is_active = false, updated_at = NOW() WHERE id = $1 AND is_active = true RETURNING id`,
      [id]
    );
    if (!camp) return res.status(404).json({ error: 'Campaña no encontrada' });
    res.json({ ok: true });
  } catch (err) { next(err); }
};

export const preview = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: [camp] } = await pool.query(
      `SELECT * FROM campanas WHERE id = $1 AND is_active = true`, [id]
    );
    if (!camp) return res.status(404).json({ error: 'Campaña no encontrada' });
    const destinatarios = await getDestinatarios();
    res.json({ ...camp, destinatarios_count: destinatarios.length });
  } catch (err) { next(err); }
};

export const enviar = async (req, res, next) => {
  const { id } = req.params;
  try {
    const { rows: [camp] } = await pool.query(
      `UPDATE campanas SET estado = 'enviando', updated_at = NOW()
       WHERE id = $1 AND is_active = true AND estado = 'borrador'
       RETURNING *`,
      [id]
    );
    if (!camp) return res.status(409).json({ error: 'La campaña no existe o ya fue enviada' });

    const destinatarios = await getDestinatarios();
    await pool.query(
      `UPDATE campanas SET destinatarios_total = $2 WHERE id = $1`,
      [id, destinatarios.length]
    );

    // Responde inmediato — el envío corre en background
    res.json({ ok: true, destinatarios: destinatarios.length });

    // ── Envío en lotes ────────────────────────────────────────────────────────
    let enviados = 0; let errores = 0;
    const html = buildCampanaHtml(camp.asunto, camp.cuerpo_html);

    for (let i = 0; i < destinatarios.length; i += BATCH_SIZE) {
      const lote = destinatarios.slice(i, i + BATCH_SIZE);
      await Promise.allSettled(
        lote.map(async (d) => {
          try {
            await sendViaRelay(d.email, camp.asunto, html, camp.cuerpo_texto ?? camp.asunto);
            await pool.query(
              `INSERT INTO email_logs (tipo, destinatario, asociado_codigo, estado) VALUES ('campana', $1, $2, 'enviado')`,
              [d.email, d.codigo]
            );
            enviados++;
          } catch (err) {
            await pool.query(
              `INSERT INTO email_logs (tipo, destinatario, asociado_codigo, estado, error_msg) VALUES ('campana', $1, $2, 'error', $3)`,
              [d.email, d.codigo, err.message]
            );
            errores++;
            logger.error(`campana ${id} — error enviando a ${d.email}: ${err.message}`);
          }
        })
      );
      // pausa entre lotes para no saturar el relay
      if (i + BATCH_SIZE < destinatarios.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    const estadoFinal = errores === destinatarios.length ? 'error' : 'enviada';
    await pool.query(
      `UPDATE campanas SET estado = $2, enviados = $3, errores = $4, enviada_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id, estadoFinal, enviados, errores]
    );
    logger.info(`campana ${id} completada: ${enviados} enviados, ${errores} errores`);
  } catch (err) { next(err); }
};
