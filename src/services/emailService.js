import nodemailer from 'nodemailer';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import logger from '../config/logger.js';
import { env } from '../config/env.js';
import pool from '../db/database.js';
import { buildCredencialesHtml } from './emailTemplates.js';

// ── Relay HTTP (producción) ───────────────────────────────────────────────────
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

// ── Resend por HTTPS (canal principal en producción; Railway Hobby bloquea SMTP pero sí llega a 443) ──
const resendConfigurado = () => !!(env.RESEND_API_KEY && env.RESEND_FROM);

const sendViaResend = async (to, subject, html, text) => {
  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
    body:    JSON.stringify({ from: env.RESEND_FROM, to: [to], subject, html, ...(text ? { text } : {}) }),
    signal:  AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `Resend error ${res.status}`);
  }
};

// ── Amazon SES por HTTPS (respaldo del relay; Railway sí llega a 443) ─────────
let ses = null;

// Usuario IAM propio de SES; si no se define, cae en las llaves generales AWS_*
const sesCredenciales = () => ({
  accessKeyId:     env.SES_ACCESS_KEY_ID     ?? env.AWS_ACCESS_KEY_ID,
  secretAccessKey: env.SES_SECRET_ACCESS_KEY ?? env.AWS_SECRET_ACCESS_KEY,
});

const sesConfigurado = () => {
  const c = sesCredenciales();
  return !!(env.SES_FROM && c.accessKeyId && c.secretAccessKey);
};

const sendViaSes = async (to, subject, html, text) => {
  if (!ses) {
    ses = new SESv2Client({
      region: env.SES_REGION ?? env.AWS_REGION,
      credentials: sesCredenciales(),
    });
  }
  await ses.send(new SendEmailCommand({
    FromEmailAddress: env.SES_FROM,
    Destination: { ToAddresses: [to] },
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
          ...(text ? { Text: { Data: text, Charset: 'UTF-8' } } : {}),
        },
      },
    },
  }));
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
  } catch { /* no fallar si el log falla */ }
};

// ── Envío genérico (relay con fallback SMTP) ──────────────────────────────────
// En tests no se envía nada: los correos quedan en memoria para que los tests lean, p. ej., el código OTP.
export const emailsDePrueba = [];
export const simulacionDePrueba = { fallar: false };

// Intenta el canal principal y, si falla y hay respaldo, el respaldo. Si ambos fallan, lanza el error del respaldo.
export const enviarConRespaldo = async (principal, respaldo, args) => {
  try {
    await principal(...args);
  } catch (err) {
    if (!respaldo) throw err;
    logger.warn(`email: el canal principal falló (${err.message}); se usa el respaldo`);
    await respaldo(...args);
  }
};

// Prueba los canales en orden; devuelve al primero que funcione y, si todos fallan, lanza el error del último.
export const enviarPorCadena = async (canales, args) => {
  for (let i = 0; i < canales.length; i++) {
    try {
      await canales[i](...args);
      return;
    } catch (err) {
      if (i === canales.length - 1) throw err;
      logger.warn(`email: el canal ${canales[i].name} falló (${err.message}); se prueba el siguiente`);
    }
  }
};

// Direcciones que rebotaron de forma permanente o se quejaron (llegan de SES por SNS): no se les escribe más
export const estaSuprimido = async (email) => {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM email_supresiones WHERE lower(email) = lower($1) AND is_active = true', [email]
  );
  return rowCount > 0;
};

export const enviarEmail = async (to, subject, html, text = '') => {
  if (await estaSuprimido(to)) {
    throw Object.assign(new Error('La dirección está en la lista de supresión (rebote o queja previa)'), { code: 'EMAIL_SUPRIMIDO' });
  }
  if (process.env.NODE_ENV === 'test') {
    if (simulacionDePrueba.fallar) throw new Error('Correo no disponible (simulado)');
    emailsDePrueba.push({ to, subject, html, text });
    return;
  }
  // Orden: Resend (HTTPS, no depende de ningún equipo nuestro) → relay → SES; cada uno respalda al anterior
  const canales = [];
  if (resendConfigurado()) canales.push(sendViaResend);
  if (env.RELAY_URL && env.RELAY_SECRET) canales.push(sendViaRelay);
  if (sesConfigurado() && (canales.length > 0 || !env.SMTP_HOST)) canales.push(sendViaSes);
  if (canales.length > 0) {
    await enviarPorCadena(canales, [to, subject, html, text]);
  } else if (sesConfigurado() && !env.SMTP_HOST) {
    await sendViaSes(to, subject, html, text);
  } else {
    await getTransporter().sendMail({ from: env.SMTP_FROM, to, subject, html, text });
  }
};

// ── Credenciales de portal (activación de asociado) ───────────────────────────
export const enviarCredencialesPortal = async (email, codigo, password) => {
  if (process.env.NODE_ENV === 'test') return;

  const subject = 'Tus credenciales de acceso — Portal Cooperativa Progresemos';
  const html    = buildCredencialesHtml(codigo, password);
  const text    = [
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
    await enviarEmail(email, subject, html, text);
    await logEmail('credenciales_portal', email, codigo, 'enviado');
  } catch (err) {
    await logEmail('credenciales_portal', email, codigo, 'error', err.message);
    throw err;
  }
};

// ── Código de verificación para firmar la vinculación ────────────────────────
const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const enviarCodigoFirma = async (email, nombre, codigo, minutos) => {
  const subject = `${codigo} es tu código para firmar — Cooperativa Progresemos`;
  const html = `<!DOCTYPE html><html lang="es"><body style="margin:0;padding:24px;background:#f0f4f8;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center">
    <table cellpadding="0" cellspacing="0" role="presentation" style="max-width:480px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
      <tr><td style="background:#065B8E;padding:20px 28px;color:#ffffff;font-size:13px;letter-spacing:3px;">COOPERATIVA PROGRESEMOS</td></tr>
      <tr><td style="padding:28px;color:#1e293b;font-size:15px;line-height:1.5;">
        <p style="margin:0 0 12px;">Hola ${escHtml(nombre)},</p>
        <p style="margin:0 0 20px;">Usa este código para confirmar tu identidad y firmar tu solicitud de asociación:</p>
        <p style="margin:0 0 20px;text-align:center;font-size:34px;font-weight:700;letter-spacing:10px;color:#065B8E;">${escHtml(codigo)}</p>
        <p style="margin:0 0 8px;color:#475569;">Vence en ${minutos} minutos y solo sirve una vez.</p>
        <p style="margin:0;color:#94a3b8;font-size:12px;">Si no estás asociándote a la cooperativa, ignora este correo y no compartas el código con nadie.</p>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
  const text = [
    `Hola ${nombre},`, '',
    `Tu código para firmar tu solicitud de asociación es: ${codigo}`,
    `Vence en ${minutos} minutos y solo sirve una vez.`, '',
    'Si no estás asociándote a la cooperativa, ignora este correo y no compartas el código con nadie.',
    '', '— Cooperativa Progresemos',
  ].join('\n');

  try {
    await enviarEmail(email, subject, html, text);
    await logEmail('codigo_firma', email, null, 'enviado');
  } catch (err) {
    await logEmail('codigo_firma', email, null, 'error', err.message);
    throw err;
  }
};

// ── PQRS: confirmación al radicar y respuesta ────────────────────────────────
const marcoCorreo = (titulo, cuerpoHtml) => `<!DOCTYPE html><html lang="es"><body style="margin:0;padding:24px;background:#f0f4f8;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center">
    <table cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
      <tr><td style="background:#065B8E;padding:20px 28px;color:#ffffff;font-size:13px;letter-spacing:3px;">COOPERATIVA PROGRESEMOS</td></tr>
      <tr><td style="padding:28px;color:#1e293b;font-size:15px;line-height:1.55;">
        <h2 style="margin:0 0 14px;font-size:20px;color:#0f172a;">${escHtml(titulo)}</h2>
        ${cuerpoHtml}
      </td></tr>
    </table>
  </td></tr></table></body></html>`;

// Es una fecha de calendario (columna DATE, sin hora): se formatea en UTC para que no cambie de día según la zona del servidor
const fechaLarga = (f) => new Date(f).toLocaleDateString('es-CO', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });

// Los correos de PQRS solo se CONSTRUYEN aquí; enviarlos (o dejarlos en cola si no hay canal) lo hace emailColaService.
export const construirConfirmacionPqrs = ({ nombre, radicado, codigo, vence, tipo }) => {
  const asunto = `Recibimos tu ${tipo.toLowerCase()} — radicado ${radicado}`;
  const html = marcoCorreo('Recibimos tu solicitud', `
    <p style="margin:0 0 14px;">Hola ${escHtml(nombre)}, registramos tu ${escHtml(tipo.toLowerCase())}. Guarda estos datos para consultar su estado en nuestro sitio:</p>
    <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 16px;background:#f1f5f9;border-radius:8px;width:100%;">
      <tr><td style="padding:14px 18px;font-size:13px;color:#475569;">Radicado<br><strong style="font-size:18px;color:#065B8E;letter-spacing:1px;">${escHtml(radicado)}</strong></td></tr>
      <tr><td style="padding:0 18px 14px;font-size:13px;color:#475569;">Código de seguimiento<br><strong style="font-size:18px;color:#065B8E;letter-spacing:3px;">${escHtml(codigo)}</strong></td></tr>
    </table>
    <p style="margin:0 0 8px;">Te responderemos a este correo a más tardar el <strong>${escHtml(fechaLarga(vence))}</strong>.</p>
    <p style="margin:0;color:#94a3b8;font-size:12px;">No compartas el código con nadie: permite ver el estado y la respuesta de tu solicitud.</p>`);
  const texto = [`Hola ${nombre},`, '', `Registramos tu ${tipo.toLowerCase()}.`, `Radicado: ${radicado}`, `Código de seguimiento: ${codigo}`,
    `Te responderemos a más tardar el ${fechaLarga(vence)}.`, '', '— Cooperativa Progresemos'].join('\n');
  return { tipo: 'pqrs_confirmacion', asunto, html, texto };
};

export const construirRespuestaPqrs = ({ nombre, radicado, respuesta }) => {
  const asunto = `Respuesta a tu solicitud — radicado ${radicado}`;
  const html = marcoCorreo('Respondimos tu solicitud', `
    <p style="margin:0 0 14px;">Hola ${escHtml(nombre)}, esta es la respuesta a tu solicitud <strong>${escHtml(radicado)}</strong>:</p>
    <div style="margin:0 0 16px;padding:14px 18px;background:#f1f5f9;border-left:4px solid #5B9C3C;border-radius:6px;white-space:pre-wrap;">${escHtml(respuesta)}</div>
    <p style="margin:0;color:#94a3b8;font-size:12px;">También puedes consultarla en nuestro sitio con tu radicado y código de seguimiento.</p>`);
  const texto = [`Hola ${nombre},`, '', `Respuesta a tu solicitud ${radicado}:`, '', respuesta, '', '— Cooperativa Progresemos'].join('\n');
  return { tipo: 'pqrs_respuesta', asunto, html, texto };
};
