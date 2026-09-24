import pool from '../../src/db/database.js';
import { enviarEmail, emailsDePrueba, simulacionDePrueba } from '../../src/services/emailService.js';
import { enviarOEncolar, encolarEmail, procesarCola } from '../../src/services/emailColaService.js';

// Reply-To: la empresa responde el correo de autorización de un crédito y esa respuesta debe llegar al asesor, no a la dirección de envío.
const DESTINO = 'replyto-destino@ejemplo.test';
const ASESOR = 'asesor-replyto@cooperativa.test';
const ultimo = () => emailsDePrueba[emailsDePrueba.length - 1];
const yaToca = (id) => pool.query(`UPDATE email_cola SET proximo_intento = NOW() - INTERVAL '1 second' WHERE id = $1`, [id]);
const fila = async (id) => (await pool.query('SELECT * FROM email_cola WHERE id = $1', [id])).rows[0];
const msg = (extra = {}) => ({ tipo: 'prueba_replyto', to: DESTINO, asunto: 'Prueba', html: '<p>hola</p>', texto: 'hola', ...extra });

afterEach(() => { simulacionDePrueba.fallar = false; });
afterAll(async () => {
  await pool.query(`DELETE FROM email_cola WHERE tipo = 'prueba_replyto'`);
  await pool.query(`DELETE FROM email_logs WHERE tipo = 'prueba_replyto'`);
  await pool.end();
});

describe('Correo — Reply-To en el envío directo', () => {
  test('enviarEmail entrega el Reply-To indicado', async () => {
    await enviarEmail(DESTINO, 'Asunto', '<p>x</p>', 'x', { replyTo: ASESOR });
    expect(ultimo()).toMatchObject({ to: DESTINO, subject: 'Asunto', replyTo: ASESOR });
  });

  test('sin Reply-To, no se agrega ninguno (comportamiento anterior intacto)', async () => {
    await enviarEmail(DESTINO, 'Asunto', '<p>x</p>', 'x');
    expect(ultimo().replyTo).toBeNull();
    await enviarEmail(DESTINO, 'Asunto', '<p>x</p>');
    expect(ultimo().replyTo).toBeNull();
    await enviarEmail(DESTINO, 'Asunto', '<p>x</p>', 'x', {});
    expect(ultimo().replyTo).toBeNull();
  });

  test('enviarOEncolar lo pasa al canal de envío', async () => {
    expect(await enviarOEncolar(msg({ reply_to: ASESOR }))).toBe('enviado');
    expect(ultimo()).toMatchObject({ to: DESTINO, replyTo: ASESOR });
    expect(await enviarOEncolar(msg())).toBe('enviado');
    expect(ultimo().replyTo).toBeNull();
  });
});

describe('Correo — Reply-To cuando el correo pasa por la cola', () => {
  test('si el canal falla, el correo queda en cola CON su Reply-To y sale con él al reintentar', async () => {
    simulacionDePrueba.fallar = true;
    expect(await enviarOEncolar(msg({ reply_to: ASESOR }))).toBe('en_cola');
    const { rows: [encolado] } = await pool.query(`SELECT * FROM email_cola WHERE tipo = 'prueba_replyto' AND reply_to = $1 ORDER BY created_at DESC LIMIT 1`, [ASESOR]);
    expect(encolado).toMatchObject({ destinatario: DESTINO, reply_to: ASESOR, estado: 'pendiente' });

    simulacionDePrueba.fallar = false;
    await yaToca(encolado.id);
    const antes = emailsDePrueba.length;
    const r = await procesarCola({ ids: [encolado.id] });
    expect(r.enviados).toBe(1);
    expect(emailsDePrueba.slice(antes)).toEqual([expect.objectContaining({ to: DESTINO, replyTo: ASESOR })]);
    expect((await fila(encolado.id)).estado).toBe('enviado');
  });

  test('un correo encolado sin Reply-To lo guarda vacío y sale sin él', async () => {
    const id = await encolarEmail({ tipo: 'prueba_replyto', to: DESTINO, asunto: 'A', html: '<p>x</p>', texto: 'x' });
    expect((await fila(id)).reply_to).toBeNull();
    await yaToca(id);
    const antes = emailsDePrueba.length;
    expect((await procesarCola({ ids: [id] })).enviados).toBe(1);
    expect(emailsDePrueba[antes].replyTo).toBeNull();
  });

  test('encolarEmail guarda el Reply-To directamente', async () => {
    const id = await encolarEmail({ tipo: 'prueba_replyto', to: DESTINO, asunto: 'A', html: '<p>x</p>', reply_to: ASESOR });
    expect((await fila(id)).reply_to).toBe(ASESOR);
  });

  test('un fallo en el reintento conserva el Reply-To para el siguiente intento', async () => {
    const id = await encolarEmail({ tipo: 'prueba_replyto', to: DESTINO, asunto: 'A', html: '<p>x</p>', reply_to: ASESOR });
    await yaToca(id);
    simulacionDePrueba.fallar = true;
    const r = await procesarCola({ ids: [id] });
    expect(r.reprogramados).toBe(1);
    expect(await fila(id)).toMatchObject({ estado: 'pendiente', reply_to: ASESOR, intentos: 1 });
  });
});
