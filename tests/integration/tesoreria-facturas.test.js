import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';

let app;

// ── Usuarios de test ─────────────────────────────────────────────────────────
const EMAIL_TSR = 'tesoreria-fact-test@kernel.test';
const EMAIL_CI  = 'control-interno-test@kernel.test';
const PASS      = 'testpass123';
let uuidTsr, uuidCi;

// IDs creados en tests
let proveedorRecId, proveedorUnicoId, facturaId, cuentaId;

const agentTsr = () => request.agent(app);
const agentCi  = () => request.agent(app);
const loginTsr = (ag) => ag.post('/api/auth/login').send({ email: EMAIL_TSR, password: PASS });
const loginCi  = (ag) => ag.post('/api/auth/login').send({ email: EMAIL_CI,  password: PASS });

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
    await pool.query(`UPDATE tesoreria_facturas SET movimiento_id = NULL WHERE id = $1`, [facturaId]);
    await pool.query(`DELETE FROM tesoreria_movimientos WHERE descripcion LIKE '%Proveedor Recurrente Test%'`);
    await pool.query(`DELETE FROM tesoreria_facturas WHERE id = $1`, [facturaId]);
  }
  await pool.query(`DELETE FROM tesoreria_facturas WHERE proveedor_id IN (
    SELECT id FROM tesoreria_proveedores WHERE nombre IN ('Proveedor Recurrente Test', 'Proveedor Único Test')
  )`);
  if (proveedorRecId)   await pool.query(`DELETE FROM tesoreria_proveedores WHERE id = $1`, [proveedorRecId]);
  if (proveedorUnicoId) await pool.query(`DELETE FROM tesoreria_proveedores WHERE id = $1`, [proveedorUnicoId]);
  if (cuentaId)         await pool.query(`DELETE FROM tesoreria_cuentas WHERE id = $1`, [cuentaId]);
  await pool.query(`DELETE FROM permisos        WHERE usuario_uuid IN ($1, $2)`, [uuidTsr, uuidCi]);
  await pool.query(`DELETE FROM global_usuarios WHERE id IN ($1, $2)`, [uuidTsr, uuidCi]);
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
});

describe('Facturas — flujo completo', () => {
  test('POST /tesoreria/facturas → 201, estado pendiente_aprobacion', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.post('/api/tesoreria/facturas').send({
      proveedor_id: proveedorRecId,
      monto: 350000,
      fecha_recibida: '2026-09-01',
      fecha_vencimiento: '2026-09-20',
      descripcion: 'Factura sept 2026',
      soporte: 'FAC-2026-001',
    });
    expect(res.status).toBe(201);
    expect(res.body.estado).toBe('pendiente_aprobacion');
    facturaId = res.body.id;
  });

  test('GET /tesoreria/facturas → incluye la factura creada', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.get('/api/tesoreria/facturas');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(f => f.id === facturaId)).toBe(true);
  });

  test('GET /tesoreria/facturas/:id → 200 con proveedor_nombre', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.get(`/api/tesoreria/facturas/${facturaId}`);
    expect(res.status).toBe(200);
    expect(res.body.proveedor_nombre).toBe('Proveedor Recurrente Test');
  });

  test('PUT /tesoreria/facturas/:id/pagar en estado pendiente → 400', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.put(`/api/tesoreria/facturas/${facturaId}/pagar`).send({
      cuenta_pago_id: cuentaId, fecha_pago: '2026-09-10',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aprobada/i);
  });

  test('GET /control_interno/facturas → incluye factura pendiente', async () => {
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

  test('PUT /control_interno/facturas/:id/aprobar → 200, estado aprobada', async () => {
    const ag = agentCi(); await loginCi(ag);
    const res = await ag.put(`/api/control_interno/facturas/${facturaId}/aprobar`);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('aprobada');
    expect(res.body.aprobado_por).toBe(uuidCi);
  });

  test('PUT /control_interno/facturas/:id/aprobar ya aprobada → 400', async () => {
    const ag = agentCi(); await loginCi(ag);
    expect((await ag.put(`/api/control_interno/facturas/${facturaId}/aprobar`)).status).toBe(400);
  });

  test('PUT /tesoreria/facturas/:id/pagar → 200, crea movimiento de egreso', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.put(`/api/tesoreria/facturas/${facturaId}/pagar`).send({
      cuenta_pago_id: cuentaId,
      fecha_pago: '2026-09-10',
      referencia: 'TRF-001',
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('movimiento_id');

    // Verificar que el movimiento existe en tesoreria_movimientos
    const { rows } = await pool.query(
      `SELECT * FROM tesoreria_movimientos WHERE id = $1`, [res.body.movimiento_id]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].tipo).toBe('egreso');
    expect(Number(rows[0].monto)).toBe(350000);
  });

  test('Factura queda en estado pagada', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.get(`/api/tesoreria/facturas/${facturaId}`);
    expect(res.body.estado).toBe('pagada');
    expect(res.body.movimiento_id).not.toBeNull();
  });

  test('PUT /tesoreria/facturas/:id/pagar ya pagada → 400', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    const res = await ag.put(`/api/tesoreria/facturas/${facturaId}/pagar`).send({
      cuenta_pago_id: cuentaId, fecha_pago: '2026-09-11',
    });
    expect(res.status).toBe(400);
  });

  test('GET /control_interno/facturas?estado=aprobada → vacío (ya se pagó)', async () => {
    const ag = agentCi(); await loginCi(ag);
    const res = await ag.get('/api/control_interno/facturas?estado=aprobada');
    expect(res.status).toBe(200);
    expect(res.body.some(f => f.id === facturaId)).toBe(false);
  });
});

// ── Flujo rechazo ─────────────────────────────────────────────────────────────
describe('Facturas — flujo de rechazo', () => {
  let facturaRechazadaId;

  afterAll(async () => {
    if (facturaRechazadaId) await pool.query(`DELETE FROM tesoreria_facturas WHERE id = $1`, [facturaRechazadaId]);
  });

  test('Registrar, rechazar y verificar estado', async () => {
    const agTsr = agentTsr(); await loginTsr(agTsr);
    const { body: f } = await agTsr.post('/api/tesoreria/facturas').send({
      proveedor_id: proveedorUnicoId,
      monto: 80000,
      fecha_recibida: '2026-09-05',
      fecha_vencimiento: '2026-09-25',
      descripcion: 'Factura única para rechazar',
    });
    facturaRechazadaId = f.id;

    const agCi = agentCi(); await loginCi(agCi);
    const rechRes = await agCi.put(`/api/control_interno/facturas/${f.id}/rechazar`).send({
      motivo: 'Factura duplicada',
    });
    expect(rechRes.status).toBe(200);
    expect(rechRes.body.estado).toBe('rechazada');
    expect(rechRes.body.rechazo_motivo).toBe('Factura duplicada');
  });
});
