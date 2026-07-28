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

// ── Detalle de sincronización ─────────────────────────────────────────────────

describe('Asociados — detalle de sincronización', () => {
  let sincId;

  beforeAll(async () => {
    const { rows } = await pool.query(
      `SELECT id FROM sincronizaciones WHERE usuario_uuid = $1 ORDER BY created_at DESC LIMIT 1`,
      [adminUuid]
    );
    sincId = rows[0]?.id;
  });

  test('GET /api/asociados/sincronizaciones/:id → 200 con estructura de detalle', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get(`/api/asociados/sincronizaciones/${sincId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('nuevos');
    expect(res.body).toHaveProperty('retirados');
    expect(res.body).toHaveProperty('boletos_liberados');
    expect(Array.isArray(res.body.nuevos)).toBe(true);
    expect(Array.isArray(res.body.retirados)).toBe(true);
    expect(Array.isArray(res.body.boletos_liberados)).toBe(true);
  });

  test('GET /api/asociados/sincronizaciones/:id inexistente → 404', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/asociados/sincronizaciones/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  test('GET /api/asociados/sincronizaciones/:id sin token → 401', async () => {
    const res = await request(app).get(`/api/asociados/sincronizaciones/${sincId}`);
    expect(res.status).toBe(401);
  });
});

// ── Liberación de boletos en sync ─────────────────────────────────────────────

describe('Asociados — liberación de boletos en sync CSV', () => {
  let sorteoId;
  const codigoRetirado = '888888999';

  const csvConRetirado = [
    'codigo,apellido,nombre,direccion,movil,clase_cuota,empresa_dsto,nombre_empresa,ciudad',
    `${testCodigo},Torres,Test,Calle 1,3001234567,1,EMP01,Empresa Test,Pereira`,
    `${codigoRetirado},Gomez,Prueba,Calle 2,3009999999,2,EMP01,Empresa Test,Bogota`,
  ].join('\n');

  const csvSinRetirado = [
    'codigo,apellido,nombre,direccion,movil,clase_cuota,empresa_dsto,nombre_empresa,ciudad',
    `${testCodigo},Torres,Test,Calle 1,3001234567,1,EMP01,Empresa Test,Pereira`,
  ].join('\n');

  beforeAll(async () => {
    // Importar el asociado que luego se retirará
    await pool.query(
      `INSERT INTO asociados (codigo, apellido, nombre, direccion, movil, clase_cuota, empresa_dsto, nombre_empresa, ciudad)
       VALUES ($1,'Gomez','Prueba','Calle 2','3009999999','2','EMP01','Empresa Test','Bogota')
       ON CONFLICT (codigo) DO UPDATE SET is_active = true, fecha_retiro = NULL`,
      [codigoRetirado]
    );

    // Crear sorteo y boleto asignado a ese asociado
    const { rows: [s] } = await pool.query(
      `INSERT INTO sorteos (nombre, estado) VALUES ('Sorteo Sync Test', 'activo') RETURNING id`
    );
    sorteoId = s.id;

    await pool.query(
      `INSERT INTO boletos (numero, sorteo_id, asociado_codigo, estado, fecha_asignacion)
       VALUES (999, $1, $2, 'asignado', NOW())
       ON CONFLICT (numero, sorteo_id) DO UPDATE SET estado = 'asignado', asociado_codigo = $2`,
      [sorteoId, codigoRetirado]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM sorteo_logs    WHERE sorteo_id = $1',      [sorteoId]);
    await pool.query('DELETE FROM boletos        WHERE sorteo_id = $1',      [sorteoId]);
    await pool.query('DELETE FROM sorteos        WHERE id = $1',             [sorteoId]);
    await pool.query('DELETE FROM asociados      WHERE codigo = $1',         [codigoRetirado]);
    await pool.query('DELETE FROM sincronizaciones WHERE usuario_uuid = $1', [adminUuid]);
  });

  test('sync que incluye el asociado → boleto sigue asignado', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(csvConRetirado), 'con_retirado.csv');
    expect(res.status).toBe(200);
    expect(res.body.boletos_liberados).toBe(0);

    const { rows: [b] } = await pool.query(
      'SELECT estado FROM boletos WHERE numero = 999 AND sorteo_id = $1', [sorteoId]
    );
    expect(b.estado).toBe('asignado');
  });

  test('sync sin el asociado → boleto queda libre', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(csvSinRetirado), 'sin_retirado.csv');
    expect(res.status).toBe(200);
    expect(res.body.retirados).toBeGreaterThan(0);
    expect(res.body.boletos_liberados).toBeGreaterThan(0);

    const { rows: [b] } = await pool.query(
      'SELECT estado, asociado_codigo FROM boletos WHERE numero = 999 AND sorteo_id = $1', [sorteoId]
    );
    expect(b.estado).toBe('libre');
    expect(b.asociado_codigo).toBeNull();
  });

  test('log LIBERACION_POR_RETIRO_CSV registrado en sorteo_logs', async () => {
    const { rows } = await pool.query(
      `SELECT * FROM sorteo_logs WHERE sorteo_id = $1 AND accion = 'LIBERACION_POR_RETIRO_CSV'`,
      [sorteoId]
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].asociado_codigo).toBe(codigoRetirado);
    expect(rows[0].numero).toBe(999);
  });

  test('detalle del sync refleja retirado y boleto liberado', async () => {
    const ag = agent();
    await loginAdmin(ag);

    const { rows: [sinc] } = await pool.query(
      `SELECT id FROM sincronizaciones WHERE usuario_uuid = $1 ORDER BY created_at DESC LIMIT 1`,
      [adminUuid]
    );
    const res = await ag.get(`/api/asociados/sincronizaciones/${sinc.id}`);
    expect(res.status).toBe(200);

    const retiradoCodigos = res.body.retirados.map((r) => r.codigo);
    expect(retiradoCodigos).toContain(codigoRetirado);

    const boletosLiberados = res.body.boletos_liberados.map((b) => b.numero);
    expect(boletosLiberados).toContain(999);
  });

  test('sync idempotente → boletos ya libres no se cuentan de nuevo', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(csvSinRetirado), 'idem.csv');
    expect(res.status).toBe(200);
    expect(res.body.boletos_liberados).toBe(0);
  });
});
