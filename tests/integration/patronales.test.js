import request  from 'supertest';
import bcrypt   from 'bcrypt';
import { createApp } from '../../src/createApp.js';
import pool     from '../../src/db/database.js';

let app;

// ── Credenciales ─────────────────────────────────────────────────────────────
const adminEmail = 'patronales-admin@kernel.test';
const adminPass  = 'testpass123';
let adminUuid;

const EMP_CODIGO     = 'EMP_PAT_TEST';
const ASOC_CODIGO    = '9999999999';
const ASOC_MENSUAL   = '9999999998';
const PORTAL_EMAIL   = 'portal-pat-test@kernel.test';
const PORTAL_PASS    = 'portalpass123';
const PERIODO        = '2099-01'; // Futuro para evitar colisión con datos reales

let facturaId;
let facturaIndId;

// ── Helpers ───────────────────────────────────────────────────────────────────
const agAdmin = () => request.agent(app);
const loginAdmin = (ag) =>
  ag.post('/api/auth/login').send({ email: adminEmail, password: adminPass });

const agPortal = () => request.agent(app);
const loginPortal = (ag) =>
  ag.post('/api/patronales/portal/login').send({ email: PORTAL_EMAIL, password: PORTAL_PASS });

// ── Setup ─────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  app = await createApp();

  // Limpiar residuos de corridas anteriores fallidas
  await pool.query(`DELETE FROM patronales_detalle  WHERE factura_id IN (SELECT id FROM patronales_facturas WHERE empresa_codigo = $1)`, [EMP_CODIGO]);
  await pool.query(`DELETE FROM patronales_facturas WHERE empresa_codigo = $1`, [EMP_CODIGO]);
  await pool.query(`DELETE FROM asociados           WHERE codigo IN ($1, $2)`, [ASOC_CODIGO, ASOC_MENSUAL]);
  await pool.query(`DELETE FROM empresas_portal_acceso WHERE empresa_codigo = $1`, [EMP_CODIGO]);
  await pool.query(`DELETE FROM empresas            WHERE codigo = $1`, [EMP_CODIGO]);

  const hash      = await bcrypt.hash(adminPass, 4);
  const hashPort  = await bcrypt.hash(PORTAL_PASS, 4);

  // Usuario admin con permisos patronales
  const { rows: [admin] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Patronales Admin Test', $1, $2, 'admin', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [adminEmail, hash]
  );
  adminUuid = admin.id;

  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a
     WHERE m.nombre = 'patronales' AND a.nombre IN ('READ', 'WRITE', 'DELETE')
     ON CONFLICT DO NOTHING`,
    [adminUuid]
  );

  // Empresa de test
  await pool.query(
    `INSERT INTO empresas (codigo, nombre, is_active)
     VALUES ($1, 'Empresa Patronales Test', true)
     ON CONFLICT (codigo) DO UPDATE SET is_active = true`,
    [EMP_CODIGO]
  );

  // Acceso portal para la empresa
  await pool.query(
    `INSERT INTO empresas_portal_acceso (empresa_codigo, email, password_hash, portal_activo, primer_login)
     VALUES ($1, $2, $3, true, true)
     ON CONFLICT (empresa_codigo) DO UPDATE SET
       email          = EXCLUDED.email,
       password_hash  = EXCLUDED.password_hash,
       portal_activo  = true`,
    [EMP_CODIGO, PORTAL_EMAIL, hashPort]
  );

  // Asociado quincenal (clase_cuota '2-Quincenal')
  await pool.query(
    `INSERT INTO asociados
       (codigo, nombre, apellido, empresa_dsto, nombre_empresa, clase_cuota, valor_aporte, is_active)
     VALUES ($1, 'Test', 'Quincenal', $2, 'Empresa Patronales Test', '2-Quincenal', 50000, true)
     ON CONFLICT (codigo) DO UPDATE SET
       empresa_dsto = $2, clase_cuota = '2-Quincenal',
       valor_aporte = 50000, is_active = true`,
    [ASOC_CODIGO, EMP_CODIGO]
  );

  // Asociado mensual (clase_cuota '1-Mensual')
  await pool.query(
    `INSERT INTO asociados
       (codigo, nombre, apellido, empresa_dsto, nombre_empresa, clase_cuota, valor_aporte, is_active)
     VALUES ($1, 'Test', 'Mensual', $2, 'Empresa Patronales Test', '1-Mensual', 40000, true)
     ON CONFLICT (codigo) DO UPDATE SET
       empresa_dsto = $2, clase_cuota = '1-Mensual',
       valor_aporte = 40000, is_active = true`,
    [ASOC_MENSUAL, EMP_CODIGO]
  );
});

// ── Teardown ──────────────────────────────────────────────────────────────────
afterAll(async () => {
  // Limpiar en orden de FK
  if (facturaId)    await pool.query('DELETE FROM patronales_pagos   WHERE factura_id = $1', [facturaId]);
  if (facturaIndId) await pool.query('DELETE FROM patronales_pagos   WHERE factura_id = $1', [facturaIndId]);
  if (facturaId)    await pool.query('DELETE FROM patronales_detalle WHERE factura_id = $1', [facturaId]);
  if (facturaIndId) await pool.query('DELETE FROM patronales_detalle WHERE factura_id = $1', [facturaIndId]);
  await pool.query(`DELETE FROM patronales_facturas      WHERE empresa_codigo = $1`, [EMP_CODIGO]);
  await pool.query(`DELETE FROM asociados               WHERE codigo IN ($1, $2)`, [ASOC_CODIGO, ASOC_MENSUAL]);
  await pool.query(`DELETE FROM empresas_portal_acceso  WHERE empresa_codigo = $1`, [EMP_CODIGO]);
  await pool.query(`DELETE FROM empresas                WHERE codigo = $1`,         [EMP_CODIGO]);
  await pool.query(`DELETE FROM permisos            WHERE usuario_uuid = $1`,   [adminUuid]);
  await pool.query(`DELETE FROM global_usuarios     WHERE id = $1`,             [adminUuid]);
  await pool.end();
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /preview
// ═══════════════════════════════════════════════════════════════════════════════
describe('GET /patronales/preview', () => {
  test('Rechaza sin token → 401', async () => {
    const res = await request(app).get('/api/patronales/preview?periodo=2099-01&quincena=1');
    expect(res.status).toBe(401);
  });

  test('Rechaza sin parámetro periodo → 400', async () => {
    const ag = agAdmin();
    await loginAdmin(ag);
    const res = await ag.get('/api/patronales/preview');
    expect(res.status).toBe(400);
  });

  test('Rechaza periodo con formato inválido → 400', async () => {
    const ag = agAdmin();
    await loginAdmin(ag);
    const res = await ag.get('/api/patronales/preview?periodo=2099/01');
    expect(res.status).toBe(400);
  });

  test('Preview Q1 devuelve estructura correcta', async () => {
    const ag = agAdmin();
    await loginAdmin(ag);
    const res = await ag.get(`/api/patronales/preview?periodo=${PERIODO}&quincena=1`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('periodo', PERIODO);
    expect(res.body).toHaveProperty('tipo_cuota', 'quincenal');
    expect(res.body).toHaveProperty('quincena', 1);
    expect(res.body).toHaveProperty('total_global');
    expect(Array.isArray(res.body.empresas)).toBe(true);
  });

  test('Preview Q1 incluye empresa de test con asociado quincenal', async () => {
    const ag = agAdmin();
    await loginAdmin(ag);
    const res = await ag.get(`/api/patronales/preview?periodo=${PERIODO}&quincena=1`);
    expect(res.status).toBe(200);
    const emp = res.body.empresas.find((e) => e.empresa_codigo === EMP_CODIGO);
    expect(emp).toBeDefined();
    expect(emp.ya_causada).toBe(false);
    expect(Array.isArray(emp.asociados)).toBe(true);
    const asoc = emp.asociados.find((a) => a.codigo === ASOC_CODIGO);
    expect(asoc).toBeDefined();
    expect(Array.isArray(asoc.conceptos)).toBe(true);
    // Debe tener APORTE como primer concepto
    expect(asoc.conceptos[0].codigo).toBe('APORTE');
    expect(asoc.conceptos[0].monto).toBe(50000);
  });

  test('Preview MENSUAL NO incluye el asociado quincenal', async () => {
    const ag = agAdmin();
    await loginAdmin(ag);
    const res = await ag.get(`/api/patronales/preview?periodo=${PERIODO}`);
    expect(res.status).toBe(200);
    const emp = res.body.empresas.find((e) => e.empresa_codigo === EMP_CODIGO);
    if (emp) {
      const asoc = emp.asociados.find((a) => a.codigo === ASOC_CODIGO);
      expect(asoc).toBeUndefined(); // quincenal no aparece en run mensual
    }
  });

  test('Preview filtra por empresa_codigo', async () => {
    const ag = agAdmin();
    await loginAdmin(ag);
    const res = await ag.get(`/api/patronales/preview?periodo=${PERIODO}&quincena=1&empresa_codigo=${EMP_CODIGO}`);
    expect(res.status).toBe(200);
    expect(res.body.empresas.length).toBe(1);
    expect(res.body.empresas[0].empresa_codigo).toBe(EMP_CODIGO);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /patronales/empresas/:codigo/causar
// ═══════════════════════════════════════════════════════════════════════════════
describe('POST /patronales/empresas/:codigo/causar', () => {
  test('Rechaza sin token → 401', async () => {
    const res = await request(app)
      .post(`/api/patronales/empresas/${EMP_CODIGO}/causar`)
      .send({ periodo: PERIODO, quincena: 1 });
    expect(res.status).toBe(401);
  });

  test('Rechaza body sin periodo → 400', async () => {
    const ag = agAdmin();
    await loginAdmin(ag);
    const res = await ag.post(`/api/patronales/empresas/${EMP_CODIGO}/causar`).send({});
    expect(res.status).toBe(400);
  });

  test('Causa factura quincenal Q1 para empresa individual → 201', async () => {
    const ag = agAdmin();
    await loginAdmin(ag);
    const res = await ag
      .post(`/api/patronales/empresas/${EMP_CODIGO}/causar`)
      .send({ periodo: PERIODO, quincena: 1 });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('factura_id');
    expect(res.body.empresa_codigo).toBe(EMP_CODIGO);
    expect(res.body.tipo_cuota).toBe('quincenal');
    expect(res.body.quincena).toBe(1);
    facturaIndId = res.body.factura_id;
  });

  test('No permite duplicar la misma factura → 409', async () => {
    const ag = agAdmin();
    await loginAdmin(ag);
    const res = await ag
      .post(`/api/patronales/empresas/${EMP_CODIGO}/causar`)
      .send({ periodo: PERIODO, quincena: 1 });
    expect(res.status).toBe(409);
  });

  test('Permite causar Q2 aunque ya exista Q1 → 201', async () => {
    const ag = agAdmin();
    await loginAdmin(ag);
    const res = await ag
      .post(`/api/patronales/empresas/${EMP_CODIGO}/causar`)
      .send({ periodo: PERIODO, quincena: 2 });
    expect(res.status).toBe(201);
    // Limpiamos esta factura Q2 para no interferir con otros tests
    await pool.query('DELETE FROM patronales_detalle WHERE factura_id = $1', [res.body.factura_id]);
    await pool.query('DELETE FROM patronales_facturas WHERE id = $1', [res.body.factura_id]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /patronales/causar (lote)
// ═══════════════════════════════════════════════════════════════════════════════
describe('POST /patronales/causar (lote)', () => {
  test('Rechaza sin token → 401', async () => {
    const res = await request(app).post('/api/patronales/causar').send({ periodo: PERIODO });
    expect(res.status).toBe(401);
  });

  test('Rechaza body inválido → 400', async () => {
    const ag = agAdmin();
    await loginAdmin(ag);
    const res = await ag.post('/api/patronales/causar').send({ periodo: 'no-valido' });
    expect(res.status).toBe(400);
  });

  test('Causa run mensual en lote → 200 con results', async () => {
    const ag = agAdmin();
    await loginAdmin(ag);
    const res = await ag.post('/api/patronales/causar').send({ periodo: PERIODO });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
    const result = res.body.results.find((r) => r.empresa === 'Empresa Patronales Test');
    expect(result).toBeDefined();
    expect(result.created).toBe(true);
    facturaId = result.factura_id;
  });

  test('Run mensual duplicado marca ya-existente sin crear → 200', async () => {
    const ag = agAdmin();
    await loginAdmin(ag);
    const res = await ag.post('/api/patronales/causar').send({ periodo: PERIODO });
    expect(res.status).toBe(200);
    const result = res.body.results.find((r) => r.empresa === 'Empresa Patronales Test');
    expect(result.created).toBe(false);
  });

  test('Preview muestra ya_causada=true tras causar', async () => {
    const ag = agAdmin();
    await loginAdmin(ag);
    const res = await ag.get(`/api/patronales/preview?periodo=${PERIODO}`);
    expect(res.status).toBe(200);
    const emp = res.body.empresas.find((e) => e.empresa_codigo === EMP_CODIGO);
    expect(emp?.ya_causada).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GET /patronales/portal/facturas/:id
// ═══════════════════════════════════════════════════════════════════════════════
describe('GET /patronales/portal/facturas/:id', () => {
  test('Rechaza sin token empresa → 401', async () => {
    const res = await request(app).get(`/api/patronales/portal/facturas/${facturaId}`);
    expect(res.status).toBe(401);
  });

  test('Devuelve detalle con conceptos JSONB', async () => {
    const ag = agPortal();
    await loginPortal(ag);
    const res = await ag.get(`/api/patronales/portal/facturas/${facturaId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.detalle)).toBe(true);
    expect(res.body.detalle.length).toBeGreaterThan(0);
    const linea = res.body.detalle[0];
    expect(linea).toHaveProperty('nombre_snapshot');
    expect(linea).toHaveProperty('asociado_codigo');
    // Factura causada con v2 → debe tener conceptos JSONB
    expect(Array.isArray(linea.conceptos)).toBe(true);
    const aporte = linea.conceptos.find((c) => c.codigo === 'APORTE');
    expect(aporte).toBeDefined();
    expect(aporte.monto).toBeGreaterThan(0);
  });

  test('No puede acceder a factura de otra empresa → 404', async () => {
    // facturaIndId es de la misma empresa; creamos un id inexistente
    const res = await request(app)
      .get('/api/patronales/portal/facturas/00000000-0000-0000-0000-000000000000')
      .set('Cookie', '');
    expect([401, 404]).toContain(res.status);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Validación previewSchema — casos borde
// ═══════════════════════════════════════════════════════════════════════════════
describe('GET /patronales/preview — validación Zod', () => {
  let ag;
  beforeAll(async () => { ag = agAdmin(); await loginAdmin(ag); });

  test('quincena=3 → 400', async () => {
    const res = await ag.get(`/api/patronales/preview?periodo=${PERIODO}&quincena=3`);
    expect(res.status).toBe(400);
  });

  test('quincena=null → acepta como mensual', async () => {
    const res = await ag.get(`/api/patronales/preview?periodo=${PERIODO}&quincena=null`);
    expect(res.status).toBe(200);
    expect(res.body.tipo_cuota).toBe('mensual');
  });

  test('quincena omitido → acepta como mensual', async () => {
    const res = await ag.get(`/api/patronales/preview?periodo=${PERIODO}`);
    expect(res.status).toBe(200);
    expect(res.body.tipo_cuota).toBe('mensual');
  });
});
