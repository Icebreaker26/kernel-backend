import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';
import { jest } from '@jest/globals';

jest.setTimeout(30000);

let app;

// ── Usuarios de test ─────────────────────────────────────────────────────────
const EMAIL_TSR  = 'tesoreria-fact-test@kernel.test';
const EMAIL_CI   = 'control-interno-test@kernel.test';
const EMAIL_RESP = 'responsable-area-test@kernel.test';
const PASS       = 'testpass123';
let uuidTsr, uuidCi, uuidResp;

// IDs creados en tests
let proveedorRecId, proveedorUnicoId, facturaId, cuentaId;

const agentTsr  = () => request.agent(app);
const agentCi   = () => request.agent(app);
const agentResp = () => request.agent(app);
const loginTsr  = (ag) => ag.post('/api/auth/login').send({ email: EMAIL_TSR,  password: PASS });
const loginCi   = (ag) => ag.post('/api/auth/login').send({ email: EMAIL_CI,   password: PASS });
const loginResp = (ag) => ag.post('/api/auth/login').send({ email: EMAIL_RESP, password: PASS });

// ── Setup ────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(PASS, 4);

  // Usuario Tesorería
  const { rows: [tsr] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Tesorera Facturas Test', $1, $2, 'tesorera', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL_TSR, hash]
  );
  uuidTsr = tsr.id;
  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'tesoreria'
     ON CONFLICT DO NOTHING`, [uuidTsr]
  );

  // Usuario Control Interno
  const { rows: [ci] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Control Interno Test', $1, $2, 'control_interno', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL_CI, hash]
  );
  uuidCi = ci.id;
  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'control_interno'
     ON CONFLICT DO NOTHING`, [uuidCi]
  );

  // Usuario Responsable de Área (aprueba facturas asignadas)
  const { rows: [resp] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Responsable Area Test', $1, $2, 'tesorera', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL_RESP, hash]
  );
  uuidResp = resp.id;
  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'tesoreria'
     ON CONFLICT DO NOTHING`, [uuidResp]
  );

  // Cuenta bancaria para los tests de pago
  const { rows: [c] } = await pool.query(
    `INSERT INTO tesoreria_cuentas (nombre, tipo, saldo_inicial) VALUES ('Bancolombia Test Facturas', 'banco', 5000000) RETURNING id`
  );
  cuentaId = c.id;
});

// ── Teardown ─────────────────────────────────────────────────────────────────
afterAll(async () => {
  // Limpiar en orden de FKs
  if (facturaId) {
    await pool.query(`DELETE FROM tesoreria_facturas WHERE id = $1`, [facturaId]);
  }
  await pool.query(`DELETE FROM tesoreria_facturas WHERE proveedor_id IN (
    SELECT id FROM tesoreria_proveedores WHERE nombre IN ('Proveedor Recurrente Test', 'Proveedor Único Test')
  )`);
  if (proveedorRecId)   await pool.query(`DELETE FROM tesoreria_proveedores WHERE id = $1`, [proveedorRecId]);
  if (proveedorUnicoId) await pool.query(`DELETE FROM tesoreria_proveedores WHERE id = $1`, [proveedorUnicoId]);
  if (cuentaId)         await pool.query(`DELETE FROM tesoreria_cuentas WHERE id = $1`, [cuentaId]);
  await pool.query(`DELETE FROM permisos        WHERE usuario_uuid IN ($1, $2, $3)`, [uuidTsr, uuidCi, uuidResp]);
  await pool.query(`DELETE FROM global_usuarios WHERE id IN ($1, $2, $3)`, [uuidTsr, uuidCi, uuidResp]);
  await pool.end();
});

// ── Auth guard ────────────────────────────────────────────────────────────────
describe('Auth', () => {
  test('GET /api/tesoreria/proveedores sin token → 401', async () => {
    expect((await request(app).get('/api/tesoreria/proveedores')).status).toBe(401);
  });
  test('GET /api/tesoreria/facturas sin token → 401', async () => {
    expect((await request(app).get('/api/tesoreria/facturas')).status).toBe(401);
  });
  test('GET /api/control_interno/facturas sin token → 401', async () => {
    expect((await request(app).get('/api/control_interno/facturas')).status).toBe(401);
  });
  test('Control Interno no puede acceder a tesoreria/facturas con su token', async () => {
    const ag = agentCi(); await loginCi(ag);
    expect((await ag.get('/api/tesoreria/facturas')).status).toBe(403);
  });
  test('Tesorería no puede aprobar facturas (sin permiso control_interno)', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    expect((await ag.put('/api/control_interno/facturas/00000000-0000-0000-0000-000000000000/aprobar')).status).toBe(403);
  });
});

// ── Proveedores ───────────────────────────────────────────────────────────────
describe('Proveedores — Validación Zod', () => {
  test('POST body vacío → 400', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    expect((await ag.post('/api/tesoreria/proveedores').send({})).status).toBe(400);
  });
  test('POST tipo_pago inválido → 400', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    expect((await ag.post('/api/tesoreria/proveedores').send({ nombre: 'X', tipo_pago: 'quincenal' })).status).toBe(400);
  });
  test('POST recurrente sin frecuencia → 400', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.post('/api/tesoreria/proveedores').send({ nombre: 'X', tipo_pago: 'recurrente' });
    expect(res.status).toBe(400);
  });
  test('POST unico con frecuencia → 400', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.post('/api/tesoreria/proveedores').send({ nombre: 'X', tipo_pago: 'unico', frecuencia: 'mensual' });
    expect(res.status).toBe(400);
  });
});

describe('Proveedores — CRUD', () => {
  test('POST proveedor recurrente → 201', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.post('/api/tesoreria/proveedores').send({
      nombre: 'Proveedor Recurrente Test',
      tipo_pago: 'recurrente',
      frecuencia: 'mensual',
      categoria: 'Servicios públicos',
      nit: '800.000.001-1',
    });
    expect(res.status).toBe(201);
    expect(res.body.tipo_pago).toBe('recurrente');
    expect(res.body.frecuencia).toBe('mensual');
    proveedorRecId = res.body.id;
  });

  test('POST proveedor único → 201', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.post('/api/tesoreria/proveedores').send({
      nombre: 'Proveedor Único Test',
      tipo_pago: 'unico',
    });
    expect(res.status).toBe(201);
    expect(res.body.frecuencia).toBeNull();
    proveedorUnicoId = res.body.id;
  });

  test('GET /proveedores → lista ambos', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.get('/api/tesoreria/proveedores');
    expect(res.status).toBe(200);
    expect(res.body.some(p => p.id === proveedorRecId)).toBe(true);
    expect(res.body.some(p => p.id === proveedorUnicoId)).toBe(true);
  });

  test('GET /proveedores?tipo_pago=recurrente → solo recurrentes', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.get('/api/tesoreria/proveedores?tipo_pago=recurrente');
    expect(res.status).toBe(200);
    expect(res.body.every(p => p.tipo_pago === 'recurrente')).toBe(true);
  });

  test('PUT /proveedores/:id campo extra (strict) → 400', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.put(`/api/tesoreria/proveedores/${proveedorRecId}`).send({ tipo_pago: 'unico' });
    expect(res.status).toBe(400);
  });

  test('PUT /proveedores/:id → 200 actualiza categoría', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.put(`/api/tesoreria/proveedores/${proveedorRecId}`).send({ categoria: 'Arriendo' });
    expect(res.status).toBe(200);
    expect(res.body.categoria).toBe('Arriendo');
  });
});

// ── Facturas — registro ───────────────────────────────────────────────────────
describe('Facturas — Validación Zod', () => {
  test('POST body vacío → 400', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    expect((await ag.post('/api/tesoreria/facturas').send({})).status).toBe(400);
  });
  test('POST monto negativo → 400', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.post('/api/tesoreria/facturas').send({
      proveedor_id: proveedorRecId, monto: -1000,
      fecha_recibida: '2026-09-01', fecha_vencimiento: '2026-09-30',
    });
    expect(res.status).toBe(400);
  });
  test('POST fecha con formato inválido → 400', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.post('/api/tesoreria/facturas').send({
      proveedor_id: proveedorRecId, monto: 100000,
      fecha_recibida: '01/09/2026', fecha_vencimiento: '30/09/2026',
    });
    expect(res.status).toBe(400);
  });
  test('POST fecha_emision con formato inválido → 400', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.post('/api/tesoreria/facturas').send({
      proveedor_id: proveedorRecId, monto: 100000,
      fecha_emision: '01-09-2026',
      fecha_recibida: '2026-09-01', fecha_vencimiento: '2026-09-30',
    });
    expect(res.status).toBe(400);
  });
});

describe('Facturas — flujo completo', () => {
  test('POST /tesoreria/facturas con campos completos → 201', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.post('/api/tesoreria/facturas').send({
      proveedor_id:       proveedorRecId,
      monto:              350000,
      fecha_emision:      '2026-08-28',
      fecha_recibida:     '2026-09-01',
      fecha_vencimiento:  '2026-09-20',
      area_responsable:   'Administración',
      fecha_entrega_area: '2026-09-02',
      descripcion:        'Factura sept 2026',
      numero_factura:     'FAC-2026-001',
    });
    expect(res.status).toBe(201);
    expect(res.body.estado).toBe('pendiente_aprobacion');
    expect(res.body.numero_factura).toBe('FAC-2026-001');
    expect(res.body.area_responsable).toBe('Administración');
    expect(res.body.fecha_emision).toMatch(/^2026-08-28/);
    expect(res.body.fecha_entrega_area).toMatch(/^2026-09-02/);
    facturaId = res.body.id;
  });

  test('GET /tesoreria/facturas → incluye la factura creada', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.get('/api/tesoreria/facturas');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(f => f.id === facturaId)).toBe(true);
  });

  test('GET /tesoreria/facturas/:id → campos enriquecidos correctos', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.get(`/api/tesoreria/facturas/${facturaId}`);
    expect(res.status).toBe(200);
    expect(res.body.proveedor_nombre).toBe('Proveedor Recurrente Test');
    expect(res.body.proveedor_nit).toBe('800.000.001-1');
    expect(res.body.numero_factura).toBe('FAC-2026-001');
    expect(res.body.area_responsable).toBe('Administración');
    // dias_area_contable: created_at - fecha_entrega_area (≈ 0 días en test)
    expect(res.body.dias_area_contable).toBeGreaterThanOrEqual(0);
    // antes de aprobar: dias_control_interno aún null
    expect(res.body.dias_control_interno).toBeNull();
    expect(res.body.fecha_pago).toBeNull();
  });

  test('PUT /tesoreria/facturas/:id/autorizar en estado pendiente → 400', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.put(`/api/tesoreria/facturas/${facturaId}/autorizar`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/verificada/i);
  });

  test('PUT /tesoreria/facturas/:id/pagar → 404 (endpoint eliminado)', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.put(`/api/tesoreria/facturas/${facturaId}/pagar`).send({
      cuenta_pago_id: cuentaId, fecha_pago: '2026-09-10',
    });
    expect(res.status).toBe(404);
  });

  // Paso 1: área responsable aprueba
  test('PUT /tesoreria/facturas/:id/aprobar-area → 200, estado aprobada', async () => {
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.put(`/api/tesoreria/facturas/${facturaId}/aprobar-area`).send({});
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('aprobada');
    expect(res.body.aprobado_por).toBe(uuidResp);
  });

  test('PUT /tesoreria/facturas/:id/aprobar-area ya aprobada → 400', async () => {
    const ag = agentResp(); await loginResp(ag);
    expect((await ag.put(`/api/tesoreria/facturas/${facturaId}/aprobar-area`).send({})).status).toBe(400);
  });

  // Paso 2: CI verifica (aprobada → verificada)
  test('GET /control_interno/facturas → incluye factura aprobada por área', async () => {
    const ag = agentCi(); await loginCi(ag);
    const res = await ag.get('/api/control_interno/facturas');
    expect(res.status).toBe(200);
    expect(res.body.some(f => f.id === facturaId)).toBe(true);
  });

  test('PUT /control_interno/facturas/:id/rechazar sin motivo → 400', async () => {
    const ag = agentCi(); await loginCi(ag);
    const res = await ag.put(`/api/control_interno/facturas/${facturaId}/rechazar`).send({ motivo: '' });
    expect(res.status).toBe(400);
  });

  test('PUT /control_interno/facturas/:id/verificar → 200, estado verificada', async () => {
    const ag = agentCi(); await loginCi(ag);
    const res = await ag.put(`/api/control_interno/facturas/${facturaId}/verificar`);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('verificada');
    expect(res.body.verificada_por).toBe(uuidCi);
    expect(res.body.verificada_at).not.toBeNull();
  });

  test('PUT /control_interno/facturas/:id/verificar ya verificada → 400', async () => {
    const ag = agentCi(); await loginCi(ag);
    expect((await ag.put(`/api/control_interno/facturas/${facturaId}/verificar`)).status).toBe(400);
  });

  // Paso 3: Tesorería autoriza (verificada → autorizada)
  test('PUT /tesoreria/facturas/:id/autorizar → 200, estado=autorizada, sin movimiento', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.put(`/api/tesoreria/facturas/${facturaId}/autorizar`).send({});
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('autorizada');
    expect(res.body.movimiento_id).toBeNull();
  });

  test('Factura queda en estado autorizada (sin fecha_pago aún)', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.get(`/api/tesoreria/facturas/${facturaId}`);
    expect(res.body.estado).toBe('autorizada');
    expect(res.body.movimiento_id).toBeNull();
    expect(res.body.fecha_pago).toBeNull();
    expect(typeof res.body.dias_control_interno).toBe('number');
    expect(res.body.dias_tesoreria).toBeNull();
  });

  test('PUT /tesoreria/facturas/:id/autorizar ya autorizada → 400', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.put(`/api/tesoreria/facturas/${facturaId}/autorizar`).send({});
    expect(res.status).toBe(400);
  });

  test('GET /control_interno/facturas?estado=aprobada → vacío (ya se verificó)', async () => {
    const ag = agentCi(); await loginCi(ag);
    const res = await ag.get('/api/control_interno/facturas?estado=aprobada');
    expect(res.status).toBe(200);
    expect(res.body.some(f => f.id === facturaId)).toBe(false);
  });
});

// ── Usuarios disponibles ──────────────────────────────────────────────────────
describe('Usuarios disponibles — selector de responsable', () => {
  test('GET /tesoreria/usuarios-disponibles → 200 lista de usuarios activos', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.get('/api/tesoreria/usuarios-disponibles');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    const u = res.body[0];
    expect(u).toHaveProperty('id');
    expect(u).toHaveProperty('nombre');
    expect(u).toHaveProperty('rol');
    expect(Object.keys(u)).not.toContain('password_hash');
  });

  test('GET /tesoreria/usuarios-disponibles sin token → 401', async () => {
    expect((await request(app).get('/api/tesoreria/usuarios-disponibles')).status).toBe(401);
  });

  test('GET /tesoreria/usuarios-disponibles — el responsable de test aparece en la lista', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.get('/api/tesoreria/usuarios-disponibles');
    expect(res.body.some(u => u.id === uuidResp)).toBe(true);
  });
});

// ── Mis pendientes — vista por responsable ────────────────────────────────────
describe('Facturas — mis-pendientes', () => {
  let facturaAsignadaId;

  afterAll(async () => {
    if (facturaAsignadaId) await pool.query(`DELETE FROM tesoreria_facturas WHERE id = $1`, [facturaAsignadaId]);
  });

  test('POST factura con responsable_id → 201, responsable asignado', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.post('/api/tesoreria/facturas').send({
      proveedor_id:      proveedorRecId,
      monto:             120000,
      fecha_recibida:    '2026-09-05',
      fecha_vencimiento: '2026-09-28',
      responsable_id:    uuidResp,
      descripcion:       'Factura asignada a responsable para test mis-pendientes',
    });
    expect(res.status).toBe(201);
    expect(res.body.responsable_id).toBe(uuidResp);
    expect(res.body.estado).toBe('pendiente_aprobacion');
    facturaAsignadaId = res.body.id;
  });

  test('GET /facturas/:id → responsable_nombre presente', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.get(`/api/tesoreria/facturas/${facturaAsignadaId}`);
    expect(res.status).toBe(200);
    expect(res.body.responsable_nombre).toBe('Responsable Area Test');
  });

  test('GET /facturas/mis-pendientes — responsable ve solo su factura', async () => {
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.get('/api/tesoreria/facturas/mis-pendientes');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(f => f.id === facturaAsignadaId)).toBe(true);
    // No debe ver facturas de otros
    expect(res.body.every(f => f.responsable_id === uuidResp)).toBe(true);
  });

  test('GET /facturas/mis-pendientes — tesorería NO ve esa factura (no le pertenece)', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.get('/api/tesoreria/facturas/mis-pendientes');
    expect(res.status).toBe(200);
    expect(res.body.some(f => f.id === facturaAsignadaId)).toBe(false);
  });

  test('GET /facturas/mis-pendientes sin token → 401', async () => {
    expect((await request(app).get('/api/tesoreria/facturas/mis-pendientes')).status).toBe(401);
  });

  test('PUT aprobar-area — responsable aprueba su factura asignada', async () => {
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.put(`/api/tesoreria/facturas/${facturaAsignadaId}/aprobar-area`).send({});
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('aprobada');
    expect(res.body.aprobado_por).toBe(uuidResp);
  });

  test('GET /facturas/mis-pendientes — ya no aparece después de aprobar', async () => {
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.get('/api/tesoreria/facturas/mis-pendientes');
    expect(res.status).toBe(200);
    expect(res.body.some(f => f.id === facturaAsignadaId)).toBe(false);
  });
});

// ── Export Excel ──────────────────────────────────────────────────────────────
describe('Movimientos — Export Excel', () => {
  test('GET /tesoreria/movimientos/export → 200 con content-type xlsx', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.get('/api/tesoreria/movimientos/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
  });

  test('GET sin token → 401', async () => {
    expect((await request(app).get('/api/tesoreria/movimientos/export')).status).toBe(401);
  });
});

// ── Umbrales de aprobación ────────────────────────────────────────────────────
describe('Config — Umbrales', () => {
  let umbralId;

  test('GET /config/umbrales → lista con al menos el umbral semilla', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.get('/api/tesoreria/config/umbrales');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const u = res.body.find(u => u.tipo_operacion === 'egreso_proveedor');
    expect(u).toBeDefined();
    expect(Number(u.monto_umbral)).toBe(5000000);
    expect(u.dias_vencimiento).toBe(7);
    umbralId = u.id;
  });

  test('PUT /config/umbrales/:id → 200 actualiza dias_vencimiento', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.put(`/api/tesoreria/config/umbrales/${umbralId}`).send({
      dias_vencimiento: 10,
      descripcion: 'Umbral actualizado en test',
    });
    expect(res.status).toBe(200);
    expect(res.body.dias_vencimiento).toBe(10);
    expect(res.body.descripcion).toBe('Umbral actualizado en test');
    // Restaurar para no afectar otros tests
    await ag.put(`/api/tesoreria/config/umbrales/${umbralId}`).send({ dias_vencimiento: 7, descripcion: 'Pagos a proveedores que requieren aprobación de Gerencia' });
  });

  test('PUT campo no permitido (strict) → 400', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.put(`/api/tesoreria/config/umbrales/${umbralId}`).send({ tipo_operacion: 'hacked' });
    expect(res.status).toBe(400);
  });
});

// ── Flujo con aprobación de Gerencia ─────────────────────────────────────────
describe('Facturas — flujo umbral Gerencia', () => {
  let facturaGrandeId;
  let cuentaGrandeId;

  beforeAll(async () => {
    const { rows: [c] } = await pool.query(
      `INSERT INTO tesoreria_cuentas (nombre, tipo, saldo_inicial) VALUES ('Cuenta Grande Test', 'banco', 20000000) RETURNING id`
    );
    cuentaGrandeId = c.id;
  });

  afterAll(async () => {
    if (facturaGrandeId) await pool.query(`DELETE FROM tesoreria_facturas WHERE id = $1`, [facturaGrandeId]);
    if (cuentaGrandeId)  await pool.query(`DELETE FROM tesoreria_cuentas WHERE id = $1`, [cuentaGrandeId]);
  });

  test('POST factura > umbral ($6M) → requiere_aprobacion_gerencia = true', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.post('/api/tesoreria/facturas').send({
      proveedor_id:      proveedorRecId,
      monto:             6000000,
      fecha_recibida:    '2026-09-01',
      fecha_vencimiento: '2026-09-30',
      descripcion:       'Factura grande test gerencia',
    });
    expect(res.status).toBe(201);
    expect(res.body.requiere_aprobacion_gerencia).toBe(true);
    facturaGrandeId = res.body.id;
  });

  test('POST factura < umbral ($350K) → requiere_aprobacion_gerencia = false', async () => {
    // verificado indirectamente — la factura del flujo completo tiene monto 350000
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.get(`/api/tesoreria/facturas/${facturaId}`);
    expect(res.body.requiere_aprobacion_gerencia).toBe(false);
  });

  test('Área aprueba factura grande → estado aprobada', async () => {
    const ag = agentResp(); await loginResp(ag);
    const res = await ag.put(`/api/tesoreria/facturas/${facturaGrandeId}/aprobar-area`).send({});
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('aprobada');
  });

  test('CI verifica factura grande → aprobacion_vence_at queda en el futuro', async () => {
    const ag = agentCi(); await loginCi(ag);
    const res = await ag.put(`/api/control_interno/facturas/${facturaGrandeId}/verificar`);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('verificada');
    expect(res.body.aprobacion_vence_at).not.toBeNull();
    expect(new Date(res.body.aprobacion_vence_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('Intentar autorizar sin aprobación gerencia → 400', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.put(`/api/tesoreria/facturas/${facturaGrandeId}/autorizar`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/gerencia/i);
  });

  test('aprobar-gerencia → 200, sets aprobado_gerencia_at', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.put(`/api/tesoreria/facturas/${facturaGrandeId}/aprobar-gerencia`);
    expect(res.status).toBe(200);
    expect(res.body.aprobado_gerencia_por).toBe(uuidTsr);
    expect(res.body.aprobado_gerencia_at).not.toBeNull();
  });

  test('aprobar-gerencia dos veces → 400', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.put(`/api/tesoreria/facturas/${facturaGrandeId}/aprobar-gerencia`);
    expect(res.status).toBe(400);
  });

  test('Autorizar factura grande con ambas aprobaciones → 200, estado=autorizada', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.put(`/api/tesoreria/facturas/${facturaGrandeId}/autorizar`).send({});
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('autorizada');
  });
});

// ── Flujo rechazo ─────────────────────────────────────────────────────────────
describe('Facturas — flujo de rechazo', () => {
  let facturaRechazadaId;

  afterAll(async () => {
    if (facturaRechazadaId) await pool.query(`DELETE FROM tesoreria_facturas WHERE id = $1`, [facturaRechazadaId]);
  });

  test('Registrar, área aprueba, CI rechaza y verificar estado', async () => {
    const agTsr = agentTsr(); await loginTsr(agTsr);
    const { body: f } = await agTsr.post('/api/tesoreria/facturas').send({
      proveedor_id: proveedorUnicoId,
      monto: 80000,
      fecha_recibida: '2026-09-05',
      fecha_vencimiento: '2026-09-25',
      descripcion: 'Factura única para rechazar',
    });
    facturaRechazadaId = f.id;

    // Área aprueba primero
    const agResp = agentResp(); await loginResp(agResp);
    await agResp.put(`/api/tesoreria/facturas/${f.id}/aprobar-area`).send({});

    // CI rechaza desde 'aprobada'
    const agCi = agentCi(); await loginCi(agCi);
    const rechRes = await agCi.put(`/api/control_interno/facturas/${f.id}/rechazar`).send({
      motivo: 'Factura duplicada',
    });
    expect(rechRes.status).toBe(200);
    expect(rechRes.body.estado).toBe('rechazada');
    expect(rechRes.body.rechazo_motivo).toBe('Factura duplicada');
  });
});

// ── Retenciones — egreso usa monto_neto ───────────────────────────────────────
describe('Facturas — retenciones en pago', () => {
  let facturaRetId, cuentaRetId;

  beforeAll(async () => {
    const { rows: [c] } = await pool.query(
      `INSERT INTO tesoreria_cuentas (nombre, tipo, saldo_inicial) VALUES ('Cuenta Ret Test', 'banco', 2000000) RETURNING id`
    );
    cuentaRetId = c.id;
  });

  afterAll(async () => {
    if (facturaRetId) await pool.query(`DELETE FROM tesoreria_facturas WHERE id = $1`, [facturaRetId]);
    if (cuentaRetId)  await pool.query(`DELETE FROM tesoreria_cuentas WHERE id = $1`, [cuentaRetId]);
  });

  test('Factura con retenciones: monto_neto calculado correctamente', async () => {
    const agTsr = agentTsr(); await loginTsr(agTsr);
    const res = await agTsr.post('/api/tesoreria/facturas').send({
      proveedor_id:      proveedorRecId,
      monto:             1000000,
      retencion_fuente:  35000,    // 3.5%
      retencion_ica:     11600,    // 1.16%
      fecha_recibida:    '2026-09-01',
      fecha_vencimiento: '2026-09-30',
      descripcion:       'Ret Fuente Test',
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.monto_neto)).toBe(953400);
    facturaRetId = res.body.id;
  });

  test('Al autorizar, factura queda en autorizada sin movimiento creado', async () => {
    // Área aprueba
    const agResp = agentResp(); await loginResp(agResp);
    await agResp.put(`/api/tesoreria/facturas/${facturaRetId}/aprobar-area`).send({});

    // CI verifica
    const agCi = agentCi(); await loginCi(agCi);
    await agCi.put(`/api/control_interno/facturas/${facturaRetId}/verificar`);

    // Tesorería autoriza (en Option B el movimiento se crea al confirmar el extracto bancario)
    const agTsr = agentTsr(); await loginTsr(agTsr);
    const res = await agTsr.put(`/api/tesoreria/facturas/${facturaRetId}/autorizar`).send({});
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('autorizada');

    // Verificar que NO se creó un movimiento (el extracto bancario será quien lo confirme)
    const { rows } = await pool.query(
      `SELECT movimiento_id FROM tesoreria_facturas WHERE id = $1`, [facturaRetId]
    );
    expect(rows[0].movimiento_id).toBeNull();
  });

  test('GET factura autorizada con retenciones → monto_neto correcto, sin pago_referencia aún', async () => {
    const agTsr = agentTsr(); await loginTsr(agTsr);
    const res = await agTsr.get(`/api/tesoreria/facturas/${facturaRetId}`);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('autorizada');
    expect(Number(res.body.monto_neto)).toBe(953400);
    expect(Number(res.body.monto)).toBe(1000000);
    // pago_referencia viene del movimiento, que aún no existe (se crea al confirmar extracto)
    expect(res.body.pago_referencia).toBeNull();
  });
});
