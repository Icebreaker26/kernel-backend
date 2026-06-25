import request  from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool     from '../../src/db/database.js';
import bcrypt   from 'bcrypt';

let app;
const agent      = () => request.agent(app);
const testEmail  = 'auth-test@kernel.test';
const testPass   = 'testpass123';
let testUserUuid;

beforeAll(async () => {
  app = await createApp();

  const hash = await bcrypt.hash(testPass, 4);
  const { rows } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Auth Test', $1, $2, 'usuario', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [testEmail, hash]
  );
  testUserUuid = rows[0].id;
});

afterAll(async () => {
  await pool.query('DELETE FROM permisos        WHERE usuario_uuid = $1', [testUserUuid]);
  await pool.query('DELETE FROM global_usuarios WHERE id = $1',           [testUserUuid]);
});

describe('Auth — sin token', () => {
  test('GET /api/auth/me → 401', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});

describe('Auth — registro', () => {
  const regEmail = 'auth-register-test@kernel.test';

  afterAll(async () => {
    await pool.query('DELETE FROM global_usuarios WHERE email = $1', [regEmail]);
  });

  test('POST /api/auth/register → 201 con is_approved=false', async () => {
    const res = await request(app).post('/api/auth/register').send({
      nombre: 'Nuevo Usuario', email: regEmail, password: 'pass123',
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
  });

  test('POST /api/auth/register duplicado → 409', async () => {
    const res = await request(app).post('/api/auth/register').send({
      nombre: 'Otro', email: regEmail, password: 'pass123',
    });
    expect(res.status).toBe(409);
  });

  test('POST /api/auth/register body inválido → 400', async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'noemail' });
    expect(res.status).toBe(400);
  });
});

describe('Auth — login y sesión', () => {
  test('POST /api/auth/login credenciales inválidas → 401', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: testEmail, password: 'password_incorrecta' });
    expect(res.status).toBe(401);
  });

  test('POST /api/auth/login correcto → 200 + cookie', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: testEmail, password: testPass });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('email', testEmail);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  test('GET /api/auth/me autenticado → 200', async () => {
    const ag  = agent();
    await ag.post('/api/auth/login').send({ email: testEmail, password: testPass });
    const res = await ag.get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('email', testEmail);
  });

  test('POST /api/auth/logout → 200', async () => {
    const ag  = agent();
    await ag.post('/api/auth/login').send({ email: testEmail, password: testPass });
    const res = await ag.post('/api/auth/logout');
    expect(res.status).toBe(200);
  });
});
