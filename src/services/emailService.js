import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import pool from '../db/database.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── Relay HTTP (producción: servidor de oficina) ───────────────────────────────
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

// ── SMTP directo (desarrollo local) ───────────────────────────────────────────
let transporter = null;

const getTransporter = () => {
  if (!transporter) {
    if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
      throw new Error('SMTP no configurado. Agrega SMTP_HOST, SMTP_USER y SMTP_PASS al .env');
    }
    transporter = nodemailer.createTransport({
      host:              env.SMTP_HOST,
      port:              env.SMTP_PORT,
      secure:            env.SMTP_PORT === 465,
      auth:              { user: env.SMTP_USER, pass: env.SMTP_PASS },
      connectionTimeout: 10000,
      socketTimeout:     15000,
      greetingTimeout:   10000,
    });
  }
  return transporter;
};

// ── Log en DB ─────────────────────────────────────────────────────────────────
const logEmail = async (tipo, destinatario, asociado_codigo, estado, error_msg = null) => {
  try {
    await pool.query(
      `INSERT INTO email_logs (tipo, destinatario, asociado_codigo, estado, error_msg)
       VALUES ($1, $2, $3, $4, $5)`,
      [tipo, destinatario, asociado_codigo, estado, error_msg]
    );
  } catch {
    // no fallar si el log falla
  }
};

// ── Template HTML ─────────────────────────────────────────────────────────────
const buildHtml = (codigo, password) => {
  const portalUrl = env.PORTAL_URL ?? 'https://kernel.cooperativaprogresemos.coop/portal/login';
  const co = esc(codigo);
  const pw = esc(password);

  return /* html */`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Credenciales — Portal Cooperativa Progresemos</title>
</head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f0f4f8;padding:32px 16px;">
    <tr><td align="center">

      <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
        style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

        <tr>
          <td style="background:#003d4d;padding:32px 32px 24px;text-align:center;">
            <p style="margin:0;color:#7dd3e8;font-size:10px;letter-spacing:4px;font-family:Arial,sans-serif;">COOPERATIVA PROGRESEMOS</p>
            <h1 style="margin:10px 0 4px;color:#ffffff;font-size:28px;letter-spacing:4px;font-weight:700;font-family:Courier New,monospace;">KERNEL</h1>
            <p style="margin:0;color:#7dd3e8;font-size:11px;letter-spacing:3px;font-family:Arial,sans-serif;">PORTAL DEL ASOCIADO</p>
          </td>
        </tr>

        <tr>
          <td style="padding:36px 32px 28px;">
            <p style="margin:0 0 8px;color:#1e293b;font-size:16px;font-weight:700;">¡Tu acceso está listo!</p>
            <p style="margin:0 0 28px;color:#475569;font-size:14px;line-height:1.7;">
              Tu cuenta en el Portal del Asociado de la Cooperativa Progresemos ha sido activada.
              A continuación encontrarás tus credenciales de ingreso.
            </p>

            <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
              style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:28px;">
              <tr>
                <td style="padding:22px 24px;">
                  <p style="margin:0 0 16px;color:#64748b;font-size:10px;letter-spacing:3px;font-family:Arial,sans-serif;">TUS CREDENCIALES DE ACCESO</p>

                  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:12px;">
                    <tr>
                      <td style="padding:12px 16px;background:#ffffff;border:1px solid #e2e8f0;border-radius:5px;">
                        <p style="margin:0 0 3px;color:#94a3b8;font-size:10px;letter-spacing:1px;">USUARIO &mdash; NÚMERO DE CÉDULA</p>
                        <p style="margin:0;color:#1e293b;font-size:20px;font-family:Courier New,Courier,monospace;font-weight:700;letter-spacing:1px;">${co}</p>
                      </td>
                    </tr>
                  </table>

                  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                    <tr>
                      <td style="padding:14px 16px;background:#003d4d;border-radius:5px;">
                        <p style="margin:0 0 4px;color:#7dd3e8;font-size:10px;letter-spacing:1px;">CONTRASEÑA TEMPORAL</p>
                        <p style="margin:0;color:#ffffff;font-size:24px;font-family:Courier New,Courier,monospace;font-weight:700;letter-spacing:3px;word-break:break-all;">${pw}</p>
                        <p style="margin:6px 0 0;color:#7dd3e893;font-size:10px;">Haz clic o selecciona el texto para copiarlo</p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>

            <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:28px;">
              <tr>
                <td align="center">
                  <a href="${portalUrl}" style="display:inline-block;background:#006680;color:#ffffff;text-decoration:none;padding:15px 40px;border-radius:5px;font-size:13px;font-weight:700;letter-spacing:2px;font-family:Arial,sans-serif;">
                    INGRESAR AL PORTAL &rarr;
                  </a>
                </td>
              </tr>
              <tr>
                <td align="center" style="padding-top:10px;">
                  <p style="margin:0;color:#94a3b8;font-size:11px;">
                    O copia y pega este enlace en tu navegador:<br>
                    <span style="color:#006680;font-size:11px;">${esc(portalUrl)}</span>
                  </p>
                </td>
              </tr>
            </table>

            <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:24px;">
              <tr>
                <td style="padding:14px 18px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;">
                  <p style="margin:0;color:#92400e;font-size:13px;line-height:1.6;">
                    <strong>&#9888; Importante:</strong> Al ingresar por primera vez se te pedirá que
                    crees una contraseña personal. Esta contraseña temporal es de un solo uso —
                    <strong>no la compartas con nadie</strong>.
                  </p>
                </td>
              </tr>
            </table>

            <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.7;">
              Si tienes algún problema para ingresar, comunícate con la cooperativa.
            </p>
          </td>
        </tr>

        <tr>
          <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:20px 32px;text-align:center;">
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

// ── Exportación principal ─────────────────────────────────────────────────────
export const enviarCredencialesPortal = async (email, codigo, password) => {
  if (process.env.NODE_ENV === 'test') return;

  const subject = 'Tus credenciales de acceso — Portal Cooperativa Progresemos';
  const html    = buildHtml(codigo, password);
  const text    = [
    'Hola,',
    '',
    'Tu acceso al Portal del Asociado de la Cooperativa Progresemos ha sido activado.',
    '',
    `Usuario (cédula): ${codigo}`,
    `Contraseña temporal: ${password}`,
    '',
    `Ingresa en: ${env.PORTAL_URL ?? 'https://cooperativaprogresemos.coop/portal/login'}`,
    '',
    'Al ingresar por primera vez se te pedirá que crees una contraseña personal.',
    'No compartas tus credenciales con nadie.',
    '',
    '— Cooperativa Progresemos',
  ].join('\n');

  try {
    if (env.RELAY_URL && env.RELAY_SECRET) {
      await sendViaRelay(email, subject, html, text);
    } else {
      await getTransporter().sendMail({ from: env.SMTP_FROM, to: email, subject, html, text });
    }
    await logEmail('credenciales_portal', email, codigo, 'enviado');
  } catch (err) {
    await logEmail('credenciales_portal', email, codigo, 'error', err.message);
    throw err;
  }
};
