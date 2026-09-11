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

// ── POST /admin/usuarios (crear) ──────────────────────────────────────────────

describe('Admin — crear usuario', () => {
  const nuevoEmail = 'admin-nuevo-test@kernel.test';
  let nuevoUuid;

  afterAll(async () => {
    if (nuevoUuid) {
      await pool.query('DELETE FROM admin_logs      WHERE usuario_uuid = $1', [nuevoUuid]);
      await pool.query('DELETE FROM permisos        WHERE usuario_uuid = $1', [nuevoUuid]);
      await pool.query('DELETE FROM global_usuarios WHERE id = $1', [nuevoUuid]);
    }
  });

  test('201 — crea usuario con campos válidos', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.post('/api/admin/usuarios').send({
      nombre:   'Nuevo Test User',
      email:    nuevoEmail,
      password: 'testpass123',
      rol:      'usuario',
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.email).toBe(nuevoEmail);
    expect(res.body.is_approved).toBe(true);
    nuevoUuid = res.body.id;
  });

  test('400 — body incompleto (falta password)', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.post('/api/admin/usuarios').send({
      nombre: 'Sin Pass',
      email:  'sinpass@kernel.test',
    });
    expect(res.status).toBe(400);
  });

  test('400 — password corta (< 8 chars)', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.post('/api/admin/usuarios').send({
      nombre:   'Pass Corta',
      email:    'passcorta@kernel.test',
      password: '1234',
      rol:      'usuario',
    });
    expect(res.status).toBe(400);
  });

  test('409 — email duplicado', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.post('/api/admin/usuarios').send({
      nombre:   'Duplicado',
      email:    nuevoEmail,
      password: 'testpass123',
      rol:      'usuario',
    });
    expect(res.status).toBe(409);
  });
});

// ── PATCH /admin/usuarios/:id (editar) ───────────────────────────────────────

describe('Admin — editar usuario', () => {
  test('200 — cambia nombre', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}`).send({ nombre: 'Target Editado' });
    expect(res.status).toBe(200);
    expect(res.body.nombre).toBe('Target Editado');
  });

  test('200 — devuelve campos completos', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}`).send({ nombre: 'Target Control Test' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('email');
    expect(res.body).toHaveProperty('rol');
    expect(res.body).toHaveProperty('is_active');
  });

  test('400 — body vacío (nada que actualizar)', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}`).send({});
    expect(res.status).toBe(400);
  });

  test('409 — email ya en uso por otro usuario', async () => {
    const ag = agent();
    await loginAdmin(ag);
    // Intentar asignar el email del admin al target
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}`).send({ email: adminEmail });
    expect(res.status).toBe(409);
  });

  test('404 — UUID inexistente', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.patch('/api/admin/usuarios/00000000-0000-0000-0000-000000000099')
      .send({ nombre: 'Ghost' });
    expect(res.status).toBe(404);
  });
});

// ── PATCH /admin/usuarios/:id/reactivar ──────────────────────────────────────

describe('Admin — reactivar usuario', () => {
  test('200 — reactiva usuario previamente desactivado', async () => {
    // Desactivar primero (target puede estar ya desactivado por el describe anterior)
    const ag = agent();
    await loginAdmin(ag);
    await ag.patch(`/api/admin/usuarios/${targetUuid}/desactivar`);
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}/reactivar`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', targetUuid);
  });

  test('is_active = true en DB tras reactivar', async () => {
    const { rows } = await pool.query(
      'SELECT is_active FROM global_usuarios WHERE id = $1',
      [targetUuid]
    );
    expect(rows[0].is_active).toBe(true);
  });
});

// ── PATCH /admin/usuarios/:id/password ───────────────────────────────────────

describe('Admin — resetear contraseña de usuario', () => {
  test('200 — cambia la contraseña', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}/password`)
      .send({ nueva_password: 'NuevaPass123' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', targetUuid);
  });

  test('400 — contraseña corta (< 8 chars)', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}/password`)
      .send({ nueva_password: '123' });
    expect(res.status).toBe(400);
  });

  test('400 — body vacío', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}/password`).send({});
    expect(res.status).toBe(400);
  });

  test('401 — sin autenticación', async () => {
    const res = await request(app)
      .patch(`/api/admin/usuarios/${targetUuid}/password`)
      .send({ nueva_password: 'NuevaPass123' });
    expect(res.status).toBe(401);
  });
});
