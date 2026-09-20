import pool from '../db/database.js';
import logger from '../config/logger.js';
import { enviarEmail } from './emailService.js';
import { notificarPorPermiso } from './notificationService.js';

/**
 * Cola de correos transaccionales. `enviarOEncolar` intenta enviar en el momento; si no hay canal disponible (relay y SES
 * caídos o sin configurar) guarda el correo y `procesarCola`, que corre cada minuto, lo reintenta con esperas crecientes.
 *
 *  - Solo se encolan fallos transitorios. Una dirección suprimida (rebotó o se quejó antes) es definitiva: no se encola.
 *  - El primer intento es el directo; la cola hace hasta MAX_INTENTOS más (≈ 52 horas en total) y luego marca `fallido`
 *    y avisa a quienes gestionan PQRS.
 *  - El HTML y el texto se borran al terminar (pueden llevar el código de seguimiento de una solicitud).
 */

// Minutos de espera antes del reintento n (el 0 es la espera desde que se encola)
export const ESPERAS_MIN = [1, 5, 15, 30, 60, 120, 240, 480, 720, 1440, 1440];
export const MAX_INTENTOS = ESPERAS_MIN.length;

const LOTE = 10;                 // correos por pasada: la cola no debe competir con el envío masivo (tope del relay por hora)
const PASADA_MS = 60_000;
const ATASCADO_MIN = 10;         // un envío "en curso" más viejo que esto se considera perdido (proceso caído)
const RETENCION_DIAS = 30;

const logEmail = async (tipo, destinatario, estado, errorMsg = null) => {
  try {
    await pool.query(
      `INSERT INTO email_logs (tipo, destinatario, estado, error_msg) VALUES ($1, $2, $3, $4)`,
      [tipo, destinatario, estado, errorMsg]);
  } catch { /* el log no debe romper el envío */ }
};

export const encolarEmail = async ({ tipo, to, asunto, html, texto = '', referencia_tipo = null, referencia_id = null, error = null }) => {
  const { rows: [fila] } = await pool.query(
    `INSERT INTO email_cola (tipo, destinatario, asunto, html, texto, referencia_tipo, referencia_id, ultimo_error, proximo_intento)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + make_interval(mins => $9))
     RETURNING id`,
    [tipo, to, asunto, html, texto, referencia_tipo, referencia_id, error, ESPERAS_MIN[0]]);
  return fila.id;
};

/**
 * Envía ahora o, si no se puede, deja el correo en cola. Devuelve 'enviado' | 'en_cola' | 'suprimido'.
 * Solo lanza error si ni siquiera se pudo guardar en la cola (base de datos caída).
 */
export const enviarOEncolar = async (msg) => {
  try {
    await enviarEmail(msg.to, msg.asunto, msg.html, msg.texto ?? '');
    await logEmail(msg.tipo, msg.to, 'enviado');
    return 'enviado';
  } catch (err) {
    if (err.code === 'EMAIL_SUPRIMIDO') {
      await logEmail(msg.tipo, msg.to, 'suprimido', err.message);
      return 'suprimido';
    }
    logger.warn(`email: ${msg.tipo} → ${msg.to} no salió (${err.message}); queda en cola`);
    await encolarEmail({ ...msg, error: err.message });
    await logEmail(msg.tipo, msg.to, 'en_cola', err.message);
    return 'en_cola';
  }
};

// Deja constancia en el historial de la solicitud a la que pertenece el correo
const alTerminar = async (c, resultado, detalle = null) => {
  if (c.referencia_tipo !== 'pqrs' || !c.referencia_id) return;
  const etiqueta = c.tipo === 'pqrs_confirmacion' ? 'la confirmación' : 'la respuesta';
  const evento = {
    enviado:   ['correo_enviado', `Se envió ${etiqueta} por correo (estaba en cola)`],
    suprimido: ['correo_suprimido', `No se envió ${etiqueta}: el correo rebotó antes (lista de supresión)`],
    fallido:   ['correo_fallido', `No se pudo enviar ${etiqueta} tras ${MAX_INTENTOS} intentos${detalle ? `: ${detalle}` : ''}`],
  }[resultado];
  await pool.query(`INSERT INTO pqrs_eventos (pqrs_id, tipo, detalle) VALUES ($1, $2, $3)`, [c.referencia_id, evento[0], evento[1]]);
  if (resultado === 'fallido') {
    const { rows: [p] } = await pool.query('SELECT radicado FROM pqrs WHERE id = $1', [c.referencia_id]);
    await notificarPorPermiso('pqrs', {
      tipo: 'pqrs',
      mensaje: `No se pudo enviar ${etiqueta} de la solicitud ${p?.radicado ?? ''} tras varios intentos: comunícate con la persona por otro medio`,
    });
  }
};

const cerrar = (id, estado, error = null) => pool.query(
  `UPDATE email_cola SET estado = $2::varchar, html = NULL, texto = NULL, ultimo_error = $3, updated_at = NOW(),
                         enviado_at = CASE WHEN $2::varchar = 'enviado' THEN NOW() ELSE enviado_at END
   WHERE id = $1`, [id, estado, error]);

/**
 * Una pasada de la cola: envía lo que ya toca. Devuelve un resumen (útil para pruebas y para el log).
 * `ids` (opcional) limita la pasada a esos correos; lo usan las pruebas para no tocar otras filas de la base.
 */
export const procesarCola = async ({ limite = LOTE, ids = null } = {}) => {
  // Rescata envíos que quedaron "en curso" porque el proceso se cayó a la mitad
  await pool.query(
    `UPDATE email_cola SET estado = 'pendiente', updated_at = NOW()
      WHERE estado = 'enviando' AND updated_at < NOW() - make_interval(mins => $1) AND ($2::uuid[] IS NULL OR id = ANY($2))`,
    [ATASCADO_MIN, ids]);

  // Reclama el lote de una vez (SKIP LOCKED: si hay varias instancias no se envía el mismo correo dos veces)
  const { rows: lote } = await pool.query(
    `WITH vencidos AS (
       SELECT id FROM email_cola
        WHERE estado = 'pendiente' AND proximo_intento <= NOW() AND ($2::uuid[] IS NULL OR id = ANY($2))
        ORDER BY proximo_intento LIMIT $1 FOR UPDATE SKIP LOCKED)
     UPDATE email_cola c SET estado = 'enviando', intentos = c.intentos + 1, updated_at = NOW()
       FROM vencidos WHERE c.id = vencidos.id RETURNING c.*`, [limite, ids]);

  const r = { enviados: 0, reprogramados: 0, fallidos: 0, suprimidos: 0 };
  for (const c of lote) {
    try {
      await enviarEmail(c.destinatario, c.asunto, c.html ?? '', c.texto ?? '');
      await cerrar(c.id, 'enviado');
      await logEmail(c.tipo, c.destinatario, 'enviado');
      await alTerminar(c, 'enviado');
      r.enviados++;
    } catch (err) {
      if (err.code === 'EMAIL_SUPRIMIDO') {
        await cerrar(c.id, 'suprimido', err.message);
        await alTerminar(c, 'suprimido');
        r.suprimidos++;
      } else if (c.intentos >= MAX_INTENTOS) {
        await cerrar(c.id, 'fallido', err.message);
        await logEmail(c.tipo, c.destinatario, 'error', `Se agotaron los intentos: ${err.message}`);
        await alTerminar(c, 'fallido', err.message);
        r.fallidos++;
      } else {
        await pool.query(
          `UPDATE email_cola SET estado = 'pendiente', ultimo_error = $2, updated_at = NOW(),
                                 proximo_intento = NOW() + make_interval(mins => $3)
           WHERE id = $1`, [c.id, err.message, ESPERAS_MIN[c.intentos]]);
        r.reprogramados++;
      }
    }
  }
  return r;
};

// Borra lo que ya terminó hace tiempo (la fila queda solo como constancia mientras dura la retención)
export const depurarCola = () => pool.query(
  `DELETE FROM email_cola WHERE estado IN ('enviado', 'fallido', 'suprimido') AND updated_at < NOW() - make_interval(days => $1)`,
  [RETENCION_DIAS]);

// ── Proceso periódico ─────────────────────────────────────────────────────────
let timer = null;
let corriendo = false;
let pasadas = 0;

export const iniciarColaEmail = () => {
  if (timer || process.env.NODE_ENV === 'test') return;
  const pasada = async () => {
    if (corriendo) return;
    corriendo = true;
    try {
      const r = await procesarCola();
      if (r.enviados || r.fallidos || r.suprimidos) logger.info(`Cola de correos: ${JSON.stringify(r)}`);
      if (++pasadas % 60 === 0) await depurarCola();   // ~ cada hora
    } catch (err) {
      logger.error(`Cola de correos: ${err.message}`);
    } finally { corriendo = false; }
  };
  timer = setInterval(pasada, PASADA_MS);
  timer.unref?.();
  setTimeout(pasada, 15_000).unref?.();   // primera pasada poco después de arrancar: recoge lo que quedó pendiente
  logger.info('Cola de correos iniciada (una pasada por minuto)');
};

export const detenerColaEmail = () => { if (timer) { clearInterval(timer); timer = null; } };
