import crypto from 'crypto';
import pool from '../db/database.js';
import { env } from '../config/env.js';

/**
 * Baja voluntaria de campañas y avisos institucionales.
 * El enlace del pie de cada correo lleva un token firmado con el correo del destinatario, así la baja
 * funciona sin iniciar sesión y sin guardar tokens. No caduca: los correos viejos deben seguir sirviendo.
 */

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64url');
const firma = (email) => crypto.createHmac('sha256', `${env.JWT_SECRET}:baja`).update(email).digest('base64url').slice(0, 32);

export const crearTokenBaja = (email) => {
  const e = String(email).trim().toLowerCase();
  return `${b64(e)}.${firma(e)}`;
};

/** Devuelve el correo del token, o null si fue alterado o no tiene el formato esperado. */
export const leerTokenBaja = (token) => {
  try {
    const [cuerpo, sig] = String(token).split('.');
    if (!cuerpo || !sig) return null;
    const email = Buffer.from(cuerpo, 'base64url').toString('utf8');
    const esperado = firma(email);
    const a = Buffer.from(sig);
    const b = Buffer.from(esperado);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return email;
  } catch { return null; }
};

export const urlBaja = (email) => `${env.FRONTEND_URL.replace(/\/$/, '')}/baja/${crearTokenBaja(email)}`;

export const estaDeBaja = async (email) => {
  const { rowCount } = await pool.query(
    'SELECT 1 FROM email_bajas WHERE lower(email) = lower($1) AND is_active = true', [email]
  );
  return rowCount > 0;
};

export const enmascararCorreo = (correo) => {
  const [u, d] = String(correo).split('@');
  return `${u.slice(0, 2)}${'*'.repeat(Math.max(u.length - 2, 2))}@${d}`;
};
