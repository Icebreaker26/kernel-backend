import crypto from 'crypto';
import { env } from '../config/env.js';

/**
 * Verificación de mensajes de Amazon SNS (SubscriptionConfirmation / Notification).
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 *
 * La firma prueba que el mensaje lo emitió SNS; el ARN del tema (env.SES_SNS_TOPIC_ARN) prueba que es
 * NUESTRO tema. Sin las dos comprobaciones, cualquiera con su propio tema SNS podría suprimir direcciones.
 */

const HOST_SNS = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

// Campos que entran en la cadena firmada, en este orden (Subject solo si viene)
const CAMPOS_FIRMA = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};

export const esUrlDeSns = (valor) => {
  try {
    const u = new URL(valor);
    return u.protocol === 'https:' && HOST_SNS.test(u.hostname);
  } catch { return false; }
};

const cadenaAFirmar = (msg) => {
  const campos = CAMPOS_FIRMA[msg.Type];
  if (!campos) return null;
  return campos
    .filter((k) => msg[k] !== undefined && msg[k] !== null)
    .map((k) => `${k}\n${msg[k]}\n`)
    .join('');
};

// En tests no hay red: el certificado se toma de este mapa (URL → PEM)
export const certificadosDePrueba = new Map();
// En tests la confirmación de suscripción tampoco sale a la red
export const suscripcionesConfirmadasDePrueba = [];

const cacheCertificados = new Map();

const obtenerCertificado = async (url) => {
  if (env.NODE_ENV === 'test') return certificadosDePrueba.get(url) ?? null;
  if (cacheCertificados.has(url)) return cacheCertificados.get(url);
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const pem = await res.text();
  cacheCertificados.set(url, pem);
  return pem;
};

/** true solo si la firma del mensaje es válida y el certificado viene de un host de SNS. */
export const verificarMensajeSns = async (msg) => {
  try {
    if (!msg || typeof msg !== 'object') return false;
    const aFirmar = cadenaAFirmar(msg);
    if (!aFirmar || !msg.Signature || !msg.SigningCertURL) return false;
    if (!esUrlDeSns(msg.SigningCertURL) || !new URL(msg.SigningCertURL).pathname.endsWith('.pem')) return false;

    const algoritmo = msg.SignatureVersion === '2' ? 'sha256' : msg.SignatureVersion === '1' ? 'sha1' : null;
    if (!algoritmo) return false;

    const pem = await obtenerCertificado(msg.SigningCertURL);
    if (!pem) return false;
    return crypto.verify(algoritmo, Buffer.from(aFirmar, 'utf8'), crypto.createPublicKey(pem), Buffer.from(msg.Signature, 'base64'));
  } catch {
    return false;
  }
};

/** Confirma la suscripción del endpoint visitando la SubscribeURL (solo hosts de SNS). */
export const confirmarSuscripcion = async (subscribeUrl) => {
  if (!esUrlDeSns(subscribeUrl)) throw new Error('SubscribeURL no válida');
  if (env.NODE_ENV === 'test') { suscripcionesConfirmadasDePrueba.push(subscribeUrl); return; }
  const res = await fetch(subscribeUrl, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`SNS respondió ${res.status} al confirmar la suscripción`);
};
