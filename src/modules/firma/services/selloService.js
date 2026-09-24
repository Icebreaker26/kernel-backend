import crypto from 'crypto';
import { env } from '../../../config/env.js';

// Sello Ed25519 del servidor. La clave pública se puede publicar: cualquiera verifica un sello sin poder falsificarlo.
// Con FIRMA_SELLO_PRIVATE_KEY (PEM PKCS8) se usa esa clave; si no, se deriva de JWT_SECRET (cambiarlo invalida los sellos previos).
const PREFIJO_PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

const cargarClave = () => {
  if (env.FIRMA_SELLO_PRIVATE_KEY) {
    return crypto.createPrivateKey(env.FIRMA_SELLO_PRIVATE_KEY.replace(/\\n/g, '\n'));
  }
  const semilla = crypto.createHmac('sha256', env.JWT_SECRET).update('kernel-firma-sello-v1').digest();
  return crypto.createPrivateKey({ key: Buffer.concat([PREFIJO_PKCS8_ED25519, semilla]), format: 'der', type: 'pkcs8' });
};

const privada = cargarClave();
const publica = crypto.createPublicKey(privada);

const b64u = (b) => Buffer.from(b).toString('base64url');

export const clavePublicaPem = () => publica.export({ type: 'spki', format: 'pem' });

// payload = { f: folio, h: hash del original, t: ISO, e: id del empleado }
export const firmarSello = (payload) => {
  const cuerpo = b64u(JSON.stringify(payload));
  const firma = crypto.sign(null, Buffer.from(cuerpo), privada);
  return `${cuerpo}.${b64u(firma)}`;
};

export const verificarSello = (token) => {
  try {
    const [cuerpo, firma] = String(token).split('.');
    if (!cuerpo || !firma) return null;
    const ok = crypto.verify(null, Buffer.from(cuerpo), publica, Buffer.from(firma, 'base64url'));
    return ok ? JSON.parse(Buffer.from(cuerpo, 'base64url').toString()) : null;
  } catch {
    return null;
  }
};
