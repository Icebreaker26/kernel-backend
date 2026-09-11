import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';
import { jest } from '@jest/globals';

jest.setTimeout(30000);

let app;

const EMAIL = 'ci-umbrales-test@kernel.test';
const PASS  = 'testpass123';
let userUuid;
let umbralId;

const agente = () => request.agent(app);
const login  = (ag) => ag.post('/api/auth/login').send({ email: EMAIL, password: PASS });

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(PASS, 4);

  const { rows: [u] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('CI Umbrales Test', $1, $2, 'control_interno', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL, hash]
  );
  userUuid = u.id;

  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'control_interno'
     ON CONFLICT DO NOTHING`,
    [userUuid]
  );
});

afterAll(async () => {
  if (umbralId) {
    await pool.query('DELETE FROM tesoreria_config_umbrales WHERE id = $1', [umbralId]);
  }
  // Limpiar umbrales de test con tipo_operacion de prueba que pudieran quedar
  await pool.query(`DELETE FROM tesoreria_config_umbrales WHERE tipo_operacion LIKE 'ci_test_%'`);
  await pool.query('DELETE FROM permisos        WHERE usuario_uuid = $1', [userUuid]);
  await pool.query('DELETE FROM global_usuarios WHERE id = $1',           [userUuid]);
  await pool.end();
});

// ── Auth ───────────────────────────────────────────────────────────────────────
describe('Auth', () => {
  test('GET /control_interno/config/umbrales sin token → 401', async () => {
    expect(
      (await request(app).get('/api/control_interno/config/umbrales')).status
    ).toBe(401);
  });

  test('POST /control_interno/config/umbrales sin token → 401', async () => {
    expect(
      (await request(app).post('/api/control_interno/config/umbrales').send({})).status
    ).toBe(401);
  });

  test('PUT /control_interno/config/umbrales/:id sin token → 401', async () => {
    expect(
      (await request(app)
        .put('/api/control_interno/config/umbrales/00000000-0000-0000-0000-000000000000')
        .send({ dias_vencimiento: 5 })).status
    ).toBe(401);
  });
});

// ── GET /control_interno/config/umbrales ──────────────────────────────────────
describe('GET /control_interno/config/umbrales', () => {
  test('→ 200 array', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get('/api/control_interno/config/umbrales');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('cada umbral tiene tipo_operacion, monto_umbral y dias_vencimiento', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get('/api/control_interno/config/umbrales');
    expect(res.status).toBe(200);
    if (res.body.length > 0) {
      expect(res.body[0]).toHaveProperty('tipo_operacion');
      expect(res.body[0]).toHaveProperty('monto_umbral');
      expect(res.body[0]).toHaveProperty('dias_vencimiento');
    }
  });
});

// ── POST /control_interno/config/umbrales ─────────────────────────────────────
describe('POST /control_interno/config/umbrales — validaciones', () => {
  test('body vacío → 400', async () => {
    const ag = agente(); await login(ag);
    expect((await ag.post('/api/control_interno/config/umbrales').send({})).status).toBe(400);
  });

  test('monto_umbral = 0 → 400', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/control_interno/config/umbrales').send({
      tipo_operacion: 'ci_test_zero',
      monto_umbral: 0,
    });
    expect(res.status).toBe(400);
  });

  test('monto_umbral negativo → 400', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/control_interno/config/umbrales').send({
      tipo_operacion: 'ci_test_negative',
      monto_umbral: -1000,
    });
    expect(res.status).toBe(400);
  });

  test('sin tipo_operacion → 400', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/control_interno/config/umbrales').send({
      monto_umbral: 5000000,
    });
    expect(res.status).toBe(400);
  });

  test('dias_vencimiento < 1 → 400', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/control_interno/config/umbrales').send({
      tipo_operacion: 'ci_test_dias_invalidos',
      monto_umbral: 1000000,
      dias_vencimiento: 0,
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /control_interno/config/umbrales — CRUD', () => {
  test('→ 201 crea umbral desde módulo CI con dias_vencimiento por defecto', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/control_interno/config/umbrales').send({
      tipo_operacion: 'ci_test_verificacion',
      monto_umbral:   2000000,
      descripcion:    'Umbral CI test verificación',
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(Number(res.body.monto_umbral)).toBe(2000000);
    expect(res.body.tipo_operacion).toBe('ci_test_verificacion');
    expect(res.body.dias_vencimiento).toBe(7); // default
    expect(res.body.descripcion).toBe('Umbral CI test verificación');
    umbralId = res.body.id;
  });

  test('→ 201 crea umbral con dias_vencimiento personalizado', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/control_interno/config/umbrales').send({
      tipo_operacion:   'ci_test_dias_custom',
      monto_umbral:     500000,
      dias_vencimiento: 3,
    });
    expect(res.status).toBe(201);
    expect(res.body.dias_vencimiento).toBe(3);
    // Limpiar este umbral adicional
    await pool.query('DELETE FROM tesoreria_config_umbrales WHERE id = $1', [res.body.id]);
  });

  test('El umbral creado aparece en GET /control_interno/config/umbrales', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get('/api/control_interno/config/umbrales');
    expect(res.status).toBe(200);
    expect(res.body.some(u => u.id === umbralId)).toBe(true);
  });
});

// ── PUT /control_interno/config/umbrales/:id ──────────────────────────────────
describe('PUT /control_interno/config/umbrales/:id', () => {
  test('id inexistente → 404', async () => {
    const ag = agente(); await login(ag);
    const res = await ag
      .put('/api/control_interno/config/umbrales/00000000-0000-0000-0000-000000000000')
      .send({ dias_vencimiento: 10 });
    expect(res.status).toBe(404);
  });

  test('campo no permitido (strict) → 400', async () => {
    const ag = agente(); await login(ag);
    const res = await ag
      .put(`/api/control_interno/config/umbrales/${umbralId}`)
      .send({ tipo_operacion: 'hack' });
    expect(res.status).toBe(400);
  });

  test('body vacío (sin campos a actualizar) → 400', async () => {
    const ag = agente(); await login(ag);
    const res = await ag
      .put(`/api/control_interno/config/umbrales/${umbralId}`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('→ 200 actualiza dias_vencimiento', async () => {
    const ag = agente(); await login(ag);
    const res = await ag
      .put(`/api/control_interno/config/umbrales/${umbralId}`)
      .send({ dias_vencimiento: 10 });
    expect(res.status).toBe(200);
    expect(res.body.dias_vencimiento).toBe(10);
    expect(res.body.id).toBe(umbralId);
  });

  test('→ 200 actualiza monto_umbral', async () => {
    const ag = agente(); await login(ag);
    const res = await ag
      .put(`/api/control_interno/config/umbrales/${umbralId}`)
      .send({ monto_umbral: 3000000 });
    expect(res.status).toBe(200);
    expect(Number(res.body.monto_umbral)).toBe(3000000);
  });

  test('→ 200 actualiza descripcion', async () => {
    const ag = agente(); await login(ag);
    const res = await ag
      .put(`/api/control_interno/config/umbrales/${umbralId}`)
      .send({ descripcion: 'Umbral CI actualizado por test' });
    expect(res.status).toBe(200);
    expect(res.body.descripcion).toBe('Umbral CI actualizado por test');
  });

  test('→ 200 actualiza múltiples campos en una sola llamada', async () => {
    const ag = agente(); await login(ag);
    const res = await ag
      .put(`/api/control_interno/config/umbrales/${umbralId}`)
      .send({ monto_umbral: 2500000, dias_vencimiento: 5, descripcion: 'Umbral final test' });
    expect(res.status).toBe(200);
    expect(Number(res.body.monto_umbral)).toBe(2500000);
    expect(res.body.dias_vencimiento).toBe(5);
    expect(res.body.descripcion).toBe('Umbral final test');
  });
});
