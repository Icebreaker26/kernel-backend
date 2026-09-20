import pool from '../../src/db/database.js';
import { emailsDePrueba, simulacionDePrueba } from '../../src/services/emailService.js';
import {
  ESPERAS_MIN, MAX_INTENTOS, depurarCola, encolarEmail, enviarOEncolar, procesarCola,
} from '../../src/services/emailColaService.js';

const DEST = 'cola-test@ejemplo.test';
let n = 0;
const msg = (extra = {}) => ({ tipo: 'prueba_cola', to: DEST, asunto: `Asunto de cola ${Date.now()}-${++n}`, html: '<p>Código secreto ABC123</p>', texto: 'Código secreto ABC123', ...extra });
const fila = async (id) => (await pool.query('SELECT * FROM email_cola WHERE id = $1', [id])).rows[0];
const filaDe = async (asunto) => (await pool.query('SELECT * FROM email_cola WHERE asunto = $1', [asunto])).rows[0];
const yaToca = (id) => pool.query(`UPDATE email_cola SET proximo_intento = NOW() - INTERVAL '1 second' WHERE id = $1`, [id]);
const enviadosCon = (asunto) => emailsDePrueba.filter((e) => e.subject === asunto).length;
const conFallo = async (fn) => { simulacionDePrueba.fallar = true; try { return await fn(); } finally { simulacionDePrueba.fallar = false; } };

afterAll(async () => {
  simulacionDePrueba.fallar = false;
  await pool.query(`DELETE FROM email_cola WHERE destinatario = $1`, [DEST]);
  await pool.query(`DELETE FROM email_logs WHERE destinatario = $1`, [DEST]);
  await pool.query(`DELETE FROM email_supresiones WHERE lower(email) = $1`, [DEST]);
  await pool.end();
});

describe('Cola de correos — envío directo o en cola', () => {
  test('si hay canal, se envía en el momento y no queda nada en la cola', async () => {
    const m = msg();
    expect(await enviarOEncolar(m)).toBe('enviado');
    expect(enviadosCon(m.asunto)).toBe(1);
    expect(await filaDe(m.asunto)).toBeUndefined();
  });

  test('si no hay canal, el correo queda pendiente con su contenido y el primer reintento programado', async () => {
    const m = msg();
    expect(await conFallo(() => enviarOEncolar(m))).toBe('en_cola');
    expect(enviadosCon(m.asunto)).toBe(0);
    const f = await filaDe(m.asunto);
    expect(f).toMatchObject({ estado: 'pendiente', intentos: 0, destinatario: DEST, tipo: 'prueba_cola' });
    expect(f.html).toContain('ABC123');
    expect(f.ultimo_error).toMatch(/simulado/);
    const enMin = (new Date(f.proximo_intento) - Date.now()) / 60000;
    expect(enMin).toBeGreaterThan(ESPERAS_MIN[0] - 0.5);
    expect(enMin).toBeLessThan(ESPERAS_MIN[0] + 0.5);
    expect((await pool.query(`SELECT estado FROM email_logs WHERE destinatario = $1 AND tipo = 'prueba_cola' AND estado = 'en_cola'`, [DEST])).rowCount).toBeGreaterThan(0);
  });

  test('una dirección suprimida no se encola: es definitivo', async () => {
    await pool.query(`INSERT INTO email_supresiones (email, motivo) VALUES ($1, 'rebote') ON CONFLICT (lower(email)) DO UPDATE SET is_active = true`, [DEST]);
    const m = msg();
    expect(await enviarOEncolar(m)).toBe('suprimido');
    expect(await filaDe(m.asunto)).toBeUndefined();
    await pool.query(`DELETE FROM email_supresiones WHERE lower(email) = $1`, [DEST]);
  });
});

describe('Cola de correos — reintentos', () => {
  test('antes de que le toque, la pasada no lo envía ni lo toca', async () => {
    const m = msg();
    await conFallo(() => enviarOEncolar(m));
    const f = await filaDe(m.asunto);
    expect(await procesarCola({ ids: [f.id] })).toEqual({ enviados: 0, reprogramados: 0, fallidos: 0, suprimidos: 0 });
    expect((await fila(f.id)).intentos).toBe(0);
  });

  test('si sigue sin haber canal, se reprograma con una espera mayor y cuenta el intento', async () => {
    const m = msg();
    await conFallo(() => enviarOEncolar(m));
    const { id } = await filaDe(m.asunto);
    await yaToca(id);
    const r = await conFallo(() => procesarCola({ ids: [id] }));
    expect(r).toMatchObject({ reprogramados: 1, enviados: 0 });
    const f = await fila(id);
    expect(f).toMatchObject({ estado: 'pendiente', intentos: 1 });
    const enMin = (new Date(f.proximo_intento) - Date.now()) / 60000;
    expect(enMin).toBeGreaterThan(ESPERAS_MIN[1] - 0.5);
    expect(enMin).toBeLessThan(ESPERAS_MIN[1] + 0.5);
  });

  test('cuando vuelve el canal, sale solo, y se borra el contenido guardado (llevaba datos sensibles)', async () => {
    const m = msg();
    await conFallo(() => enviarOEncolar(m));
    const { id } = await filaDe(m.asunto);
    await yaToca(id);
    const r = await procesarCola({ ids: [id] });
    expect(r.enviados).toBe(1);
    expect(enviadosCon(m.asunto)).toBe(1);
    const f = await fila(id);
    expect(f).toMatchObject({ estado: 'enviado', html: null, texto: null });
    expect(f.enviado_at).toBeTruthy();
    // ya no se vuelve a enviar
    await yaToca(id);
    expect(await procesarCola({ ids: [id] })).toEqual({ enviados: 0, reprogramados: 0, fallidos: 0, suprimidos: 0 });
    expect(enviadosCon(m.asunto)).toBe(1);
  });

  test('al agotar los intentos queda como fallido, sin contenido, y deja constancia en el log', async () => {
    const m = msg();
    await conFallo(() => enviarOEncolar(m));
    const { id } = await filaDe(m.asunto);
    await pool.query(`UPDATE email_cola SET intentos = $2 WHERE id = $1`, [id, MAX_INTENTOS - 1]);
    await yaToca(id);
    const r = await conFallo(() => procesarCola({ ids: [id] }));
    expect(r.fallidos).toBe(1);
    expect(await fila(id)).toMatchObject({ estado: 'fallido', intentos: MAX_INTENTOS, html: null, texto: null });
    expect((await pool.query(`SELECT 1 FROM email_logs WHERE destinatario = $1 AND estado = 'error' AND error_msg LIKE 'Se agotaron los intentos%'`, [DEST])).rowCount).toBeGreaterThan(0);
  });

  test('si mientras esperaba la dirección quedó suprimida, se cierra como suprimido sin reintentar', async () => {
    const m = msg();
    await conFallo(() => enviarOEncolar(m));
    const { id } = await filaDe(m.asunto);
    await pool.query(`INSERT INTO email_supresiones (email, motivo) VALUES ($1, 'queja') ON CONFLICT (lower(email)) DO UPDATE SET is_active = true`, [DEST]);
    await yaToca(id);
    const r = await procesarCola({ ids: [id] });
    await pool.query(`DELETE FROM email_supresiones WHERE lower(email) = $1`, [DEST]);
    expect(r.suprimidos).toBe(1);
    expect(await fila(id)).toMatchObject({ estado: 'suprimido', html: null });
    expect(enviadosCon(m.asunto)).toBe(0);
  });

  test('un envío que se quedó "en curso" (proceso caído) se rescata y se envía', async () => {
    const id = await encolarEmail(msg());
    const { asunto } = await fila(id);
    await pool.query(`UPDATE email_cola SET estado = 'enviando', updated_at = NOW() - INTERVAL '30 minutes', proximo_intento = NOW() - INTERVAL '1 minute' WHERE id = $1`, [id]);
    const r = await procesarCola({ ids: [id] });
    expect(r.enviados).toBe(1);
    expect(enviadosCon(asunto)).toBe(1);
  });

  test('dos pasadas al mismo tiempo no envían el mismo correo dos veces', async () => {
    const id = await encolarEmail(msg());
    const { asunto } = await fila(id);
    await yaToca(id);
    const [a, b] = await Promise.all([procesarCola({ ids: [id] }), procesarCola({ ids: [id] })]);
    expect(a.enviados + b.enviados).toBe(1);
    expect(enviadosCon(asunto)).toBe(1);
  });
});

describe('Cola de correos — depuración', () => {
  test('borra lo terminado hace más de 30 días y conserva lo pendiente y lo reciente', async () => {
    const viejo = await encolarEmail(msg());
    const reciente = await encolarEmail(msg());
    const pendiente = await encolarEmail(msg());
    await pool.query(`UPDATE email_cola SET estado = 'enviado', updated_at = NOW() - INTERVAL '40 days' WHERE id = $1`, [viejo]);
    await pool.query(`UPDATE email_cola SET estado = 'enviado', updated_at = NOW() - INTERVAL '2 days' WHERE id = $1`, [reciente]);
    await pool.query(`UPDATE email_cola SET updated_at = NOW() - INTERVAL '90 days' WHERE id = $1`, [pendiente]);   // pendiente: no se toca aunque sea viejo
    await depurarCola();
    expect(await fila(viejo)).toBeUndefined();
    expect(await fila(reciente)).toBeDefined();
    expect(await fila(pendiente)).toBeDefined();
  });
});
