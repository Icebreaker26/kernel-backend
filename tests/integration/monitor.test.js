import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';

let app;
const adminEmail = 'monitor-admin@kernel.test';
const adminPass  = 'testpass123';
let adminUuid;

const agent      = () => request.agent(app);
const loginAdmin = (ag) => ag.post('/api/auth/login').send({ email: adminEmail, password: adminPass });

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(adminPass, 4);

  const { rows: [admin] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Monitor Admin', $1, $2, 'admin', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [adminEmail, hash]
  );
  adminUuid = admin.id;
});

afterAll(async () => {
  await pool.query('DELETE FROM global_usuarios WHERE id = $1', [adminUuid]);
  await pool.end();
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('Monitor — Auth', () => {
  test('GET /api/monitor/metricas sin token → 401', async () => {
    const res = await request(app).get('/api/monitor/metricas');
    expect(res.status).toBe(401);
  });

  test('GET /api/monitor/ingresos sin token → 401', async () => {
    const res = await request(app).get('/api/monitor/ingresos');
    expect(res.status).toBe(401);
  });

  test('GET /api/monitor/emails sin token → 401', async () => {
    const res = await request(app).get('/api/monitor/emails');
    expect(res.status).toBe(401);
  });

  test('Cookie de asociado (token_asociado) no da acceso a endpoints de staff → 401', async () => {
    // verifyToken lee solo la cookie "token" (staff). La cookie "token_asociado"
    // del portal es ignorada, por lo que el endpoint devuelve 401, no 403.
    const hash = await bcrypt.hash('pass1234', 4);
    await pool.query(
      `INSERT INTO asociados (codigo, apellido, nombre, portal_activo, primer_login, password_hash)
       VALUES ('MON_TEST_ASC', 'Mon', 'Test', true, false, $1)
       ON CONFLICT (codigo) DO UPDATE SET password_hash = $1`,
      [hash]
    );
    const ag = agent();
    await ag.post('/api/asociados/login').send({ codigo: 'MON_TEST_ASC', password: 'pass1234' });

    const res = await ag.get('/api/monitor/metricas');
    expect(res.status).toBe(401);

    await pool.query('DELETE FROM asociados WHERE codigo = $1', ['MON_TEST_ASC']);
  });
});

// ── Métricas ──────────────────────────────────────────────────────────────────

describe('Monitor — GET /metricas', () => {
  test('Retorna estructura correcta', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/monitor/metricas');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total_activos');
    expect(res.body).toHaveProperty('activaciones_hoy');
    expect(res.body).toHaveProperty('activaciones_semana');
    expect(res.body).toHaveProperty('emails_enviados');
    expect(res.body).toHaveProperty('emails_error');
    expect(res.body).toHaveProperty('por_dia');
    expect(Array.isArray(res.body.por_dia)).toBe(true);
  });

  test('total_activos refleja los asociados con portal_activo=true', async () => {
    const ag = agent();
    await loginAdmin(ag);

    const { rows: [{ count: antes }] } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM asociados WHERE portal_activo = true AND is_active = true`
    );

    const res = await ag.get('/api/monitor/metricas');
    expect(res.body.total_activos).toBe(Number(antes));
  });

  test('emails_enviados + emails_error son numéricos no negativos', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/monitor/metricas');

    expect(typeof res.body.emails_enviados).toBe('number');
    expect(typeof res.body.emails_error).toBe('number');
    expect(res.body.emails_enviados).toBeGreaterThanOrEqual(0);
    expect(res.body.emails_error).toBeGreaterThanOrEqual(0);
  });
});

// ── Ingresos ──────────────────────────────────────────────────────────────────

describe('Monitor — GET /ingresos', () => {
  test('Retorna array', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/monitor/ingresos');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('Cada fila tiene los campos esperados', async () => {
    // Insertar asociado con portal activo para garantizar al menos una fila
    const hash = await bcrypt.hash('pass1234', 4);
    await pool.query(
      `INSERT INTO asociados (codigo, apellido, nombre, portal_activo, primer_login, password_hash, portal_activado_at)
       VALUES ('MON_ING_01', 'Mon', 'Ing', true, false, $1, NOW())
       ON CONFLICT (codigo) DO UPDATE SET portal_activo = true, portal_activado_at = NOW()`,
      [hash]
    );

    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/monitor/ingresos');

    expect(res.status).toBe(200);
    const fila = res.body.find((r) => r.codigo === 'MON_ING_01');
    expect(fila).toBeDefined();
    expect(fila).toHaveProperty('codigo');
    expect(fila).toHaveProperty('primer_login');

    await pool.query('DELETE FROM asociados WHERE codigo = $1', ['MON_ING_01']);
  });
});

// ── Emails ────────────────────────────────────────────────────────────────────

describe('Monitor — GET /emails', () => {
  test('Retorna array', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/monitor/emails');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('Insertar en email_logs y verificar que aparece en el endpoint', async () => {
    await pool.query(
      `INSERT INTO email_logs (tipo, destinatario, asociado_codigo, estado)
       VALUES ('test_monitor', 'monitor-test@kernel.test', 'MON001', 'enviado')`
    );

    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/monitor/emails');

    expect(res.status).toBe(200);
    const entrada = res.body.find((r) => r.destinatario === 'monitor-test@kernel.test');
    expect(entrada).toBeDefined();
    expect(entrada.tipo).toBe('test_monitor');
    expect(entrada.estado).toBe('enviado');
    expect(entrada).toHaveProperty('created_at');

    await pool.query(`DELETE FROM email_logs WHERE destinatario = 'monitor-test@kernel.test'`);
  });
});
