import nodemailer from 'nodemailer';
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
export const enviarEmail = async (to, subject, html, text = '') => {
  if (process.env.NODE_ENV === 'test') return;
  if (env.RELAY_URL && env.RELAY_SECRET) {
    await sendViaRelay(to, subject, html, text);
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
