import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';

let app;

const EMAIL = 'tesoreria-test@kernel.test';
const PASS  = 'testpass123';
let userUuid;

// IDs creados durante los tests
let cuentaId, cuentaSecundariaId, categoriaId, periodoId, movimientoId;

const agent  = () => request.agent(app);
const login  = (ag) => ag.post('/api/auth/login').send({ email: EMAIL, password: PASS });

// ── Setup ───────────────────────────────────────────────────────────────────
beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(PASS, 4);

  const { rows: [u] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Tesorera Test', $1, $2, 'tesorera', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL, hash]
  );
  userUuid = u.id;

  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a
     WHERE m.nombre = 'tesoreria'
     ON CONFLICT DO NOTHING`,
    [userUuid]
  );
});

// ── Teardown ────────────────────────────────────────────────────────────────
afterAll(async () => {
  if (movimientoId) {
    await pool.query('DELETE FROM tesoreria_movimientos WHERE id = $1', [movimientoId]);
  }
  if (periodoId) {
    await pool.query('DELETE FROM tesoreria_periodos WHERE id = $1', [periodoId]);
  }
  if (categoriaId) {
    await pool.query('DELETE FROM tesoreria_categorias WHERE id = $1', [categoriaId]);
  }
  if (cuentaSecundariaId) {
    await pool.query('DELETE FROM tesoreria_cuentas WHERE id = $1', [cuentaSecundariaId]);
  }
  if (cuentaId) {
    await pool.query('DELETE FROM tesoreria_cuentas WHERE id = $1', [cuentaId]);
  }
  await pool.query('DELETE FROM permisos        WHERE usuario_uuid = $1', [userUuid]);
  await pool.query('DELETE FROM global_usuarios WHERE id = $1',           [userUuid]);
  await pool.end();
});

// ── Auth guard ───────────────────────────────────────────────────────────────
describe('Auth', () => {
  test('GET /api/tesoreria/cuentas sin token → 401', async () => {
    const res = await request(app).get('/api/tesoreria/cuentas');
    expect(res.status).toBe(401);
  });

  test('GET /api/tesoreria/movimientos sin token → 401', async () => {
    const res = await request(app).get('/api/tesoreria/movimientos');
    expect(res.status).toBe(401);
  });

  test('GET /api/tesoreria/dashboard sin token → 401', async () => {
    const res = await request(app).get('/api/tesoreria/dashboard');
    expect(res.status).toBe(401);
  });
});

// ── Cuentas ──────────────────────────────────────────────────────────────────
describe('Cuentas — Validación Zod', () => {
  test('POST /cuentas body vacío → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/cuentas').send({});
    expect(res.status).toBe(400);
  });

  test('POST /cuentas tipo inválido → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/cuentas').send({ nombre: 'X', tipo: 'efectivo' });
    expect(res.status).toBe(400);
  });
});

describe('Cuentas — CRUD', () => {
  test('POST /cuentas → 201 crea cuenta bancaria', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/cuentas').send({
      nombre: 'Bancolombia Test',
      tipo: 'banco',
      entidad: 'Bancolombia',
      numero: '****9999',
      saldo_inicial: 1000000,
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.tipo).toBe('banco');
    cuentaId = res.body.id;
  });

  test('POST /cuentas → 201 crea segunda cuenta (caja)', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/cuentas').send({ nombre: 'Caja Menor Test', tipo: 'caja' });
    expect(res.status).toBe(201);
    cuentaSecundariaId = res.body.id;
  });

  test('GET /cuentas → 200 array incluye cuenta creada', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.get('/api/tesoreria/cuentas');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(c => c.id === cuentaId)).toBe(true);
  });

  test('GET /cuentas/:id → 200 con saldo_actual', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.get(`/api/tesoreria/cuentas/${cuentaId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('saldo_actual');
    // saldo_actual = saldo_inicial (aún sin movimientos)
    expect(Number(res.body.saldo_actual)).toBe(1000000);
  });

  test('GET /cuentas/:id inexistente → 404', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.get('/api/tesoreria/cuentas/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  test('PUT /cuentas/:id → 200 actualiza nombre', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.put(`/api/tesoreria/cuentas/${cuentaId}`).send({ nombre: 'Bancolombia Test Actualizado' });
    expect(res.status).toBe(200);
    expect(res.body.nombre).toBe('Bancolombia Test Actualizado');
  });

  test('PUT /cuentas/:id campo extra (strict) → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.put(`/api/tesoreria/cuentas/${cuentaId}`).send({ tipo: 'caja' });
    expect(res.status).toBe(400);
  });

  test('PUT /cuentas/:id no acepta is_active (strict) → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.put(`/api/tesoreria/cuentas/${cuentaId}`).send({ is_active: false });
    expect(res.status).toBe(400);
  });
});

// ── Desactivación protegida de cuentas ───────────────────────────────────────
describe('Cuentas — Desactivación protegida', () => {
  const ADMIN_EMAIL = 'admin-desact-test@kernel.test';
  const ADMIN_PASS  = 'adminpass123';
  let adminUuid;
  let cuentaSinMovId;
  let cuentaConMovId;
  let movimientoDesactId;

  const agAdmin    = () => request.agent(app);
  const loginAdmin = (ag) => ag.post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASS });

  beforeAll(async () => {
    const hash = await bcrypt.hash(ADMIN_PASS, 4);
    const { rows: [u] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
       VALUES ('Admin Desact Test', $1, $2, 'admin', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
       RETURNING id`,
      [ADMIN_EMAIL, hash]
    );
    adminUuid = u.id;

    await pool.query(
      `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
       SELECT $1, m.id, a.id FROM modulos m, acciones a
       WHERE m.nombre = 'tesoreria'
       ON CONFLICT DO NOTHING`,
      [adminUuid]
    );

    const { rows: [c1] } = await pool.query(
      `INSERT INTO tesoreria_cuentas (nombre, tipo, saldo_inicial)
       VALUES ('Cuenta Sin Movimientos', 'caja', 0) RETURNING id`
    );
    cuentaSinMovId = c1.id;

    const { rows: [c2] } = await pool.query(
      `INSERT INTO tesoreria_cuentas (nombre, tipo, saldo_inicial)
       VALUES ('Cuenta Con Movimientos', 'banco', 1000000) RETURNING id`
    );
    cuentaConMovId = c2.id;

    const { rows: [m] } = await pool.query(
      `INSERT INTO tesoreria_movimientos (tipo, monto, fecha, descripcion, cuenta_id, origen)
       VALUES ('ingreso', 500000, NOW(), 'Movimiento de prueba para desactivación', $1, 'manual')
       RETURNING id`,
      [cuentaConMovId]
    );
    movimientoDesactId = m.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM tesoreria_movimientos WHERE id = $1',        [movimientoDesactId]);
    await pool.query('DELETE FROM tesoreria_cuentas     WHERE id = $1',        [cuentaConMovId]);
    await pool.query('DELETE FROM tesoreria_cuentas     WHERE id = $1',        [cuentaSinMovId]);
    await pool.query('DELETE FROM permisos              WHERE usuario_uuid = $1', [adminUuid]);
    await pool.query('DELETE FROM global_usuarios       WHERE id = $1',           [adminUuid]);
  });

  test('DELETE /cuentas/:id sin token → 401', async () => {
    const res = await request(app).delete(`/api/tesoreria/cuentas/${cuentaSinMovId}`);
    expect(res.status).toBe(401);
  });

  test('DELETE /cuentas/:id con tesorera (no admin) → 403', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.delete(`/api/tesoreria/cuentas/${cuentaSinMovId}`)
      .send({ confirmar: true, motivo: 'Motivo de prueba suficientemente largo' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/administrador/i);
  });

  test('DELETE /cuentas/:id sin confirmar → 400', async () => {
    const ag = agAdmin(); await loginAdmin(ag);
    const res = await ag.delete(`/api/tesoreria/cuentas/${cuentaSinMovId}`)
      .send({ motivo: 'Motivo válido largo suficiente' });
    expect(res.status).toBe(400);
  });

  test('DELETE /cuentas/:id sin motivo mínimo → 400', async () => {
    const ag = agAdmin(); await loginAdmin(ag);
    const res = await ag.delete(`/api/tesoreria/cuentas/${cuentaSinMovId}`)
      .send({ confirmar: true, motivo: 'corto' });
    expect(res.status).toBe(400);
  });

  test('DELETE /cuentas/:id con cuenta con movimientos → 409', async () => {
    const ag = agAdmin(); await loginAdmin(ag);
    const res = await ag.delete(`/api/tesoreria/cuentas/${cuentaConMovId}`)
      .send({ confirmar: true, motivo: 'Intentando borrar cuenta con movimientos para prueba' });
    expect(res.status).toBe(409);
    expect(res.body.movimientos).toBeGreaterThan(0);
  });

  test('DELETE /cuentas/:id sin movimientos → 200 borrado lógico', async () => {
    const ag = agAdmin(); await loginAdmin(ag);
    const res = await ag.delete(`/api/tesoreria/cuentas/${cuentaSinMovId}`)
      .send({ confirmar: true, motivo: 'Cuenta de prueba sin movimientos, puede desactivarse' });
    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(false);
  });

  test('Cuenta desactivada sigue en BD (borrado lógico)', async () => {
    const { rows } = await pool.query(
      `SELECT id, is_active FROM tesoreria_cuentas WHERE id = $1`, [cuentaSinMovId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_active).toBe(false);
  });

  test('DELETE /cuentas/:id ya inactiva → 409', async () => {
    const ag = agAdmin(); await loginAdmin(ag);
    const res = await ag.delete(`/api/tesoreria/cuentas/${cuentaSinMovId}`)
      .send({ confirmar: true, motivo: 'Intentar desactivar la misma cuenta dos veces' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ya está inactiva/i);
  });
});

// ── Categorías ───────────────────────────────────────────────────────────────
describe('Categorías — Validación Zod', () => {
  test('POST /categorias body vacío → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/categorias').send({});
    expect(res.status).toBe(400);
  });

  test('POST /categorias tipo inválido → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/categorias').send({ nombre: 'X', tipo: 'otro' });
    expect(res.status).toBe(400);
  });

  test('POST /categorias color inválido → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/categorias').send({ nombre: 'X', tipo: 'ingreso', color: 'rojo' });
    expect(res.status).toBe(400);
  });
});

describe('Categorías — CRUD', () => {
  test('POST /categorias → 201', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/categorias').send({
      nombre: 'Test ingreso especial',
      tipo: 'ingreso',
      color: '#34d399',
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    categoriaId = res.body.id;
  });

  test('GET /categorias → 200 array', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.get('/api/tesoreria/categorias');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Las categorías base del seed también deben estar
    expect(res.body.length).toBeGreaterThanOrEqual(13);
  });

  test('GET /categorias?tipo=ingreso → filtra por tipo', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.get('/api/tesoreria/categorias?tipo=ingreso');
    expect(res.status).toBe(200);
    expect(res.body.every(c => c.tipo === 'ingreso')).toBe(true);
  });

  test('PUT /categorias/:id campo extra (strict) → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.put(`/api/tesoreria/categorias/${categoriaId}`).send({ tipo: 'egreso' });
    expect(res.status).toBe(400);
  });

  test('PUT /categorias/:id → 200 actualiza nombre', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.put(`/api/tesoreria/categorias/${categoriaId}`).send({ nombre: 'Test ingreso especial v2' });
    expect(res.status).toBe(200);
    expect(res.body.nombre).toBe('Test ingreso especial v2');
  });
});

// ── Períodos ──────────────────────────────────────────────────────────────────
describe('Períodos — Validación Zod', () => {
  test('POST /periodos body vacío → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/periodos').send({});
    expect(res.status).toBe(400);
  });

  test('POST /periodos fecha con formato inválido → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/periodos').send({
      nombre: 'Sep 2026',
      fecha_inicio: '01-09-2026',
      fecha_fin: '30-09-2026',
    });
    expect(res.status).toBe(400);
  });
});

describe('Períodos — CRUD y cierre', () => {
  test('POST /periodos → 201', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/periodos').send({
      nombre: 'Septiembre 2026 Test',
      fecha_inicio: '2026-09-01',
      fecha_fin: '2026-09-30',
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.estado).toBe('abierto');
    periodoId = res.body.id;
  });

  test('GET /periodos → 200 array', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.get('/api/tesoreria/periodos');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(p => p.id === periodoId)).toBe(true);
  });

  test('PUT /periodos/:id/cerrar → 200 cierra período', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.put(`/api/tesoreria/periodos/${periodoId}/cerrar`);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('cerrado');
  });

  test('PUT /periodos/:id/cerrar ya cerrado → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.put(`/api/tesoreria/periodos/${periodoId}/cerrar`);
    expect(res.status).toBe(400);
  });
});

// ── Movimientos ───────────────────────────────────────────────────────────────
describe('Movimientos — Validación Zod', () => {
  test('POST /movimientos body vacío → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/movimientos').send({});
    expect(res.status).toBe(400);
  });

  test('POST /movimientos monto negativo → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/movimientos').send({
      tipo: 'ingreso', monto: -500, fecha: '2026-09-01', cuenta_id: cuentaId,
    });
    expect(res.status).toBe(400);
  });

  test('POST /movimientos tipo inválido → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/movimientos').send({
      tipo: 'donacion', monto: 100, fecha: '2026-09-01', cuenta_id: cuentaId,
    });
    expect(res.status).toBe(400);
  });

  test('POST /movimientos traslado sin cuenta_destino → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/movimientos').send({
      tipo: 'traslado', monto: 50000, fecha: '2026-09-01',
      cuenta_id: cuentaId, cuenta_destino_id: '',
    });
    expect(res.status).toBe(400);
  });

  test('POST /movimientos traslado misma cuenta origen/destino → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/movimientos').send({
      tipo: 'traslado', monto: 50000, fecha: '2026-09-01',
      cuenta_id: cuentaId, cuenta_destino_id: cuentaId,
    });
    expect(res.status).toBe(400);
  });
});

describe('Movimientos — CRUD', () => {
  test('POST /movimientos ingreso con campos opcionales vacíos → 201', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/movimientos').send({
      tipo: 'ingreso',
      monto: 500000,
      fecha: '2026-09-05',
      cuenta_id: cuentaId,
      descripcion: 'Ingreso de prueba',
      categoria_id: '',
      periodo_id: '',
      cuenta_destino_id: '',
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.tipo).toBe('ingreso');
    expect(Number(res.body.monto)).toBe(500000);
    movimientoId = res.body.id;
  });

  test('Saldo de cuenta refleja el ingreso registrado', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.get(`/api/tesoreria/cuentas/${cuentaId}`);
    expect(res.status).toBe(200);
    // saldo_inicial (1.000.000) + ingreso (500.000) = 1.500.000
    expect(Number(res.body.saldo_actual)).toBe(1500000);
  });

  test('POST /movimientos traslado entre cuentas → 201', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/movimientos').send({
      tipo: 'traslado',
      monto: 200000,
      fecha: '2026-09-06',
      cuenta_id: cuentaId,
      cuenta_destino_id: cuentaSecundariaId,
      descripcion: 'Traslado a caja test',
    });
    expect(res.status).toBe(201);
    expect(res.body.tipo).toBe('traslado');

    // Verificar que el saldo de la cuenta de origen bajó
    const resCuenta = await ag.get(`/api/tesoreria/cuentas/${cuentaId}`);
    // 1.500.000 - 200.000 = 1.300.000
    expect(Number(resCuenta.body.saldo_actual)).toBe(1300000);

    // Y el de la cuenta destino subió
    const resDest = await ag.get(`/api/tesoreria/cuentas/${cuentaSecundariaId}`);
    // saldo_inicial (0) + 200.000 = 200.000
    expect(Number(resDest.body.saldo_actual)).toBe(200000);

    // limpiar el traslado en teardown (registramos su id para borrarlo)
    await pool.query('DELETE FROM tesoreria_movimientos WHERE id = $1', [res.body.id]);
  });

  test('POST /movimientos en período cerrado → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/tesoreria/movimientos').send({
      tipo: 'ingreso',
      monto: 100000,
      fecha: '2026-09-10',
      cuenta_id: cuentaId,
      periodo_id: periodoId,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cerrado/i);
  });

  test('GET /movimientos → 200 array paginado', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.get('/api/tesoreria/movimientos');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('movimientos');
    expect(res.body).toHaveProperty('total');
    expect(Array.isArray(res.body.movimientos)).toBe(true);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  test('GET /movimientos?tipo=ingreso filtra correctamente', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.get('/api/tesoreria/movimientos?tipo=ingreso');
    expect(res.status).toBe(200);
    expect(res.body.movimientos.every(m => m.tipo === 'ingreso')).toBe(true);
  });

  test('GET /movimientos?cuenta_id filtra por cuenta', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.get(`/api/tesoreria/movimientos?cuenta_id=${cuentaId}`);
    expect(res.status).toBe(200);
    const todos = res.body.movimientos;
    expect(todos.every(m => m.cuenta_id === cuentaId || m.cuenta_destino_id === cuentaId)).toBe(true);
  });
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
describe('Dashboard', () => {
  test('GET /dashboard → 200 con estructura correcta', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.get('/api/tesoreria/dashboard');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cuentas');
    expect(res.body).toHaveProperty('flujo');
    expect(res.body).toHaveProperty('por_categoria');
    expect(res.body).toHaveProperty('ultimos_movimientos');
    expect(res.body).toHaveProperty('mes');
    expect(res.body.flujo).toHaveProperty('ingresos');
    expect(res.body.flujo).toHaveProperty('egresos');
  });

  test('GET /dashboard?mes=2026-09 → flujo del mes correcto', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.get('/api/tesoreria/dashboard?mes=2026-09');
    expect(res.status).toBe(200);
    expect(res.body.mes).toBe('2026-09');
    // El ingreso de 500.000 debe aparecer en ingresos del mes
    expect(Number(res.body.flujo.ingresos)).toBeGreaterThanOrEqual(500000);
  });
});
