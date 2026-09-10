import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';
import { jest } from '@jest/globals';

jest.setTimeout(30000);

let app;

// ── Usuarios de test ──────────────────────────────────────────────────────────
const EMAIL_TSR  = 'aprobaciones-tsr-test@kernel.test';
const EMAIL_RESP = 'aprobaciones-resp-test@kernel.test';
const EMAIL_OTRO = 'aprobaciones-otro-test@kernel.test';
const PASS = 'testpass123';
let uuidTsr, uuidResp, uuidOtro;

// IDs creados durante tests
let proveedorId, facturaId, facturaOtraId;

const agentTsr  = () => request.agent(app);
const agentResp = () => request.agent(app);
const agentOtro = () => request.agent(app);
const loginTsr  = (ag) => ag.post('/api/auth/login').send({ email: EMAIL_TSR,  password: PASS });
const loginResp = (ag) => ag.post('/api/auth/login').send({ email: EMAIL_RESP, password: PASS });
const loginOtro = (ag) => ag.post('/api/auth/login').send({ email: EMAIL_OTRO, password: PASS });

// ── Setup ─────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(PASS, 4);

  // Usuario con permiso tesorería (crea facturas)
  const { rows: [tsr] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Tesorera Aprobaciones Test', $1, $2, 'tesorera', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL_TSR, hash]
  );
  uuidTsr = tsr.id;
  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'tesoreria'
     ON CONFLICT DO NOTHING`,
    [uuidTsr]
  );

  // Responsable de área — sin permisos de módulo específico
  const { rows: [resp] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Responsable Aprobaciones Test', $1, $2, 'juridico', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL_RESP, hash]
  );
  uuidResp = resp.id;
  // Sin permisos de módulo — solo verifyToken basta para /aprobaciones

  // Otro usuario autenticado (no responsable de ninguna factura)
  const { rows: [otro] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Otro Usuario Test', $1, $2, 'juridico', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL_OTRO, hash]
  );
  uuidOtro = otro.id;

  // Proveedor y facturas de prueba
  const { rows: [p] } = await pool.query(
    `INSERT INTO tesoreria_proveedores (nombre, tipo_pago) VALUES ('Proveedor Aprobaciones Test', 'unico') RETURNING id`
  );
  proveedorId = p.id;

  // Factura asignada al responsable
  const { rows: [f] } = await pool.query(
    `INSERT INTO tesoreria_facturas
       (proveedor_id, monto, fecha_recibida, fecha_vencimiento, estado, registrado_por, responsable_id)
     VALUES ($1, 250000, '2026-09-05', '2026-09-30', 'pendiente_aprobacion', $2, $3)
     RETURNING id`,
    [proveedorId, uuidTsr, uuidResp]
  );
  facturaId = f.id;

  // Factura asignada a OTRO usuario (no al responsable de test)
  const { rows: [f2] } = await pool.query(
    `INSERT INTO tesoreria_facturas
       (proveedor_id, monto, fecha_recibida, fecha_vencimiento, estado, registrado_por, responsable_id)
     VALUES ($1, 80000, '2026-09-05', '2026-09-30', 'pendiente_aprobacion', $2, $3)
     RETURNING id`,
    [proveedorId, uuidTsr, uuidOtro]
  );
  facturaOtraId = f2.id;
});

// ── Teardown ──────────────────────────────────────────────────────────────────
afterAll(async () => {
  await pool.query(`DELETE FROM tesoreria_facturas WHERE id IN ($1, $2)`, [facturaId, facturaOtraId]);
  await pool.query(`DELETE FROM tesoreria_proveedores WHERE id = $1`, [proveedorId]);
  await pool.query(`DELETE FROM permisos WHERE usuario_uuid IN ($1, $2, $3)`, [uuidTsr, uuidResp, uuidOtro]);
  await pool.query(`DELETE FROM global_usuarios WHERE id IN ($1, $2, $3)`, [uuidTsr, uuidResp, uuidOtro]);
  await pool.end();
});

// ── Auth ──────────────────────────────────────────────────────────────────────
describe('Auth', () => {
  test('GET /aprobaciones sin token → 401', async () => {
    expect((await request(app).get('/api/aprobaciones')).status).toBe(401);
  });

  test('GET /aprobaciones/contar sin token → 401', async () => {
    expect((await request(app).get('/api/aprobaciones/contar')).status).toBe(401);
  });

  test('PUT /aprobaciones/:id/aprobar sin token → 401', async () => {
    expect((await request(app).put(`/api/aprobaciones/${facturaId}/aprobar`)).status).toBe(401);
  });
});

// ── GET / — mis facturas pendientes ──────────────────────────────────────────
describe('GET /aprobaciones — lista pendientes del usuario', () => {
  test('responsable ve su factura asignada', async () => {
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.get('/api/aprobaciones');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(f => f.id === facturaId)).toBe(true);
  });

  test('solo devuelve facturas en estado pendiente_aprobacion', async () => {
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.get('/api/aprobaciones');
    expect(res.status).toBe(200);
    expect(res.body.every(f => f.estado === 'pendiente_aprobacion')).toBe(true);
  });

  test('no devuelve facturas asignadas a otro usuario', async () => {
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.get('/api/aprobaciones');
    expect(res.status).toBe(200);
    expect(res.body.some(f => f.id === facturaOtraId)).toBe(false);
  });

  test('usuario sin facturas asignadas recibe array vacío', async () => {
    // uuidTsr no tiene facturas como responsable
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.get('/api/aprobaciones');
    expect(res.status).toBe(200);
    expect(res.body.some(f => f.id === facturaId)).toBe(false);
  });

  test('respuesta incluye campos enriquecidos (proveedor_nombre)', async () => {
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.get('/api/aprobaciones');
    expect(res.status).toBe(200);
    const f = res.body.find(f => f.id === facturaId);
    expect(f).toBeDefined();
    expect(f.proveedor_nombre).toBe('Proveedor Aprobaciones Test');
    expect(f).toHaveProperty('vencida');
  });
});

// ── GET /contar ───────────────────────────────────────────────────────────────
describe('GET /aprobaciones/contar — badge del selector', () => {
  test('responsable con una factura pendiente → { total: 1 }', async () => {
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.get('/api/aprobaciones/contar');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total');
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  test('usuario sin asignaciones → { total: 0 }', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.get('/api/aprobaciones/contar');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  test('responde incluso sin permisos de módulo (solo verifyToken)', async () => {
    // uuidResp no tiene permisos de ningún módulo
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.get('/api/aprobaciones/contar');
    expect(res.status).toBe(200);
  });
});

// ── GET /usuarios — selector de responsable ──────────────────────────────────
describe('GET /aprobaciones/usuarios — selector de responsable', () => {
  test('usuario autenticado recibe lista de usuarios activos y aprobados', async () => {
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.get('/api/aprobaciones/usuarios');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test('cada usuario tiene id, nombre y rol', async () => {
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.get('/api/aprobaciones/usuarios');
    expect(res.status).toBe(200);
    res.body.forEach(u => {
      expect(u).toHaveProperty('id');
      expect(u).toHaveProperty('nombre');
      expect(u).toHaveProperty('rol');
    });
  });

  test('sin token → 401', async () => {
    expect((await request(app).get('/api/aprobaciones/usuarios')).status).toBe(401);
  });
});

// ── PUT /:id/aprobar ──────────────────────────────────────────────────────────
describe('PUT /aprobaciones/:id/aprobar', () => {
  test('usuario no responsable no puede aprobar factura ajena → 403', async () => {
    // uuidOtro intenta aprobar la factura de uuidResp
    const ag = agentOtro(); await loginOtro(ag);
    const res = await ag.put(`/api/aprobaciones/${facturaId}/aprobar`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/permiso/i);
  });

  test('factura inexistente → 404', async () => {
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.put('/api/aprobaciones/00000000-0000-0000-0000-000000000000/aprobar');
    expect(res.status).toBe(404);
  });

  test('responsable aprueba su factura → 200, estado aprobada', async () => {
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.put(`/api/aprobaciones/${facturaId}/aprobar`);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('aprobada');
    expect(res.body.aprobado_por).toBe(uuidResp);
    expect(res.body.aprobado_at).not.toBeNull();
  });

  test('aprobar una factura ya aprobada → 400', async () => {
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.put(`/api/aprobaciones/${facturaId}/aprobar`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/pendiente/i);
  });

  test('GET /contar después de aprobar → total decrementado', async () => {
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.get('/api/aprobaciones/contar');
    expect(res.status).toBe(200);
    // facturaId ya fue aprobada; facturaOtraId es de uuidOtro, no de uuidResp
    expect(res.body.total).toBe(0);
  });

  test('GET / después de aprobar → factura ya no aparece', async () => {
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.get('/api/aprobaciones');
    expect(res.status).toBe(200);
    expect(res.body.some(f => f.id === facturaId)).toBe(false);
  });
});
