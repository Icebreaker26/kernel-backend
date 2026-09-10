import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';
import { jest } from '@jest/globals';

jest.setTimeout(30000);

let app;

// ── Usuarios de test ──────────────────────────────────────────────────────────
const EMAIL_CTB  = 'datos-bancarios-ctb-test@kernel.test';
const EMAIL_CI   = 'datos-bancarios-ci-test@kernel.test';
const EMAIL_OTRO = 'datos-bancarios-otro-test@kernel.test';
const PASS = 'testpass123';
let uuidCtb, uuidCi, uuidOtro;

// Recursos
let proveedorId;
let solicitudId;

const agCtb  = () => request.agent(app);
const agCi   = () => request.agent(app);
const agOtro = () => request.agent(app);
const loginCtb  = (ag) => ag.post('/api/auth/login').send({ email: EMAIL_CTB,  password: PASS });
const loginCi   = (ag) => ag.post('/api/auth/login').send({ email: EMAIL_CI,   password: PASS });
const loginOtro = (ag) => ag.post('/api/auth/login').send({ email: EMAIL_OTRO, password: PASS });

const DATOS_VALIDOS = {
  banco: 'Bancolombia',
  tipo_cuenta: 'ahorros',
  numero_cuenta: '123-456789-00',
  titular_cuenta: 'Proveedor Test S.A.S.',
};

// ── Setup ─────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(PASS, 4);

  // Usuario Contable
  const { rows: [ctb] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Contable DB Test', $1, $2, 'contable', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL_CTB, hash]
  );
  uuidCtb = ctb.id;
  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'contable'
     ON CONFLICT DO NOTHING`,
    [uuidCtb]
  );

  // Usuario Control Interno
  const { rows: [ci] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('CI DB Test', $1, $2, 'control_interno', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL_CI, hash]
  );
  uuidCi = ci.id;
  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'control_interno'
     ON CONFLICT DO NOTHING`,
    [uuidCi]
  );

  // Usuario sin permisos relevantes
  const { rows: [otro] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Otro DB Test', $1, $2, 'juridico', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL_OTRO, hash]
  );
  uuidOtro = otro.id;

  // Proveedor de prueba
  const { rows: [p] } = await pool.query(
    `INSERT INTO tesoreria_proveedores (nombre, tipo_pago) VALUES ('Proveedor DB Test', 'unico') RETURNING id`
  );
  proveedorId = p.id;
});

// ── Teardown ──────────────────────────────────────────────────────────────────
afterAll(async () => {
  await pool.query(`DELETE FROM tesoreria_proveedores_datos_bancarios WHERE proveedor_id = $1`, [proveedorId]);
  await pool.query(`DELETE FROM tesoreria_proveedores WHERE id = $1`, [proveedorId]);
  await pool.query(`DELETE FROM permisos WHERE usuario_uuid IN ($1, $2, $3)`, [uuidCtb, uuidCi, uuidOtro]);
  await pool.query(`DELETE FROM global_usuarios WHERE id IN ($1, $2, $3)`, [uuidCtb, uuidCi, uuidOtro]);
  await pool.end();
});

// ── Auth ──────────────────────────────────────────────────────────────────────
describe('Auth — datos bancarios', () => {
  test('GET /contable/proveedores/:id/datos-bancarios sin token → 401', async () => {
    expect((await request(app).get(`/api/contable/proveedores/${proveedorId}/datos-bancarios`)).status).toBe(401);
  });

  test('POST /contable/proveedores/:id/datos-bancarios sin token → 401', async () => {
    expect((await request(app).post(`/api/contable/proveedores/${proveedorId}/datos-bancarios`).send(DATOS_VALIDOS)).status).toBe(401);
  });

  test('GET /control_interno/datos-bancarios sin token → 401', async () => {
    expect((await request(app).get('/api/control_interno/datos-bancarios')).status).toBe(401);
  });

  test('PUT /control_interno/datos-bancarios/:id/verificar sin token → 401', async () => {
    expect((await request(app).put('/api/control_interno/datos-bancarios/00000000-0000-0000-0000-000000000000/verificar')).status).toBe(401);
  });
});

// ── Permisos cruzados ─────────────────────────────────────────────────────────
describe('Permisos cruzados', () => {
  test('usuario sin permiso contable no puede GET datos-bancarios → 403', async () => {
    const ag = agOtro(); await loginOtro(ag);
    const res = await ag.get(`/api/contable/proveedores/${proveedorId}/datos-bancarios`);
    expect(res.status).toBe(403);
  });

  test('usuario sin permiso control_interno no puede listar solicitudes → 403', async () => {
    const ag = agOtro(); await loginOtro(ag);
    const res = await ag.get('/api/control_interno/datos-bancarios');
    expect(res.status).toBe(403);
  });

  test('usuario contable no puede verificar datos (sin permiso CI) → 403', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag.put('/api/control_interno/datos-bancarios/00000000-0000-0000-0000-000000000000/verificar');
    expect(res.status).toBe(403);
  });
});

// ── GET /contable/proveedores/:id/datos-bancarios — estado inicial ────────────
describe('GET datos-bancarios — proveedor sin datos', () => {
  test('proveedor nuevo devuelve activos sin datos y pendiente null', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag.get(`/api/contable/proveedores/${proveedorId}/datos-bancarios`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('activos');
    expect(res.body).toHaveProperty('pendiente');
    expect(res.body.pendiente).toBeNull();
    expect(res.body.activos.datos_bancarios_estado).toBe('sin_datos');
    expect(res.body.activos.banco).toBeNull();
  });

  test('proveedor inexistente → 404', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag.get('/api/contable/proveedores/00000000-0000-0000-0000-000000000000/datos-bancarios');
    expect(res.status).toBe(404);
  });
});

// ── POST /contable/proveedores/:id/datos-bancarios — solicitar cambio ─────────
describe('POST datos-bancarios — validación y envío', () => {
  test('body vacío → 400', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag.post(`/api/contable/proveedores/${proveedorId}/datos-bancarios`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/obligatorio/i);
  });

  test('campos parciales → 400', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag.post(`/api/contable/proveedores/${proveedorId}/datos-bancarios`).send({ banco: 'Bancolombia' });
    expect(res.status).toBe(400);
  });

  test('tipo_cuenta inválido (no ahorros/corriente) → 400 ó 500 de DB CHECK', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag.post(`/api/contable/proveedores/${proveedorId}/datos-bancarios`).send({
      ...DATOS_VALIDOS, tipo_cuenta: 'invalido',
    });
    expect([400, 500]).toContain(res.status);
  });

  test('solicitud válida → 201, estado pendiente_ci', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag.post(`/api/contable/proveedores/${proveedorId}/datos-bancarios`).send(DATOS_VALIDOS);
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.estado).toBe('pendiente_ci');
    expect(res.body.banco).toBe('Bancolombia');
    solicitudId = res.body.id;
  });

  test('proveedor ahora tiene datos_bancarios_estado = pendiente_ci', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag.get(`/api/contable/proveedores/${proveedorId}/datos-bancarios`);
    expect(res.status).toBe(200);
    expect(res.body.activos.datos_bancarios_estado).toBe('pendiente_ci');
    expect(res.body.pendiente).not.toBeNull();
    expect(res.body.pendiente.banco).toBe('Bancolombia');
  });

  test('segunda solicitud mientras hay una pendiente → 409', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag.post(`/api/contable/proveedores/${proveedorId}/datos-bancarios`).send(DATOS_VALIDOS);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/revisi[oó]n/i);
  });
});

// ── CI: GET /control_interno/datos-bancarios ──────────────────────────────────
describe('GET /control_interno/datos-bancarios — solicitudes pendientes', () => {
  test('CI ve la solicitud pendiente', async () => {
    const ag = agCi(); await loginCi(ag);
    const res = await ag.get('/api/control_interno/datos-bancarios');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(s => s.id === solicitudId)).toBe(true);
  });

  test('cada solicitud tiene proveedor_nombre, banco, tipo_cuenta, numero_cuenta, titular_cuenta', async () => {
    const ag = agCi(); await loginCi(ag);
    const res = await ag.get('/api/control_interno/datos-bancarios');
    const s = res.body.find(s => s.id === solicitudId);
    expect(s).toBeDefined();
    expect(s.proveedor_nombre).toBe('Proveedor DB Test');
    expect(s.banco).toBe('Bancolombia');
    expect(s.tipo_cuenta).toBe('ahorros');
    expect(s.numero_cuenta).toBe('123-456789-00');
    expect(s.titular_cuenta).toBe('Proveedor Test S.A.S.');
    expect(s.solicitado_por_nombre).toBe('Contable DB Test');
  });

  test('solo muestra solicitudes en estado pendiente_ci', async () => {
    const ag = agCi(); await loginCi(ag);
    const res = await ag.get('/api/control_interno/datos-bancarios');
    expect(res.body.every(s => s.estado === 'pendiente_ci')).toBe(true);
  });
});

// ── CI: PUT rechazar ──────────────────────────────────────────────────────────
describe('PUT /control_interno/datos-bancarios/:id/rechazar', () => {
  test('sin motivo → 400', async () => {
    const ag = agCi(); await loginCi(ag);
    const res = await ag.put(`/api/control_interno/datos-bancarios/${solicitudId}/rechazar`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/motivo/i);
  });

  test('solicitud inexistente → 404', async () => {
    const ag = agCi(); await loginCi(ag);
    const res = await ag.put('/api/control_interno/datos-bancarios/00000000-0000-0000-0000-000000000000/rechazar').send({ motivo: 'Test' });
    expect(res.status).toBe(404);
  });

  test('CI rechaza con motivo → 200', async () => {
    const ag = agCi(); await loginCi(ag);
    const res = await ag.put(`/api/control_interno/datos-bancarios/${solicitudId}/rechazar`).send({ motivo: 'Número de cuenta incorrecto' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('proveedor vuelve a sin_datos (no tenía datos previos verificados)', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag.get(`/api/contable/proveedores/${proveedorId}/datos-bancarios`);
    expect(res.status).toBe(200);
    expect(res.body.activos.datos_bancarios_estado).toBe('sin_datos');
    expect(res.body.pendiente).toBeNull();
  });

  test('rechazar solicitud ya procesada → 400', async () => {
    const ag = agCi(); await loginCi(ag);
    const res = await ag.put(`/api/control_interno/datos-bancarios/${solicitudId}/rechazar`).send({ motivo: 'Duplicado' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/procesada/i);
  });

  test('Contable puede enviar nueva solicitud tras rechazo', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag.post(`/api/contable/proveedores/${proveedorId}/datos-bancarios`).send(DATOS_VALIDOS);
    expect(res.status).toBe(201);
    solicitudId = res.body.id; // actualizar para el siguiente describe
  });
});

// ── CI: PUT verificar ─────────────────────────────────────────────────────────
describe('PUT /control_interno/datos-bancarios/:id/verificar', () => {
  test('solicitud inexistente → 404', async () => {
    const ag = agCi(); await loginCi(ag);
    const res = await ag.put('/api/control_interno/datos-bancarios/00000000-0000-0000-0000-000000000000/verificar');
    expect(res.status).toBe(404);
  });

  test('CI verifica la solicitud → 200', async () => {
    const ag = agCi(); await loginCi(ag);
    const res = await ag.put(`/api/control_interno/datos-bancarios/${solicitudId}/verificar`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('proveedor ahora tiene datos_bancarios_estado = verificado', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag.get(`/api/contable/proveedores/${proveedorId}/datos-bancarios`);
    expect(res.status).toBe(200);
    expect(res.body.activos.datos_bancarios_estado).toBe('verificado');
    expect(res.body.activos.banco).toBe('Bancolombia');
    expect(res.body.activos.tipo_cuenta).toBe('ahorros');
    expect(res.body.activos.numero_cuenta).toBe('123-456789-00');
    expect(res.body.activos.titular_cuenta).toBe('Proveedor Test S.A.S.');
    expect(res.body.pendiente).toBeNull();
  });

  test('verificar solicitud ya procesada → 400', async () => {
    const ag = agCi(); await loginCi(ag);
    const res = await ag.put(`/api/control_interno/datos-bancarios/${solicitudId}/verificar`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/procesada/i);
  });

  test('proveedor verificado vuelve a pendiente_ci si Contable envía nuevos datos', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag.post(`/api/contable/proveedores/${proveedorId}/datos-bancarios`).send({
      ...DATOS_VALIDOS, banco: 'Davivienda', numero_cuenta: '999-888777-11',
    });
    expect(res.status).toBe(201);
    const estado = await ag.get(`/api/contable/proveedores/${proveedorId}/datos-bancarios`);
    expect(estado.body.activos.datos_bancarios_estado).toBe('pendiente_ci');
    // datos activos verificados siguen siendo los anteriores hasta que CI apruebe
    expect(estado.body.activos.banco).toBe('Bancolombia');
    expect(estado.body.pendiente.banco).toBe('Davivienda');
  });
});
