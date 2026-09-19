import pool from '../../../db/database.js';
import logger from '../../../config/logger.js';
import { env } from '../../../config/env.js';
import { verificarMensajeSns, confirmarSuscripcion } from '../../../services/snsService.js';

// Suprime (o reactiva la supresión de) una dirección tras un rebote permanente o una queja.
const suprimir = async (email, motivo, detalle) => {
  await pool.query(
    `INSERT INTO email_supresiones (email, motivo, detalle)
     VALUES (lower($1), $2, $3)
     ON CONFLICT (lower(email))
     DO UPDATE SET motivo = EXCLUDED.motivo, detalle = EXCLUDED.detalle, is_active = true, updated_at = NOW()`,
    [email, motivo, JSON.stringify(detalle ?? null)]
  );
};

const registrarEvento = (tipo, email, messageId, payload) => pool.query(
  `INSERT INTO email_ses_eventos (tipo, email, message_id, payload) VALUES ($1, lower($2), $3, $4)`,
  [tipo, email, messageId ?? null, JSON.stringify(payload ?? null)]
);

// Interpreta la notificación de SES (dentro de Message) y actualiza supresiones + bitácora
const procesarNotificacion = async (notificacion, messageId) => {
  const tipo = notificacion.notificationType ?? notificacion.eventType;

  if (tipo === 'Bounce') {
    const { bounceType, bounceSubType, bouncedRecipients = [], timestamp } = notificacion.bounce ?? {};
    const permanente = bounceType === 'Permanent';
    for (const r of bouncedRecipients) {
      if (!r?.emailAddress) continue;
      const detalle = { bounceType, bounceSubType, diagnostico: r.diagnosticCode, timestamp };
      await registrarEvento(permanente ? 'rebote_permanente' : 'rebote_temporal', r.emailAddress, messageId, detalle);
      // Solo el rebote permanente suprime; el temporal (buzón lleno, servidor caído) puede resolverse solo
      if (permanente) await suprimir(r.emailAddress, 'rebote', detalle);
    }
  } else if (tipo === 'Complaint') {
    const { complainedRecipients = [], complaintFeedbackType, timestamp } = notificacion.complaint ?? {};
    for (const r of complainedRecipients) {
      if (!r?.emailAddress) continue;
      const detalle = { complaintFeedbackType, timestamp };
      await registrarEvento('queja', r.emailAddress, messageId, detalle);
      await suprimir(r.emailAddress, 'queja', detalle);
    }
  }
  // Otros tipos (Delivery, etc.) no se guardan
};

// Endpoint público al que SNS entrega las notificaciones de SES. No lleva JWT: la autenticidad la
// prueba la firma de SNS y el ARN del tema. Responde 2xx a lo que no sea un rechazo real, para que
// SNS no reintente en bucle.
export const recibirEventosSes = async (req, res, next) => {
  try {
    if (!env.SES_SNS_TOPIC_ARN) return res.status(503).json({ error: 'Recepción de eventos de SES no configurada' });

    let msg;
    try { msg = JSON.parse(typeof req.body === 'string' ? req.body : ''); }
    catch { return res.status(400).json({ error: 'Cuerpo no válido' }); }

    if (!(await verificarMensajeSns(msg))) {
      logger.warn(`email: mensaje SNS con firma inválida desde ${req.ip}`);
      return res.status(403).json({ error: 'Firma no válida' });
    }
    if (msg.TopicArn !== env.SES_SNS_TOPIC_ARN) {
      logger.warn(`email: mensaje SNS de un tema no autorizado (${msg.TopicArn})`);
      return res.status(403).json({ error: 'Tema no autorizado' });
    }

    if (msg.Type === 'SubscriptionConfirmation') {
      await confirmarSuscripcion(msg.SubscribeURL);
      return res.json({ ok: true, suscripcion: 'confirmada' });
    }

    if (msg.Type === 'Notification') {
      let notificacion;
      try { notificacion = JSON.parse(msg.Message); }
      catch { return res.json({ ok: true, ignorado: 'mensaje sin JSON' }); }
      await procesarNotificacion(notificacion, msg.MessageId);
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
};

// ── Administración de la lista de supresión ───────────────────────────────────

export const listarSupresiones = async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, motivo, detalle, created_at, updated_at
         FROM email_supresiones WHERE is_active = true ORDER BY updated_at DESC LIMIT 500`
    );
    res.json(rows);
  } catch (err) { next(err); }
};

// Reactiva una dirección (borrado lógico de la supresión), p. ej. si el buzón se corrigió
export const reactivarDireccion = async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE email_supresiones SET is_active = false, updated_at = NOW() WHERE id = $1 AND is_active = true`,
      [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Supresión no encontrada' });
    res.json({ ok: true });
  } catch (err) { next(err); }
};
