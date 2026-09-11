import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';
import { jest } from '@jest/globals';

jest.setTimeout(30000);

let app;

const EMAIL = 'contable-extras-test@kernel.test';
const PASS  = 'testpass123';
let userUuid;

let proveedorId, categoriaId, periodoId;

const agente = () => request.agent(app);
const login  = (ag) => ag.post('/api/auth/login').send({ email: EMAIL, password: PASS });

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(PASS, 4);

  const { rows: [u] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Contable Extras Test', $1, $2, 'contable', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL, hash]
  );
  userUuid = u.id;

  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'contable'
     ON CONFLICT DO NOTHING`,
    [userUuid]
  );

  // Proveedor vía API para que genere historial automáticamente
  const ag = agente();
  await login(ag);
  const { body: prov } = await ag.post('/api/contable/proveedores').send({
    nombre: 'Proveedor Extras Test',
    tipo_pago: 'recurrente',
    frecuencia: 'mensual',
    categoria: 'Utilities',
  });
  proveedorId = prov.id;
});

afterAll(async () => {
  if (periodoId) {
    await pool.query('DELETE FROM tesoreria_periodos WHERE id = $1', [periodoId]);
  }
  if (categoriaId) {
    await pool.query('DELETE FROM tesoreria_categorias WHERE id = $1', [categoriaId]);
  }
  await pool.query('DELETE FROM tesoreria_proveedores_historial WHERE proveedor_id = $1', [proveedorId]);
  await pool.query('DELETE FROM tesoreria_proveedores WHERE id = $1', [proveedorId]);
  await pool.query('DELETE FROM permisos        WHERE usuario_uuid = $1', [userUuid]);
  await pool.query('DELETE FROM global_usuarios WHERE id = $1',           [userUuid]);
  await pool.end();
});

// ── Auth guards ────────────────────────────────────────────────────────────────
describe('Auth', () => {
  test('GET /contable/categorias sin token → 401', async () => {
    expect((await request(app).get('/api/contable/categorias')).status).toBe(401);
  });
  test('GET /contable/periodos sin token → 401', async () => {
    expect((await request(app).get('/api/contable/periodos')).status).toBe(401);
  });
  test('GET /contable/proveedores/:id/perfil sin token → 401', async () => {
    expect((await request(app).get(`/api/contable/proveedores/${proveedorId}/perfil`)).status).toBe(401);
  });
  test('GET /contable/proveedores/:id/historial sin token → 401', async () => {
    expect((await request(app).get(`/api/contable/proveedores/${proveedorId}/historial`)).status).toBe(401);
  });
});

// ── Perfil de proveedor (ruta /contable) ───────────────────────────────────────
describe('GET /contable/proveedores/:id/perfil', () => {
  test('proveedor inexistente → 404', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get('/api/contable/proveedores/00000000-0000-0000-0000-000000000000/perfil');
    expect(res.status).toBe(404);
  });

  test('→ 200 con proveedor + stats + facturas', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get(`/api/contable/proveedores/${proveedorId}/perfil`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('proveedor');
    expect(res.body).toHaveProperty('stats');
    expect(res.body).toHaveProperty('facturas');
    expect(res.body.proveedor.id).toBe(proveedorId);
    expect(res.body.proveedor.nombre).toBe('Proveedor Extras Test');
  });

  test('stats refleja proveedor sin facturas correctamente', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get(`/api/contable/proveedores/${proveedorId}/perfil`);
    expect(res.body.stats.total_facturas).toBe(0);
    expect(Number(res.body.stats.total_pagado)).toBe(0);
    expect(Number(res.body.stats.total_en_curso)).toBe(0);
    expect(Array.isArray(res.body.facturas)).toBe(true);
    expect(res.body.facturas).toHaveLength(0);
  });
});

// ── Historial de proveedor (ruta /contable) ────────────────────────────────────
describe('GET /contable/proveedores/:id/historial', () => {
  test('→ 200 array con entrada de creación', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get(`/api/contable/proveedores/${proveedorId}/historial`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body.some(h => h.tipo_cambio === 'creacion')).toBe(true);
    expect(res.body[0]).toHaveProperty('cambiado_por_nombre');
  });

  test('actualizar proveedor agrega entrada de actualización', async () => {
    const ag = agente(); await login(ag);
    await ag.put(`/api/contable/proveedores/${proveedorId}`).send({ notas: 'Nota extras test' });
    const res = await ag.get(`/api/contable/proveedores/${proveedorId}/historial`);
    expect(res.status).toBe(200);
    expect(res.body.some(h => h.tipo_cambio === 'actualizacion')).toBe(true);
    expect(res.body[0].tipo_cambio).toBe('actualizacion');
  });
});

// ── Categorías vía /contable ───────────────────────────────────────────────────
describe('Categorías vía /contable — Validación Zod', () => {
  test('POST body vacío → 400', async () => {
    const ag = agente(); await login(ag);
    expect((await ag.post('/api/contable/categorias').send({})).status).toBe(400);
  });

  test('POST tipo inválido → 400', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/contable/categorias').send({ nombre: 'X', tipo: 'otro' });
    expect(res.status).toBe(400);
  });

  test('POST color con formato inválido → 400', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/contable/categorias').send({ nombre: 'X', tipo: 'egreso', color: 'rojo' });
    expect(res.status).toBe(400);
  });
});

describe('Categorías vía /contable — CRUD', () => {
  test('POST → 201 crea categoría de egreso', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/contable/categorias').send({
      nombre: 'Contable Extras Cat Test',
      tipo: 'egreso',
      color: '#6366f1',
    });
    expect(res.status).toBe(201);
    expect(res.body.tipo).toBe('egreso');
    expect(res.body.nombre).toBe('Contable Extras Cat Test');
    expect(res.body.is_active).toBe(true);
    categoriaId = res.body.id;
  });

  test('GET /contable/categorias → 200 array incluye la creada', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get('/api/contable/categorias');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(c => c.id === categoriaId)).toBe(true);
  });

  test('GET /contable/categorias?tipo=egreso → filtra por tipo', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get('/api/contable/categorias?tipo=egreso');
    expect(res.status).toBe(200);
    expect(res.body.every(c => c.tipo === 'egreso')).toBe(true);
    expect(res.body.some(c => c.id === categoriaId)).toBe(true);
  });

  test('GET /contable/categorias?tipo=ingreso → no incluye la categoría de egreso', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get('/api/contable/categorias?tipo=ingreso');
    expect(res.status).toBe(200);
    expect(res.body.some(c => c.id === categoriaId)).toBe(false);
  });

  test('PUT /contable/categorias/:id → 200 actualiza color', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.put(`/api/contable/categorias/${categoriaId}`).send({ color: '#ef4444' });
    expect(res.status).toBe(200);
    expect(res.body.color).toBe('#ef4444');
  });

  test('PUT campo no permitido (strict) → 400', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.put(`/api/contable/categorias/${categoriaId}`).send({ tipo: 'ingreso' });
    expect(res.status).toBe(400);
  });

  test('PUT /contable/categorias/:id → desactiva categoría', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.put(`/api/contable/categorias/${categoriaId}`).send({ is_active: false });
    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(false);
  });

  test('Categoría inactiva no aparece en GET /contable/categorias', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get('/api/contable/categorias');
    expect(res.status).toBe(200);
    expect(res.body.some(c => c.id === categoriaId)).toBe(false);
  });
});

// ── Períodos vía /contable ─────────────────────────────────────────────────────
describe('Períodos vía /contable — Validación Zod', () => {
  test('POST body vacío → 400', async () => {
    const ag = agente(); await login(ag);
    expect((await ag.post('/api/contable/periodos').send({})).status).toBe(400);
  });

  test('POST fecha con formato incorrecto → 400', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/contable/periodos').send({
      nombre: 'Test',
      fecha_inicio: '01-10-2026',
      fecha_fin: '31-10-2026',
    });
    expect(res.status).toBe(400);
  });
});

describe('Períodos vía /contable — CRUD', () => {
  test('POST → 201 crea período en estado abierto', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/contable/periodos').send({
      nombre: 'Octubre 2026 Extras Test',
      fecha_inicio: '2026-10-01',
      fecha_fin: '2026-10-31',
    });
    expect(res.status).toBe(201);
    expect(res.body.estado).toBe('abierto');
    expect(res.body.nombre).toBe('Octubre 2026 Extras Test');
    periodoId = res.body.id;
  });

  test('GET /contable/periodos → 200 incluye el período creado', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get('/api/contable/periodos');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(p => p.id === periodoId)).toBe(true);
  });

  test('GET /contable/periodos incluye total_movimientos', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get('/api/contable/periodos');
    const periodo = res.body.find(p => p.id === periodoId);
    expect(periodo).toHaveProperty('total_movimientos');
    expect(Number(periodo.total_movimientos)).toBe(0);
  });

  test('PUT /contable/periodos/:id/cerrar → 200 cierra período', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.put(`/api/contable/periodos/${periodoId}/cerrar`);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('cerrado');
    expect(res.body).toHaveProperty('cerrado_por');
    expect(res.body).toHaveProperty('cerrado_at');
  });

  test('PUT /contable/periodos/:id/cerrar período ya cerrado → 400', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.put(`/api/contable/periodos/${periodoId}/cerrar`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cerrado/i);
  });

  test('PUT /contable/periodos/:id/cerrar período inexistente → 404', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.put('/api/contable/periodos/00000000-0000-0000-0000-000000000000/cerrar');
    expect(res.status).toBe(404);
  });
});
