import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';

let app;

// ── Usuarios de test ──────────────────────────────────────────────────────────
const EMAIL_CTB = 'contable-test@kernel.test';
const EMAIL_TSR = 'contable-tsr-test@kernel.test';   // usuario SIN permiso contable
const PASS      = 'testpass123';
let uuidCtb, uuidTsr;

// Recursos creados en tests
let proveedorId, facturaId;

const agentCtb = () => request.agent(app);
const agentTsr = () => request.agent(app);
const loginCtb = (ag) => ag.post('/api/auth/login').send({ email: EMAIL_CTB, password: PASS });
const loginTsr = (ag) => ag.post('/api/auth/login').send({ email: EMAIL_TSR, password: PASS });

// ── Setup ─────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(PASS, 4);

  // Usuario Contable — permiso módulo 'contable'
  const { rows: [ctb] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Contable Test', $1, $2, 'contable', true, true)
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

  // Usuario Tesorería — sin permiso en módulo 'contable'
  const { rows: [tsr] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Tesorera Contable Test', $1, $2, 'tesorera', true, true)
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
});

// ── Teardown ──────────────────────────────────────────────────────────────────
afterAll(async () => {
  if (facturaId) await pool.query(`DELETE FROM tesoreria_facturas WHERE id = $1`, [facturaId]);
  if (proveedorId) await pool.query(`DELETE FROM tesoreria_proveedores_historial WHERE proveedor_id = $1`, [proveedorId]);
  if (proveedorId) await pool.query(`DELETE FROM tesoreria_proveedores WHERE id = $1`, [proveedorId]);
  await pool.query(`DELETE FROM tesoreria_proveedores_historial WHERE cambiado_por IN ($1, $2)`, [uuidCtb, uuidTsr]);
  await pool.query(`DELETE FROM permisos        WHERE usuario_uuid IN ($1, $2)`, [uuidCtb, uuidTsr]);
  await pool.query(`DELETE FROM global_usuarios WHERE id IN ($1, $2)`,           [uuidCtb, uuidTsr]);
  await pool.end();
});

// ── Auth guards ───────────────────────────────────────────────────────────────
describe('Auth', () => {
  test('GET /contable/facturas sin token → 401', async () => {
    expect((await request(app).get('/api/contable/facturas')).status).toBe(401);
  });
  test('GET /contable/proveedores sin token → 401', async () => {
    expect((await request(app).get('/api/contable/proveedores')).status).toBe(401);
  });
  test('POST /contable/facturas sin token → 401', async () => {
    expect((await request(app).post('/api/contable/facturas').send({})).status).toBe(401);
  });
});

// ── Permisos cruzados ─────────────────────────────────────────────────────────
describe('Permisos', () => {
  test('Tesorera sin permiso contable → GET /contable/facturas = 403', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    expect((await ag.get('/api/contable/facturas')).status).toBe(403);
  });
  test('Tesorera sin permiso contable → GET /contable/proveedores = 403', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    expect((await ag.get('/api/contable/proveedores')).status).toBe(403);
  });
  test('Tesorera sin permiso contable → POST /contable/facturas = 403', async () => {
    const ag = agentTsr(); await loginTsr(ag);
    expect((await ag.post('/api/contable/facturas').send({ monto: 100 })).status).toBe(403);
  });
});

// ── Proveedores ───────────────────────────────────────────────────────────────
describe('Proveedores — Validación Zod', () => {
  test('POST body vacío → 400', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    expect((await ag.post('/api/contable/proveedores').send({})).status).toBe(400);
  });
  test('POST recurrente sin frecuencia → 400', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    expect((await ag.post('/api/contable/proveedores').send({ nombre: 'X', tipo_pago: 'recurrente' })).status).toBe(400);
  });
});

describe('Proveedores — CRUD', () => {
  test('POST proveedor único → 201', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    const res = await ag.post('/api/contable/proveedores').send({
      nombre: 'Proveedor Contable Test',
      tipo_pago: 'unico',
      nit: '900.111.222-3',
      categoria: 'Mantenimiento',
    });
    expect(res.status).toBe(201);
    expect(res.body.nombre).toBe('Proveedor Contable Test');
    expect(res.body.tipo_pago).toBe('unico');
    proveedorId = res.body.id;
  });

  test('GET /contable/proveedores → lista con el proveedor creado', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    const res = await ag.get('/api/contable/proveedores');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(p => p.id === proveedorId)).toBe(true);
  });

  test('PUT /contable/proveedores/:id → 200 actualiza notas', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    const res = await ag.put(`/api/contable/proveedores/${proveedorId}`).send({ notas: 'Nota de prueba' });
    expect(res.status).toBe(200);
    expect(res.body.notas).toBe('Nota de prueba');
  });

  test('PUT campo no permitido (strict) → 400', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    const res = await ag.put(`/api/contable/proveedores/${proveedorId}`).send({ campo_invalido: 'x' });
    expect(res.status).toBe(400);
  });
});

// ── Facturas ──────────────────────────────────────────────────────────────────
describe('Facturas — Validación Zod', () => {
  test('POST body vacío → 400', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    expect((await ag.post('/api/contable/facturas').send({})).status).toBe(400);
  });
  test('POST monto negativo → 400', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    const res = await ag.post('/api/contable/facturas').send({
      proveedor_id: proveedorId, monto: -500,
      fecha_recibida: '2026-09-01', fecha_vencimiento: '2026-09-30',
    });
    expect(res.status).toBe(400);
  });
  test('POST proveedor_id no-uuid → 400', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    const res = await ag.post('/api/contable/facturas').send({
      proveedor_id: 'no-es-uuid', monto: 100000,
      fecha_recibida: '2026-09-01', fecha_vencimiento: '2026-09-30',
    });
    expect(res.status).toBe(400);
  });
  test('POST retenciones >= monto → 400', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    const res = await ag.post('/api/contable/facturas').send({
      proveedor_id: proveedorId, monto: 100000,
      retencion_fuente: 60000, retencion_ica: 40000,
      fecha_recibida: '2026-09-01', fecha_vencimiento: '2026-09-30',
    });
    expect(res.status).toBe(400);
  });
});

describe('Facturas — registro y visibilidad completa', () => {
  test('POST /contable/facturas → 201, estado pendiente_aprobacion', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    const res = await ag.post('/api/contable/facturas').send({
      proveedor_id:      proveedorId,
      monto:             250000,
      fecha_recibida:    '2026-09-01',
      fecha_vencimiento: '2026-09-28',
      numero_factura:    'FAC-CTB-001',
      area_responsable:  'Sistemas',
      descripcion:       'Factura contable test',
    });
    expect(res.status).toBe(201);
    expect(res.body.estado).toBe('pendiente_aprobacion');
    expect(res.body.numero_factura).toBe('FAC-CTB-001');
    facturaId = res.body.id;
  });

  test('GET /contable/facturas → incluye factura en estado pendiente', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    const res = await ag.get('/api/contable/facturas');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(f => f.id === facturaId)).toBe(true);
  });

  test('GET /contable/facturas?estado=pendiente_aprobacion → incluye la factura', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    const res = await ag.get('/api/contable/facturas?estado=pendiente_aprobacion');
    expect(res.status).toBe(200);
    expect(res.body.some(f => f.id === facturaId)).toBe(true);
  });

  test('GET /contable/facturas?estado=aprobada → no incluye la factura (aún pendiente)', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    const res = await ag.get('/api/contable/facturas?estado=aprobada');
    expect(res.status).toBe(200);
    expect(res.body.some(f => f.id === facturaId)).toBe(false);
  });

  test('GET /contable/facturas/:id → datos enriquecidos correctos', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    const res = await ag.get(`/api/contable/facturas/${facturaId}`);
    expect(res.status).toBe(200);
    expect(res.body.proveedor_nombre).toBe('Proveedor Contable Test');
    expect(res.body.numero_factura).toBe('FAC-CTB-001');
    expect(res.body.area_responsable).toBe('Sistemas');
    expect(res.body.estado).toBe('pendiente_aprobacion');
  });
});

// ── Retenciones ───────────────────────────────────────────────────────────────
describe('Facturas — retenciones', () => {
  let facturaRetId;

  afterAll(async () => {
    if (facturaRetId) await pool.query(`DELETE FROM tesoreria_facturas WHERE id = $1`, [facturaRetId]);
  });

  test('POST con retenciones → 201, monto_neto calculado correctamente', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    const res = await ag.post('/api/contable/facturas').send({
      proveedor_id:      proveedorId,
      monto:             500000,
      retencion_fuente:  17500,   // 3.5%
      retencion_ica:     5500,    // 1.1%
      retencion_iva:     0,
      fecha_recibida:    '2026-09-01',
      fecha_vencimiento: '2026-09-30',
      descripcion:       'Factura con retenciones',
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.retencion_fuente)).toBe(17500);
    expect(Number(res.body.retencion_ica)).toBe(5500);
    expect(Number(res.body.monto_neto)).toBe(477000);  // 500000 - 17500 - 5500
    facturaRetId = res.body.id;
  });

  test('GET factura retención → monto_neto presente', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    const res = await ag.get(`/api/contable/facturas/${facturaRetId}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.monto_neto)).toBe(477000);
  });
});

// ── Reenvío tras rechazo ──────────────────────────────────────────────────────
describe('Facturas — reenvío tras rechazo', () => {
  let uuidCiLocal;

  beforeAll(async () => {
    const hash = await bcrypt.hash(PASS, 4);
    const { rows: [ci] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
       VALUES ('CI Contable Test', 'ci-contable-test@kernel.test', $1, 'control_interno', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
       RETURNING id`,
      [hash]
    );
    uuidCiLocal = ci.id;
    await pool.query(
      `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
       SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'control_interno'
       ON CONFLICT DO NOTHING`,
      [uuidCiLocal]
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM tesoreria_facturas WHERE descripcion = 'Factura para reenviar'`);
    await pool.query(`DELETE FROM permisos        WHERE usuario_uuid = $1`, [uuidCiLocal]);
    await pool.query(`DELETE FROM global_usuarios WHERE id = $1`, [uuidCiLocal]);
  });

  test('PUT /reenviar en factura pendiente → 400 (solo rechazadas)', async () => {
    const ag = agentCtb(); await loginCtb(ag);
    const res = await ag.put(`/api/contable/facturas/${facturaId}/reenviar`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rechazada/i);
  });

  test('Flujo completo: registrar → aprobar área → rechazar CI → reenviar → pendiente_aprobacion', async () => {
    // 1. Registrar factura
    const agCtb = agentCtb(); await loginCtb(agCtb);
    const { body: f } = await agCtb.post('/api/contable/facturas').send({
      proveedor_id:      proveedorId,
      monto:             80000,
      fecha_recibida:    '2026-09-05',
      fecha_vencimiento: '2026-09-25',
      descripcion:       'Factura para reenviar',
    });
    expect(f.estado).toBe('pendiente_aprobacion');
    const fId = f.id;

    // 2. Área responsable aprueba (responsable_id es NULL → cualquier autenticado puede aprobar)
    const aprobarRes = await agCtb.put(`/api/aprobaciones/${fId}/aprobar`);
    expect(aprobarRes.status).toBe(200);
    expect(aprobarRes.body.estado).toBe('aprobada');

    // 3. CI rechaza (estado requerido: 'aprobada')
    const agCi = request.agent(app);
    await agCi.post('/api/auth/login').send({ email: 'ci-contable-test@kernel.test', password: PASS });
    const rechRes = await agCi.put(`/api/control_interno/facturas/${fId}/rechazar`).send({ motivo: 'Falta soporte' });
    expect(rechRes.status).toBe(200);
    expect(rechRes.body.estado).toBe('rechazada');
    expect(rechRes.body.rechazo_motivo).toBe('Falta soporte');

    // 4. Contable reenvía
    const reenvioRes = await agCtb.put(`/api/contable/facturas/${fId}/reenviar`);
    expect(reenvioRes.status).toBe(200);
    expect(reenvioRes.body.estado).toBe('pendiente_aprobacion');
    expect(reenvioRes.body.rechazo_motivo).toBeNull();
    expect(reenvioRes.body.aprobado_por).toBeNull();

    // 5. Segunda vez en pendiente → no se puede reenviar
    const segundoRes = await agCtb.put(`/api/contable/facturas/${fId}/reenviar`);
    expect(segundoRes.status).toBe(400);
  });
});
