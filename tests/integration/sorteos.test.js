import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';

let app;

// ── Credenciales de test ────────────────────────────────────────────────────
const adminEmail = 'sorteos-admin@kernel.test';
const adminPass  = 'testpass123';
let adminUuid;

const asocCodigo = '8888888888';
let sorteoId;
let solicitudId;

const agentAdmin   = () => request.agent(app);
const loginAdmin   = (ag) => ag.post('/api/auth/login').send({ email: adminEmail, password: adminPass });
const agentAsoc    = () => request.agent(app);
const loginAsoc    = (ag) => ag.post('/api/asociados/login').send({ codigo: asocCodigo, password: asocCodigo });

// ── Setup ───────────────────────────────────────────────────────────────────
beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(adminPass, 4);

  const { rows: [admin] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Sorteos Admin', $1, $2, 'admin', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [adminEmail, hash]
  );
  adminUuid = admin.id;

  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a
     WHERE m.nombre = 'sorteos'
     ON CONFLICT DO NOTHING`,
    [adminUuid]
  );

  // Empresa de test
  await pool.query(
    `INSERT INTO empresas (codigo, nombre, is_active)
     VALUES ('EMP_TEST', 'Empresa Test Sorteos', true)
     ON CONFLICT (codigo) DO NOTHING`
  );

  // Asociado de test con hash del propio código (como hace el import CSV)
  const hashAsoc = await bcrypt.hash(asocCodigo, 4);
  await pool.query(
    `INSERT INTO asociados (codigo, nombre, apellido, empresa_dsto, nombre_empresa, password_hash, is_active)
     VALUES ($1, 'Test', 'Asociado', 'EMP_TEST', 'Empresa Test Sorteos', $2, true)
     ON CONFLICT (codigo) DO UPDATE SET
       empresa_dsto = 'EMP_TEST', nombre_empresa = 'Empresa Test Sorteos',
       password_hash = EXCLUDED.password_hash, is_active = true`,
    [asocCodigo, hashAsoc]
  );
});

// ── Teardown ────────────────────────────────────────────────────────────────
afterAll(async () => {
  if (sorteoId) {
    await pool.query('DELETE FROM sorteo_ganadores  WHERE sorteo_id = $1', [sorteoId]);
    await pool.query('DELETE FROM sorteo_logs       WHERE sorteo_id = $1', [sorteoId]);
    await pool.query('DELETE FROM solicitudes_bono  WHERE sorteo_id = $1', [sorteoId]);
    await pool.query('DELETE FROM boletos           WHERE sorteo_id = $1', [sorteoId]);
    await pool.query('DELETE FROM sorteo_empresas   WHERE sorteo_id = $1', [sorteoId]);
    await pool.query('DELETE FROM sorteos           WHERE id = $1',        [sorteoId]);
  }
  await pool.query('DELETE FROM asociados        WHERE codigo = $1',       [asocCodigo]);
  await pool.query('DELETE FROM empresas         WHERE codigo = $1',       ['EMP_TEST']);
  await pool.query('DELETE FROM permisos         WHERE usuario_uuid = $1', [adminUuid]);
  await pool.query('DELETE FROM global_usuarios  WHERE id = $1',           [adminUuid]);
  await pool.end();
});

// ── Auth guard ──────────────────────────────────────────────────────────────
describe('Sorteos — sin token', () => {
  test('GET /api/sorteos → 401', async () => {
    const res = await request(app).get('/api/sorteos');
    expect(res.status).toBe(401);
  });
});

// ── CRUD sorteo ─────────────────────────────────────────────────────────────
describe('Sorteos — crear y listar', () => {
  test('POST /api/sorteos body inválido → 400', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.post('/api/sorteos').send({});
    expect(res.status).toBe(400);
  });

  test('POST /api/sorteos → 201 crea sorteo + 1000 boletos', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.post('/api/sorteos').send({ nombre: 'Bono Test Junio', descripcion: 'Test' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    sorteoId = res.body.id;

    const { rows } = await pool.query('SELECT COUNT(*) FROM boletos WHERE sorteo_id = $1', [sorteoId]);
    expect(Number(rows[0].count)).toBe(1000);
  });

  test('GET /api/sorteos → 200 array', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.get('/api/sorteos');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── Empresas ────────────────────────────────────────────────────────────────
describe('Sorteos — empresas', () => {
  test('POST /:id/empresas/:codigo → habilita empresa', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.post(`/api/sorteos/${sorteoId}/empresas/EMP_TEST`);
    expect(res.status).toBe(200);
    expect(res.body.habilitada).toBe(true);
  });

  test('POST /:id/empresas/:codigo → deshabilita empresa (toggle)', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    // ya está habilitada por el test anterior → esta llamada la deshabilita
    const res = await ag.post(`/api/sorteos/${sorteoId}/empresas/EMP_TEST`);
    expect(res.body.habilitada).toBe(false);
    // volver a habilitar para los tests siguientes
    await ag.post(`/api/sorteos/${sorteoId}/empresas/EMP_TEST`);
  });
});

// ── Boletos empleado ────────────────────────────────────────────────────────
describe('Sorteos — boletos (empleado)', () => {
  test('GET /:id/boletos → 200 array de 1000', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.get(`/api/sorteos/${sorteoId}/boletos`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1000);
  });

  test('POST /:id/boletos/asignar → 201', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.post(`/api/sorteos/${sorteoId}/boletos/asignar`)
      .send({ numero: 42, asociado_codigo: asocCodigo });
    expect(res.status).toBe(201);
    expect(res.body.estado).toBe('asignado');
  });

  test('POST /:id/boletos/asignar número ocupado → 409', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.post(`/api/sorteos/${sorteoId}/boletos/asignar`)
      .send({ numero: 42, asociado_codigo: asocCodigo });
    expect(res.status).toBe(409);
  });

  test('POST /:id/boletos/retirar → 200', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.post(`/api/sorteos/${sorteoId}/boletos/retirar`)
      .send({ numero: 42, motivo: 'Test retiro' });
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('libre');
  });
});

// ── Solicitudes portal ──────────────────────────────────────────────────────
describe('Sorteos — portal asociado', () => {
  test('GET /portal/activo → 200 con sorteo y disponibles', async () => {
    const ag = agentAsoc();
    await loginAsoc(ag);
    const res = await ag.get('/api/sorteos/portal/activo');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sorteo');
    expect(res.body).toHaveProperty('disponibles');
  });

  test('POST /portal/solicitar → 201 bloquea número', async () => {
    const ag = agentAsoc();
    await loginAsoc(ag);
    const res = await ag.post('/api/sorteos/portal/solicitar')
      .send({ numero: 100, sorteo_id: sorteoId });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    solicitudId = res.body.id;

    const { rows } = await pool.query(
      'SELECT estado FROM boletos WHERE numero = 100 AND sorteo_id = $1', [sorteoId]
    );
    expect(rows[0].estado).toBe('pendiente_adquisicion');
  });

  test('POST /portal/solicitar número bloqueado → 409', async () => {
    const ag = agentAsoc();
    await loginAsoc(ag);
    const res = await ag.post('/api/sorteos/portal/solicitar')
      .send({ numero: 100, sorteo_id: sorteoId });
    expect(res.status).toBe(409);
  });

  test('DELETE /portal/solicitudes/:sid → cancela y libera número', async () => {
    const ag = agentAsoc();
    await loginAsoc(ag);
    const res = await ag.delete(`/api/sorteos/portal/solicitudes/${solicitudId}`);
    expect(res.status).toBe(200);
    expect(res.body.cancelada).toBe(true);

    const { rows } = await pool.query(
      'SELECT estado FROM boletos WHERE numero = 100 AND sorteo_id = $1', [sorteoId]
    );
    expect(rows[0].estado).toBe('libre');
  });
});

// ── Flujo aprobación ────────────────────────────────────────────────────────
describe('Sorteos — flujo completo solicitud → aprobación', () => {
  let solId;

  test('Asociado solicita número 200', async () => {
    const ag = agentAsoc();
    await loginAsoc(ag);
    const res = await ag.post('/api/sorteos/portal/solicitar')
      .send({ numero: 200, sorteo_id: sorteoId });
    expect(res.status).toBe(201);
    solId = res.body.id;
  });

  test('GET /:id/solicitudes → lista pendiente', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.get(`/api/sorteos/${sorteoId}/solicitudes`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test('Empleado aprueba → boleto pasa a asignado', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.post(`/api/sorteos/${sorteoId}/solicitudes/${solId}/aprobar`)
      .send({ notas: 'Aprobado en test' });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      'SELECT estado FROM boletos WHERE numero = 200 AND sorteo_id = $1', [sorteoId]
    );
    expect(rows[0].estado).toBe('asignado');
  });

  test('Asociado solicita retiro del número 200', async () => {
    const ag = agentAsoc();
    await loginAsoc(ag);
    const res = await ag.post('/api/sorteos/portal/solicitar-retiro')
      .send({ numero: 200, sorteo_id: sorteoId });
    expect(res.status).toBe(201);
    solId = res.body.id;
  });

  test('Empleado aprueba retiro → boleto vuelve a libre', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.post(`/api/sorteos/${sorteoId}/solicitudes/${solId}/aprobar`)
      .send({});
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      'SELECT estado, asociado_codigo FROM boletos WHERE numero = 200 AND sorteo_id = $1', [sorteoId]
    );
    expect(rows[0].estado).toBe('libre');
    expect(rows[0].asociado_codigo).toBeNull();
  });
});

// ── Ganadores y logs ────────────────────────────────────────────────────────
describe('Sorteos — ganador y logs', () => {
  test('POST /:id/ganador número sin titular → 409', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.post(`/api/sorteos/${sorteoId}/ganador`).send({ numero: 500 });
    expect(res.status).toBe(409);
  });

  test('POST /:id/ganador número asignado → 201', async () => {
    // asignar número primero
    const ag = agentAdmin();
    await loginAdmin(ag);
    await ag.post(`/api/sorteos/${sorteoId}/boletos/asignar`)
      .send({ numero: 777, asociado_codigo: asocCodigo });

    const res = await ag.post(`/api/sorteos/${sorteoId}/ganador`).send({ numero: 777 });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('nombre_completo');
  });

  test('GET /:id/ganadores → 200 array', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.get(`/api/sorteos/${sorteoId}/ganadores`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test('GET /:id/logs → 200 array con entradas', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.get(`/api/sorteos/${sorteoId}/logs`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });
});

// ── Sorteo pausado ──────────────────────────────────────────────────────────
describe('Sorteos — pausar', () => {
  test('PUT /:id/estado → pausa el sorteo', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.put(`/api/sorteos/${sorteoId}/estado`);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('pausado');
  });

  test('Asignar directo con sorteo pausado → 409', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.post(`/api/sorteos/${sorteoId}/boletos/asignar`)
      .send({ numero: 300, asociado_codigo: asocCodigo });
    expect(res.status).toBe(409);
  });

  test('Portal solicitar con sorteo pausado → 409', async () => {
    const ag = agentAsoc();
    await loginAsoc(ag);
    const res = await ag.post('/api/sorteos/portal/solicitar')
      .send({ numero: 300, sorteo_id: sorteoId });
    expect(res.status).toBe(409);
  });

  test('PUT /:id/estado → reactiva el sorteo', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.put(`/api/sorteos/${sorteoId}/estado`);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('activo');
  });
});
