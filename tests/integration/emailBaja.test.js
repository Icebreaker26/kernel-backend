import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import { crearTokenBaja, leerTokenBaja } from '../../src/services/emailBajaService.js';
import { tick } from '../../src/services/mailingDispatcher.js';
import { emailsDePrueba } from '../../src/services/emailService.js';

let app;
const adminEmail = 'baja-test@icebreaker.com';
const pass = 'testpass123';
let adminUuid;
let campanaId;

const A = { codigo: '9999995001', email: 'baja-a@kernel.test' };   // se dará de baja
const B = { codigo: '9999995002', email: 'baja-b@kernel.test' };   // sigue recibiendo

const baja = (email) => `/api/email/baja/${crearTokenBaja(email)}`;

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  const { rows: [u] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Baja Test', $1, $2, 'admin', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true RETURNING id`,
    [adminEmail, hash]
  );
  adminUuid = u.id;
  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'mailing' ON CONFLICT DO NOTHING`, [adminUuid]
  );
  for (const x of [A, B]) {
    await pool.query(
      `INSERT INTO asociados (codigo, nombre, apellido, empresa_dsto, nombre_empresa, email, is_active)
       VALUES ($1, 'Baja', 'Test', 'EMP_TEST', 'Empresa Test', $2, true)
       ON CONFLICT (codigo) DO UPDATE SET email = EXCLUDED.email, is_active = true`, [x.codigo, x.email]
    );
  }
});

afterAll(async () => {
  if (campanaId) {
    await pool.query('DELETE FROM cola_mailing WHERE campana_id = $1', [campanaId]);
    await pool.query('DELETE FROM campanas WHERE id = $1', [campanaId]);
  }
  await pool.query('DELETE FROM email_bajas WHERE lower(email) = ANY($1)', [[A.email, B.email]]);
  await pool.query('DELETE FROM email_logs WHERE destinatario = ANY($1)', [[A.email, B.email]]);
  await pool.query('DELETE FROM asociados WHERE codigo = ANY($1)', [[A.codigo, B.codigo]]);
  await pool.query('DELETE FROM permisos WHERE usuario_uuid = $1', [adminUuid]);
  await pool.query('DELETE FROM global_usuarios WHERE id = $1', [adminUuid]);
  await pool.end();
});

describe('Baja de avisos — token', () => {
  test('el token devuelve el correo (normalizado a minúsculas) y detecta alteraciones', () => {
    const token = crearTokenBaja('Persona@Ejemplo.CO');
    expect(leerTokenBaja(token)).toBe('persona@ejemplo.co');

    const [cuerpo, firma] = token.split('.');
    const otro = Buffer.from('otra@ejemplo.co').toString('base64url');
    expect(leerTokenBaja(`${otro}.${firma}`)).toBeNull();          // correo cambiado, firma vieja
    expect(leerTokenBaja(`${cuerpo}.${firma.slice(0, -2)}xx`)).toBeNull(); // firma alterada
    expect(leerTokenBaja('basura')).toBeNull();
    expect(leerTokenBaja('')).toBeNull();
  });
});

describe('Baja de avisos — endpoints públicos', () => {
  test('GET solo consulta (no da de baja) y no expone el correo completo', async () => {
    const res = await request(app).get(baja(A.email));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ correo: 'ba****@kernel.test', de_baja: false });
    expect((await pool.query('SELECT 1 FROM email_bajas WHERE lower(email) = $1', [A.email])).rowCount).toBe(0);
  });

  test('enlace alterado → 404 en los tres endpoints', async () => {
    for (const [metodo, ruta] of [['get', '/api/email/baja/xxx.yyy'], ['post', '/api/email/baja/xxx.yyy'], ['post', '/api/email/baja/xxx.yyy/reactivar']]) {
      expect((await request(app)[metodo](ruta)).status).toBe(404);
    }
  });

  test('POST da de baja, es idempotente y GET lo refleja', async () => {
    const ruta = baja(A.email);
    expect((await request(app).post(ruta)).body).toMatchObject({ ok: true, de_baja: true });
    expect((await request(app).post(ruta)).status).toBe(200);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM email_bajas WHERE lower(email) = $1', [A.email])).rows[0].n).toBe(1);
    expect((await request(app).get(ruta)).body.de_baja).toBe(true);
  });

  test('reactivar vuelve a suscribir', async () => {
    const ruta = baja(A.email);
    expect((await request(app).post(`${ruta}/reactivar`)).body).toMatchObject({ ok: true, de_baja: false });
    expect((await request(app).get(ruta)).body.de_baja).toBe(false);
    await request(app).post(ruta); // deja la baja activa para lo que sigue
  });
});

describe('Baja de avisos — campañas', () => {
  const ag = () => request.agent(app);

  test('la vista previa no cuenta a quien se dio de baja', async () => {
    const a = ag();
    await a.post('/api/auth/login').send({ email: adminEmail, password: pass });
    const crear = await a.post('/api/mailing').send({
      asunto: 'Aviso de prueba baja', cuerpo_html: '<p>Hola</p>', cuerpo_texto: 'Hola',
      segmento: { empresas: [], sorteos: [], codigos: [A.codigo, B.codigo] },
    });
    expect(crear.status).toBe(201);
    campanaId = crear.body.id;

    const prev = await a.get(`/api/mailing/${campanaId}/preview`);
    expect(Number(prev.body.destinatarios_count)).toBe(1); // solo B: A está de baja
  });

  test('una baja posterior al encolado se omite sin contar como error; los demás reciben el enlace personal', async () => {
    // Estado de partida: A recibía avisos, se encola a ambos y luego A se da de baja
    await pool.query('UPDATE email_bajas SET is_active = false WHERE lower(email) = $1', [A.email]);
    const a = ag();
    await a.post('/api/auth/login').send({ email: adminEmail, password: pass });
    const env = await a.post(`/api/mailing/${campanaId}/enviar`);
    expect(env.status).toBe(200);
    expect(env.body.destinatarios).toBe(2);

    await request(app).post(baja(A.email));
    const antes = emailsDePrueba.length;
    await tick();

    const { rows } = await pool.query('SELECT email, estado, error_msg FROM cola_mailing WHERE campana_id = $1 ORDER BY email', [campanaId]);
    expect(rows).toEqual([
      { email: A.email, estado: 'omitido', error_msg: 'Baja voluntaria' },
      { email: B.email, estado: 'enviado', error_msg: null },
    ]);

    // Solo se envió a B, con el enlace de baja firmado para B en el pie
    expect(emailsDePrueba.length).toBe(antes + 1);
    const correo = emailsDePrueba.at(-1);
    expect(correo.to).toBe(B.email);
    const token = /\/baja\/([\w-]+\.[\w-]+)"/.exec(correo.html)[1];
    expect(leerTokenBaja(token)).toBe(B.email);
    expect(correo.html).toContain('deja de recibirlos');

    const { rows: [camp] } = await pool.query('SELECT estado, enviados, errores FROM campanas WHERE id = $1', [campanaId]);
    expect(camp).toMatchObject({ estado: 'enviada', enviados: 1, errores: 0 });
  });
});
