import request  from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool     from '../../src/db/database.js';
import bcrypt   from 'bcrypt';

let app;
const testEmail = 'perfil-test@kernel.test';
const testPass  = 'testpass123';
let testUuid;

const agent    = () => request.agent(app);
const login    = (ag) => ag.post('/api/auth/login').send({ email: testEmail, password: testPass });

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(testPass, 4);
  const { rows } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Perfil Test', $1, $2, 'usuario', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [testEmail, hash]
  );
  testUuid = rows[0].id;
});

afterAll(async () => {
  await pool.query('DELETE FROM global_usuarios WHERE id = $1', [testUuid]);
});

describe('Perfil — sin token', () => {
  test('GET /api/perfil → 401', async () => {
    const res = await request(app).get('/api/perfil');
    expect(res.status).toBe(401);
  });
});

describe('Perfil — datos', () => {
  test('GET /api/perfil → 200 con datos del usuario', async () => {
    const ag  = agent();
    await login(ag);
    const res = await ag.get('/api/perfil');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('email', testEmail);
    expect(res.body).toHaveProperty('nombre');
    expect(res.body).not.toHaveProperty('password_hash');
  });

  test('PUT /api/perfil → 200 actualiza nombre', async () => {
    const ag  = agent();
    await login(ag);
    const res = await ag.put('/api/perfil').send({ nombre: 'Nombre Nuevo', email: testEmail });
    expect(res.status).toBe(200);
    expect(res.body.nombre).toBe('Nombre Nuevo');
  });

  test('PUT /api/perfil email duplicado → 409', async () => {
    const ag  = agent();
    await login(ag);
    const res = await ag.put('/api/perfil').send({ nombre: 'Test', email: 'alejandro.torres0826@gmail.com' });
    expect(res.status).toBe(409);
  });

  test('PUT /api/perfil body inválido → 400', async () => {
    const ag  = agent();
    await login(ag);
    const res = await ag.put('/api/perfil').send({ nombre: '' });
    expect(res.status).toBe(400);
  });
});

describe('Perfil — contraseña', () => {
  test('PUT /api/perfil/password contraseña actual incorrecta → 401', async () => {
    const ag  = agent();
    await login(ag);
    const res = await ag.put('/api/perfil/password').send({
      password_actual: 'incorrecta_pass',
      password_nueva:  'nuevapass123',
    });
    expect(res.status).toBe(401);
  });

  test('PUT /api/perfil/password → 200 cambia correctamente', async () => {
    const ag  = agent();
    await login(ag);
    const res = await ag.put('/api/perfil/password').send({
      password_actual: testPass,
      password_nueva:  'nuevapass123',
    });
    expect(res.status).toBe(200);

    // Restaurar contraseña original
    const hash = await bcrypt.hash(testPass, 4);
    await pool.query('UPDATE global_usuarios SET password_hash = $1 WHERE id = $2', [hash, testUuid]);
  });

  test('PUT /api/perfil/password body inválido → 400', async () => {
    const ag  = agent();
    await login(ag);
    const res = await ag.put('/api/perfil/password').send({ password_actual: 'abc' });
    expect(res.status).toBe(400);
  });
});
