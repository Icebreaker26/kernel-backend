import request  from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool     from '../../src/db/database.js';
import bcrypt   from 'bcrypt';

let app;
const adminEmail = 'emp-admin@kernel.test';
const adminPass  = 'testpass123';
let adminUuid;

const agent      = () => request.agent(app);
const loginAdmin = (ag) => ag.post('/api/auth/login').send({ email: adminEmail, password: adminPass });

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(adminPass, 4);

  const { rows: [admin] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Emp Admin', $1, $2, 'admin', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [adminEmail, hash]
  );
  adminUuid = admin.id;

  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a
     WHERE m.nombre = 'empresas'
     ON CONFLICT DO NOTHING`,
    [adminUuid]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM permisos        WHERE usuario_uuid = $1', [adminUuid]);
  await pool.query('DELETE FROM global_usuarios WHERE id = $1',           [adminUuid]);
});

describe('Empresas — sin token', () => {
  test('GET /api/empresas → 401', async () => {
    const res = await request(app).get('/api/empresas');
    expect(res.status).toBe(401);
  });
});

describe('Empresas — listado', () => {
  test('GET /api/empresas autenticado → 200 array', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/empresas');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('Cada empresa tiene codigo, nombre y asociados_activos', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const { body } = await ag.get('/api/empresas');
    if (body.length > 0) {
      expect(body[0]).toHaveProperty('codigo');
      expect(body[0]).toHaveProperty('nombre');
      expect(body[0]).toHaveProperty('asociados_activos');
    }
  });
});
