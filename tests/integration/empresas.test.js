import request  from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool     from '../../src/db/database.js';
import bcrypt   from 'bcrypt';

let app;
const adminEmail = 'emp-admin@kernel.test';
const adminPass  = 'testpass123';
let adminUuid;

const empCodigo  = 'EMP_TEST_FULL';
let notaId;

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

  await pool.query(
    `INSERT INTO empresas (codigo, nombre, is_active)
     VALUES ($1, 'Empresa Test Completa', true)
     ON CONFLICT (codigo) DO NOTHING`,
    [empCodigo]
  );

  // Asociado vinculado para que perfil y historial tengan datos
  await pool.query(
    `INSERT INTO asociados (codigo, nombre, apellido, empresa_dsto, nombre_empresa, is_active, valor_aporte, saldo_aporte)
     VALUES ('6666666666', 'TestEmp', 'Asociado', $1, 'Empresa Test Completa', true, 50000, 0)
     ON CONFLICT (codigo) DO UPDATE SET empresa_dsto = $1, is_active = true`,
    [empCodigo]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM empresa_notas   WHERE empresa_codigo = $1', [empCodigo]);
  await pool.query('DELETE FROM asociados       WHERE codigo = $1',         ['6666666666']);
  await pool.query('DELETE FROM empresas        WHERE codigo = $1',         [empCodigo]);
  await pool.query('DELETE FROM permisos        WHERE usuario_uuid = $1',   [adminUuid]);
  await pool.query('DELETE FROM global_usuarios WHERE id = $1',             [adminUuid]);
  await pool.end();
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('Empresas — sin token', () => {
  test('GET /api/empresas → 401', async () => {
    const res = await request(app).get('/api/empresas');
    expect(res.status).toBe(401);
  });

  test('GET /api/empresas/:codigo/perfil → 401', async () => {
    const res = await request(app).get(`/api/empresas/${empCodigo}/perfil`);
    expect(res.status).toBe(401);
  });
});

// ── Listado ───────────────────────────────────────────────────────────────────

describe('Empresas — listado', () => {
  test('GET /api/empresas autenticado → 200 array', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/empresas');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('Cada empresa tiene campos de listado y semáforo', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const { body } = await ag.get('/api/empresas');
    const emp = body.find((e) => e.codigo === empCodigo);
    expect(emp).toBeDefined();
    expect(emp).toHaveProperty('codigo');
    expect(emp).toHaveProperty('nombre');
    expect(emp).toHaveProperty('asociados_activos');
    expect(emp).toHaveProperty('mora_count');
    expect(emp).toHaveProperty('sum_aportes');
  });
});

// ── Perfil ────────────────────────────────────────────────────────────────────

describe('Empresas — perfil', () => {
  test('GET /api/empresas/:codigo/perfil → 200 con estructura completa', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.get(`/api/empresas/${empCodigo}/perfil`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('empresa');
    expect(res.body).toHaveProperty('stats');
    expect(res.body).toHaveProperty('asociados');
    expect(res.body).toHaveProperty('notas');
    expect(Array.isArray(res.body.asociados)).toBe(true);
    expect(Array.isArray(res.body.notas)).toBe(true);
  });

  test('Perfil incluye campos de contacto', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const { body } = await ag.get(`/api/empresas/${empCodigo}/perfil`);
    expect(body.empresa).toHaveProperty('contacto_nombre');
    expect(body.empresa).toHaveProperty('contacto_telefono');
    expect(body.empresa).toHaveProperty('contacto_email');
  });

  test('Perfil incluye stats con bonos_activos', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const { body } = await ag.get(`/api/empresas/${empCodigo}/perfil`);
    expect(body.stats).toHaveProperty('asociados_activos');
    expect(body.stats).toHaveProperty('mora_count');
    expect(body.stats).toHaveProperty('bonos_activos');
  });

  test('Empresa inexistente → 404', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/empresas/EMP_INEXISTENTE/perfil');
    expect(res.status).toBe(404);
  });
});

// ── Contacto ──────────────────────────────────────────────────────────────────

describe('Empresas — contacto', () => {
  test('PUT /api/empresas/:codigo/contacto → 200 con datos actualizados', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.put(`/api/empresas/${empCodigo}/contacto`).send({
      contacto_nombre:    'Juan Representante',
      contacto_telefono:  '3001234567',
      contacto_email:     'juan@empresa.com',
    });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('contacto_nombre',   'Juan Representante');
    expect(res.body).toHaveProperty('contacto_telefono', '3001234567');
    expect(res.body).toHaveProperty('contacto_email',    'juan@empresa.com');
  });

  test('Contacto actualizado persiste en perfil', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const { body } = await ag.get(`/api/empresas/${empCodigo}/perfil`);
    expect(body.empresa.contacto_nombre).toBe('Juan Representante');
    expect(body.empresa.contacto_email).toBe('juan@empresa.com');
  });

  test('PUT contacto con campos vacíos → guarda null correctamente', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.put(`/api/empresas/${empCodigo}/contacto`).send({
      contacto_nombre:   '',
      contacto_telefono: '',
      contacto_email:    '',
    });
    expect(res.status).toBe(200);
    expect(res.body.contacto_nombre).toBeNull();
  });

  test('PUT contacto empresa inexistente → 404', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.put('/api/empresas/EMP_INEXISTENTE/contacto').send({
      contacto_nombre: 'Test',
    });
    expect(res.status).toBe(404);
  });

  test('PUT contacto sin token → 401', async () => {
    const res = await request(app)
      .put(`/api/empresas/${empCodigo}/contacto`)
      .send({ contacto_nombre: 'Test' });
    expect(res.status).toBe(401);
  });
});

// ── Notas ─────────────────────────────────────────────────────────────────────

describe('Empresas — notas', () => {
  test('POST /api/empresas/:codigo/notas → 201 con nota creada', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.post(`/api/empresas/${empCodigo}/notas`).send({
      contenido: 'Nota de prueba para tests de integración',
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('contenido', 'Nota de prueba para tests de integración');
    expect(res.body).toHaveProperty('autor');
    notaId = res.body.id;
  });

  test('Nota creada aparece en el perfil', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const { body } = await ag.get(`/api/empresas/${empCodigo}/perfil`);
    const nota = body.notas.find((n) => n.id === notaId);
    expect(nota).toBeDefined();
    expect(nota.contenido).toBe('Nota de prueba para tests de integración');
  });

  test('POST nota con contenido vacío → 400', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.post(`/api/empresas/${empCodigo}/notas`).send({ contenido: '   ' });
    expect(res.status).toBe(400);
  });

  test('POST nota sin token → 401', async () => {
    const res = await request(app)
      .post(`/api/empresas/${empCodigo}/notas`)
      .send({ contenido: 'Hola' });
    expect(res.status).toBe(401);
  });

  test('DELETE /api/empresas/notas/:id → 200 borrado lógico', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.delete(`/api/empresas/notas/${notaId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
  });

  test('Nota eliminada no aparece en el perfil', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const { body } = await ag.get(`/api/empresas/${empCodigo}/perfil`);
    const nota = body.notas.find((n) => n.id === notaId);
    expect(nota).toBeUndefined();
  });

  test('DELETE nota inexistente → 404', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.delete('/api/empresas/notas/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});

// ── Historial mensual ─────────────────────────────────────────────────────────

describe('Empresas — historial mensual', () => {
  test('GET /api/empresas/:codigo/historial → 200 array de 12 meses', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const res = await ag.get(`/api/empresas/${empCodigo}/historial`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(12);
  });

  test('Cada mes tiene mes, label, asociados_activos y aporte_mensual', async () => {
    const ag  = agent();
    await loginAdmin(ag);
    const { body } = await ag.get(`/api/empresas/${empCodigo}/historial`);
    const ultimo = body[body.length - 1];
    expect(ultimo).toHaveProperty('mes');
    expect(ultimo).toHaveProperty('label');
    expect(ultimo).toHaveProperty('asociados_activos');
    expect(ultimo).toHaveProperty('aporte_mensual');
  });

  test('GET historial sin token → 401', async () => {
    const res = await request(app).get(`/api/empresas/${empCodigo}/historial`);
    expect(res.status).toBe(401);
  });
});
