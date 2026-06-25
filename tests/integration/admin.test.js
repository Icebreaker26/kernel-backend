import request  from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool     from '../../src/db/database.js';
import bcrypt   from 'bcrypt';

let app;
const adminEmail = 'admin-test@kernel.test';
const adminPass  = 'testpass123';
let adminUuid;
let targetUuid;

const agent = () => request.agent(app);
const loginAdmin = (ag) => ag.post('/api/auth/login').send({ email: adminEmail, password: adminPass });

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(adminPass, 4);

  const { rows: [admin] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Admin Test', $1, $2, 'admin', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [adminEmail, hash]
  );
  adminUuid = admin.id;

  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a
     WHERE m.nombre = 'admin'
     ON CONFLICT DO NOTHING`,
    [adminUuid]
  );

  const { rows: [target] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Target User', 'admin-target@kernel.test', $1, 'usuario', true, false)
     ON CONFLICT (email) DO UPDATE SET is_approved = false
     RETURNING id`,
    [hash]
  );
  targetUuid = target.id;
});

afterAll(async () => {
  await pool.query('DELETE FROM admin_logs      WHERE usuario_uuid IN ($1,$2)', [adminUuid, targetUuid]);
  await pool.query('DELETE FROM permisos        WHERE usuario_uuid IN ($1,$2)', [adminUuid, targetUuid]);
  await pool.query('DELETE FROM global_usuarios WHERE id IN ($1,$2)',            [adminUuid, targetUuid]);
});

describe('Admin — sin token', () => {
  test('GET /api/admin/usuarios → 401', async () => {
    const res = await request(app).get('/api/admin/usuarios');
    expect(res.status).toBe(401);
  });
});

describe('Admin — usuarios', () => {
  test('GET /api/admin/usuarios → 200 array', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/admin/usuarios');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('PATCH /api/admin/usuarios/:id/aprobar → 200', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}/aprobar`);
    expect(res.status).toBe(200);
  });

  test('PATCH /api/admin/usuarios/:id/rol → 200', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}/rol`).send({ rol: 'comercial' });
    expect(res.status).toBe(200);
    expect(res.body.rol).toBe('comercial');
  });

  test('PATCH /api/admin/usuarios/:id/rol rol inválido → 400', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}/rol`).send({ rol: 'superusuario' });
    expect(res.status).toBe(400);
  });

  test('PATCH /api/admin/usuarios/:id/desactivar → 200', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}/desactivar`);
    expect(res.status).toBe(200);
  });
});

describe('Admin — permisos', () => {
  test('GET /api/admin/modulos → 200 array', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/admin/modulos');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/admin/usuarios/:id/permisos → 200', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.get(`/api/admin/usuarios/${targetUuid}/permisos`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('POST /api/admin/permisos/asignar-masivo → 200', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.post('/api/admin/permisos/asignar-masivo').send({
      usuario_uuid: targetUuid,
      permisos: [{ modulo: 'admin', acciones: ['READ'] }],
    });
    expect(res.status).toBe(200);
  });

  test('POST /api/admin/permisos/asignar-masivo body inválido → 400', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.post('/api/admin/permisos/asignar-masivo').send({});
    expect(res.status).toBe(400);
  });
});
