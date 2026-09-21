import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';
import { tick } from '../../src/services/mailingDispatcher.js';
import { emailsDePrueba } from '../../src/services/emailService.js';

let app;
const EMAIL_ADMIN = 'mailing-contactos-test@kernel.test';
const PASS        = 'testpass123';
const JORNADA     = 'Jornada test contactos';
const ASOC_CODIGO = '9999995678';
const ASOC_EMAIL  = 'ya-asociado@kernel.test';
const BAJA_EMAIL  = 'baja-contacto@kernel.test';
const OK_EMAIL    = 'prospecto-ok@kernel.test';
let adminUuid, campanaId;

const login = async () => { const ag = request.agent(app); await ag.post('/api/auth/login').send({ email: EMAIL_ADMIN, password: PASS }); return ag; };
const valido = (extra = {}) => ({ nombre: 'Prospecto Uno', email: OK_EMAIL, jornada: JORNADA, autorizacion_datos: true, ...extra });

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(PASS, 4);
  const { rows: [u] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Contactos Test', $1, $2, 'admin', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true RETURNING id`,
    [EMAIL_ADMIN, hash]
  );
  adminUuid = u.id;
  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'mailing' ON CONFLICT DO NOTHING`, [adminUuid]
  );
  await pool.query(
    `INSERT INTO asociados (codigo, nombre, apellido, empresa_dsto, nombre_empresa, email, is_active)
     VALUES ($1, 'Ya', 'Asociado', 'EMP_TEST', 'Empresa Test', $2, true)
     ON CONFLICT (codigo) DO UPDATE SET email = EXCLUDED.email, is_active = true`, [ASOC_CODIGO, ASOC_EMAIL]
  );
  await pool.query(`INSERT INTO email_bajas (email) VALUES ($1) ON CONFLICT DO NOTHING`, [BAJA_EMAIL]);
});

afterAll(async () => {
  if (campanaId) {
    await pool.query('DELETE FROM cola_mailing WHERE campana_id = $1', [campanaId]);
    await pool.query('DELETE FROM campanas WHERE id = $1', [campanaId]);
  }
  await pool.query('DELETE FROM email_logs WHERE destinatario = ANY($1)', [[OK_EMAIL, BAJA_EMAIL]]);
  await pool.query('DELETE FROM mailing_contactos WHERE jornada = $1', [JORNADA]);
  await pool.query('DELETE FROM email_bajas WHERE email = $1', [BAJA_EMAIL]);
  await pool.query('DELETE FROM asociados WHERE codigo = $1', [ASOC_CODIGO]);
  await pool.query('DELETE FROM permisos WHERE usuario_uuid = $1', [adminUuid]);
  await pool.query('DELETE FROM global_usuarios WHERE id = $1', [adminUuid]);
  await pool.end();
});

describe('Contactos — auth y validación', () => {
  test('sin token → 401', async () => {
    expect((await request(app).get('/api/mailing/contactos')).status).toBe(401);
    expect((await request(app).post('/api/mailing/contactos').send(valido())).status).toBe(401);
  });

  test('sin autorización de datos → 400', async () => {
    const ag = await login();
    expect((await ag.post('/api/mailing/contactos').send(valido({ autorizacion_datos: false }))).status).toBe(400);
    expect((await ag.post('/api/mailing/contactos').send({ nombre: 'X', email: OK_EMAIL, jornada: JORNADA })).status).toBe(400);
  });

  test('correo inválido → 400', async () => {
    const ag = await login();
    expect((await ag.post('/api/mailing/contactos').send(valido({ email: 'no-es-correo' }))).status).toBe(400);
  });

  test('correo de un asociado → 409', async () => {
    const ag = await login();
    expect((await ag.post('/api/mailing/contactos').send(valido({ email: ASOC_EMAIL }))).status).toBe(409);
  });
});

describe('Contactos — CRUD', () => {
  test('POST crea y repetir el mismo correo en la jornada no duplica', async () => {
    const ag = await login();
    const r1 = await ag.post('/api/mailing/contactos').send(valido({ email: 'Prospecto-OK@kernel.test' }));
    expect(r1.status).toBe(201);
    expect(r1.body.email).toBe(OK_EMAIL);
    const r2 = await ag.post('/api/mailing/contactos').send(valido());
    expect(r2.status).toBe(201);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM mailing_contactos WHERE jornada = $1 AND is_active', [JORNADA]);
    expect(rows[0].n).toBe(1);
  });

  test('un contacto que se dio de baja se puede registrar (se filtra al enviar)', async () => {
    const ag = await login();
    expect((await ag.post('/api/mailing/contactos').send(valido({ nombre: 'Baja', email: BAJA_EMAIL }))).status).toBe(201);
  });

  test('GET lista por jornada y GET /jornadas agrupa', async () => {
    const ag = await login();
    const l = await ag.get('/api/mailing/contactos').query({ jornada: JORNADA });
    expect(l.status).toBe(200);
    expect(l.body.length).toBe(2);
    const j = await ag.get('/api/mailing/jornadas');
    expect(j.body.find(x => x.jornada === JORNADA)?.contactos).toBe(2);
  });
});

describe('Campaña para contactos', () => {
  test('crear con marcadores [COMPLETAR] → se crea pero no se puede enviar (409)', async () => {
    const ag = await login();
    const c = await ag.post('/api/mailing').send({
      asunto: '[COMPLETAR] asunto', cuerpo_html: '<p>[COMPLETAR]</p>', audiencia: 'contactos', segmento: { jornadas: [JORNADA] },
    });
    expect(c.status).toBe(201);
    expect(c.body.audiencia).toBe('contactos');
    expect((await ag.post(`/api/mailing/${c.body.id}/enviar`)).status).toBe(409);
    await pool.query('DELETE FROM campanas WHERE id = $1', [c.body.id]);
  });

  test('enviar encola solo contactos válidos (sin baja ni asociados) y el dispatcher los envía sin botón del portal', async () => {
    const ag = await login();
    const c = await ag.post('/api/mailing').send({
      asunto: 'Info jornada', cuerpo_html: '<p>Hola, gracias por visitarnos.</p>', audiencia: 'contactos', segmento: { jornadas: [JORNADA] },
    });
    campanaId = c.body.id;

    const env = await ag.post(`/api/mailing/${campanaId}/enviar`);
    expect(env.status).toBe(200);
    expect(env.body.destinatarios).toBe(1);

    const { rows } = await pool.query('SELECT email, asociado_codigo, contacto_id FROM cola_mailing WHERE campana_id = $1', [campanaId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe(OK_EMAIL);
    expect(rows[0].asociado_codigo).toBeNull();
    expect(rows[0].contacto_id).not.toBeNull();

    emailsDePrueba.length = 0;
    await tick();
    const enviado = emailsDePrueba.find(e => e.to === OK_EMAIL);
    expect(enviado).toBeDefined();
    expect(enviado.html).not.toContain('IR AL PORTAL');
    expect(enviado.html).toContain('dejaste tus datos');
    expect(enviado.html).toContain('/baja/');

    const { rows: [camp] } = await pool.query('SELECT estado, enviados FROM campanas WHERE id = $1', [campanaId]);
    expect(camp).toMatchObject({ estado: 'enviada', enviados: 1 });
  });

  test('audiencia asociados sigue sin tocar a los contactos', async () => {
    const { rows } = await pool.query(
      `SELECT 1 FROM asociados WHERE is_active AND email = ANY($1)`, [[OK_EMAIL, BAJA_EMAIL]]
    );
    expect(rows).toHaveLength(0);
  });
});

describe('Contactos — borrado lógico', () => {
  test('DELETE marca is_active=false', async () => {
    const ag = await login();
    const { rows: [c] } = await pool.query('SELECT id FROM mailing_contactos WHERE email = $1 AND jornada = $2', [BAJA_EMAIL, JORNADA]);
    expect((await ag.delete(`/api/mailing/contactos/${c.id}`)).status).toBe(200);
    const { rows: [after] } = await pool.query('SELECT is_active FROM mailing_contactos WHERE id = $1', [c.id]);
    expect(after.is_active).toBe(false);
  });
});
