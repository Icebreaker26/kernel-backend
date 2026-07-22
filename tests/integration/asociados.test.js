import request  from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool     from '../../src/db/database.js';
import bcrypt   from 'bcrypt';

let app;
const adminEmail  = 'asoc-admin@kernel.test';
const adminPass   = 'testpass123';
let adminUuid;
const testCodigo  = '9999999999';

const agent      = () => request.agent(app);
const loginAdmin = (ag) => ag.post('/api/auth/login').send({ email: adminEmail, password: adminPass });

const CSV_VALIDO = `codigo,apellido,nombre,direccion,movil,clase_cuota,empresa_dsto,nombre_empresa,ciudad
${testCodigo},Torres,Test,Calle 1,3001234567,1,EMP01,Empresa Test,Pereira`;

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(adminPass, 4);

  const { rows: [admin] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Asoc Admin', $1, $2, 'admin', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [adminEmail, hash]
  );
  adminUuid = admin.id;
  // admin rol bypasses checkPermission — no necesita entradas en permisos
});

afterAll(async () => {
  await pool.query('DELETE FROM asociados        WHERE codigo = $1',       [testCodigo]);
  await pool.query('DELETE FROM empresas         WHERE codigo = $1',       ['EMP01']);
  await pool.query('DELETE FROM sincronizaciones WHERE usuario_uuid = $1', [adminUuid]);
  await pool.query('DELETE FROM global_usuarios  WHERE id = $1',           [adminUuid]);
  await pool.end();
});

// ── CSV import ────────────────────────────────────────────────────────────────

describe('Asociados — importar CSV', () => {
  test('POST /api/asociados/importar sin archivo → 400', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.post('/api/asociados/importar');
    expect(res.status).toBe(400);
  });

  test('POST /api/asociados/importar CSV válido → 200 con contadores', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(CSV_VALIDO), 'test.csv');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('nuevos');
    expect(res.body).toHaveProperty('actualizados');
    expect(res.body).toHaveProperty('retirados');
    expect(res.body.nuevos + res.body.actualizados).toBeGreaterThan(0);
  });

  test('POST /api/asociados/importar segunda vez → actualizados (sin tocar portal_activo)', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(CSV_VALIDO), 'test2.csv');
    expect(res.status).toBe(200);
    expect(res.body.actualizados).toBeGreaterThan(0);

    // Verificar que el reimport no resetea portal_activo ni password_hash
    const { rows } = await pool.query(
      'SELECT portal_activo, password_hash FROM asociados WHERE codigo = $1',
      [testCodigo]
    );
    expect(rows[0].portal_activo).toBe(false);
    expect(rows[0].password_hash).toBeNull();
  });
});

// ── Listado admin ─────────────────────────────────────────────────────────────

describe('Asociados — listado admin', () => {
  test('GET /api/asociados sin token → 401', async () => {
    const res = await request(app).get('/api/asociados');
    expect(res.status).toBe(401);
  });

  test('GET /api/asociados autenticado → 200 array con portal_activo y primer_login', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/asociados');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const asoc = res.body.find((a) => a.codigo === testCodigo);
    expect(asoc).toBeDefined();
    expect(asoc).toHaveProperty('portal_activo', false);
    expect(asoc).toHaveProperty('primer_login',  false);
  });
});

// ── Portal opt-in ─────────────────────────────────────────────────────────────

describe('Asociados — portal opt-in', () => {
  let passwordGenerada;

  test('POST /api/asociados/login sin portal activo → 401', async () => {
    const res = await request(app)
      .post('/api/asociados/login')
      .send({ codigo: testCodigo, password: 'cualquier' });
    expect(res.status).toBe(401);
  });

  test('POST /api/asociados/:codigo/activar-portal → 200 + password', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.post(`/api/asociados/${testCodigo}/activar-portal`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('password');
    expect(typeof res.body.password).toBe('string');
    expect(res.body.password.length).toBeGreaterThan(0);
    passwordGenerada = res.body.password;

    // Verificar estado en DB
    const { rows } = await pool.query(
      'SELECT portal_activo, primer_login FROM asociados WHERE codigo = $1',
      [testCodigo]
    );
    expect(rows[0].portal_activo).toBe(true);
    expect(rows[0].primer_login).toBe(true);
  });

  test('POST /api/asociados/login con password generada → 200 + primer_login=true', async () => {
    const res = await request(app)
      .post('/api/asociados/login')
      .send({ codigo: testCodigo, password: passwordGenerada });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('codigo', testCodigo);
    expect(res.body).toHaveProperty('primer_login', true);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  test('GET /api/asociados/me autenticado → 200 + primer_login=true', async () => {
    const ag = agent();
    await ag.post('/api/asociados/login').send({ codigo: testCodigo, password: passwordGenerada });
    const res = await ag.get('/api/asociados/me');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('codigo', testCodigo);
    expect(res.body).toHaveProperty('primer_login', true);
  });

  test('PUT /api/asociados/password — contraseña actual incorrecta → 401', async () => {
    const ag = agent();
    await ag.post('/api/asociados/login').send({ codigo: testCodigo, password: passwordGenerada });
    const res = await ag.put('/api/asociados/password').send({
      password_actual: 'esto_no_es_la_clave',
      password_nueva:  'nuevaclave123',
    });
    expect(res.status).toBe(401);
  });

  test('PUT /api/asociados/password correcto → 200 + primer_login=false en DB', async () => {
    const ag = agent();
    await ag.post('/api/asociados/login').send({ codigo: testCodigo, password: passwordGenerada });
    const res = await ag.put('/api/asociados/password').send({
      password_actual: passwordGenerada,
      password_nueva:  'nuevaclave456',
    });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      'SELECT primer_login FROM asociados WHERE codigo = $1',
      [testCodigo]
    );
    expect(rows[0].primer_login).toBe(false);
  });

  test('POST /api/asociados/login con nueva contraseña → 200 + primer_login=false', async () => {
    const res = await request(app)
      .post('/api/asociados/login')
      .send({ codigo: testCodigo, password: 'nuevaclave456' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('primer_login', false);
  });

  test('POST /api/asociados/:codigo/activar-portal de nuevo → genera nueva password', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.post(`/api/asociados/${testCodigo}/activar-portal`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('password');
    expect(res.body.password).not.toBe(passwordGenerada); // diferente cada vez
  });

  test('POST /api/asociados/:codigo/desactivar-portal → 200 + acceso revocado', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.post(`/api/asociados/${testCodigo}/desactivar-portal`);
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      'SELECT portal_activo, password_hash FROM asociados WHERE codigo = $1',
      [testCodigo]
    );
    expect(rows[0].portal_activo).toBe(false);
    expect(rows[0].password_hash).toBeNull();
  });

  test('POST /api/asociados/login tras desactivar → 401', async () => {
    const res = await request(app)
      .post('/api/asociados/login')
      .send({ codigo: testCodigo, password: 'nuevaclave456' });
    expect(res.status).toBe(401);
  });
});

// ── Auth portal ───────────────────────────────────────────────────────────────

describe('Asociados — portal auth', () => {
  test('GET /api/asociados/me sin token → 401', async () => {
    const res = await request(app).get('/api/asociados/me');
    expect(res.status).toBe(401);
  });
});

// ── Auditoría ─────────────────────────────────────────────────────────────────

describe('Asociados — auditoría', () => {
  test('GET /api/asociados/sincronizaciones → 200 array', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/asociados/sincronizaciones');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });
});
