import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';

let app;
const adminEmail = 'busqueda-admin@kernel.test';
const adminPass  = 'testpass123';
let adminUuid;

const asocCodigo = '7777777777';
const empCodigo  = 'EMP_BSRCH';

const agent      = () => request.agent(app);
const loginAdmin = (ag) => ag.post('/api/auth/login').send({ email: adminEmail, password: adminPass });

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(adminPass, 4);

  const { rows: [admin] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Busqueda Admin', $1, $2, 'admin', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [adminEmail, hash]
  );
  adminUuid = admin.id;

  await pool.query(
    `INSERT INTO empresas (codigo, nombre, is_active)
     VALUES ($1, 'Empresa Búsqueda Test', true)
     ON CONFLICT (codigo) DO NOTHING`,
    [empCodigo]
  );

  await pool.query(
    `INSERT INTO asociados (codigo, nombre, apellido, empresa_dsto, nombre_empresa, is_active)
     VALUES ($1, 'BusquedaNombre', 'BusquedaApellido', $2, 'Empresa Búsqueda Test', true)
     ON CONFLICT (codigo) DO UPDATE SET nombre = 'BusquedaNombre', apellido = 'BusquedaApellido', is_active = true`,
    [asocCodigo, empCodigo]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM asociados       WHERE codigo = $1', [asocCodigo]);
  await pool.query('DELETE FROM empresas        WHERE codigo = $1', [empCodigo]);
  await pool.query('DELETE FROM global_usuarios WHERE id = $1',     [adminUuid]);
  await pool.end();
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('Búsqueda — auth', () => {
  test('GET /api/busqueda sin token → 401', async () => {
    const res = await request(app).get('/api/busqueda?q=test');
    expect(res.status).toBe(401);
  });
});

// ── Validación ────────────────────────────────────────────────────────────────

describe('Búsqueda — validación de query', () => {
  test('q de 1 carácter → devuelve arrays vacíos sin error', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/busqueda?q=a');
    expect(res.status).toBe(200);
    expect(res.body.asociados).toHaveLength(0);
    expect(res.body.empresas).toHaveLength(0);
    expect(res.body.sorteos).toHaveLength(0);
  });

  test('sin q → devuelve arrays vacíos', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/busqueda');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.asociados)).toBe(true);
  });
});

// ── Resultados ────────────────────────────────────────────────────────────────

describe('Búsqueda — resultados por entidad', () => {
  test('Buscar por nombre de asociado → aparece en asociados', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/busqueda?q=BusquedaNombre');
    expect(res.status).toBe(200);
    const encontrado = res.body.asociados.find((a) => a.codigo === asocCodigo);
    expect(encontrado).toBeDefined();
    expect(encontrado).toHaveProperty('nombre');
    expect(encontrado).toHaveProperty('apellido');
    expect(encontrado).toHaveProperty('is_active');
  });

  test('Buscar por apellido de asociado → aparece en asociados', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/busqueda?q=BusquedaApellido');
    expect(res.status).toBe(200);
    const encontrado = res.body.asociados.find((a) => a.codigo === asocCodigo);
    expect(encontrado).toBeDefined();
  });

  test('Buscar por código de asociado → aparece en asociados', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get(`/api/busqueda?q=${asocCodigo}`);
    expect(res.status).toBe(200);
    const encontrado = res.body.asociados.find((a) => a.codigo === asocCodigo);
    expect(encontrado).toBeDefined();
  });

  test('Buscar por nombre de empresa → aparece en empresas', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/busqueda?q=Búsqueda Test');
    expect(res.status).toBe(200);
    const encontrada = res.body.empresas.find((e) => e.codigo === empCodigo);
    expect(encontrada).toBeDefined();
    expect(encontrada).toHaveProperty('codigo');
    expect(encontrada).toHaveProperty('nombre');
    expect(encontrada).toHaveProperty('is_active');
  });

  test('Búsqueda sin coincidencias → arrays vacíos', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/busqueda?q=xzxzxzxz_inexistente');
    expect(res.status).toBe(200);
    expect(res.body.asociados).toHaveLength(0);
    expect(res.body.empresas).toHaveLength(0);
    expect(res.body.sorteos).toHaveLength(0);
  });

  test('Respuesta siempre tiene las tres claves', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/busqueda?q=test');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('asociados');
    expect(res.body).toHaveProperty('empresas');
    expect(res.body).toHaveProperty('sorteos');
    expect(Array.isArray(res.body.asociados)).toBe(true);
    expect(Array.isArray(res.body.empresas)).toBe(true);
    expect(Array.isArray(res.body.sorteos)).toBe(true);
  });

  test('Límite de resultados: asociados max 8, empresas max 5, sorteos max 4', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/busqueda?q=a');
    expect(res.status).toBe(200);
    expect(res.body.asociados.length).toBeLessThanOrEqual(8);
    expect(res.body.empresas.length).toBeLessThanOrEqual(5);
    expect(res.body.sorteos.length).toBeLessThanOrEqual(4);
  });
});
