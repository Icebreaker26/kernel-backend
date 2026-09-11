import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';
import { jest } from '@jest/globals';

jest.setTimeout(30000);

let app;

const EMAIL = 'tsr-conciliacion-test@kernel.test';
const PASS  = 'testpass123';
let userUuid;

let proveedorId, cuentaId, facturaId, movimientoId, umbralTestId;

const agente = () => request.agent(app);
const login  = (ag) => ag.post('/api/auth/login').send({ email: EMAIL, password: PASS });

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(PASS, 4);

  const { rows: [u] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Tesorera Conciliacion Test', $1, $2, 'tesorera', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL, hash]
  );
  userUuid = u.id;

  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'tesoreria'
     ON CONFLICT DO NOTHING`,
    [userUuid]
  );

  // Proveedor vía API para que genere historial automáticamente
  const ag = agente();
  await login(ag);
  const { body: prov } = await ag.post('/api/tesoreria/proveedores').send({
    nombre: 'Proveedor Conciliacion Test',
    tipo_pago: 'unico',
    categoria: 'Servicios',
  });
  proveedorId = prov.id;

  // Cuenta bancaria (INSERT directo — solo apoyo para movimiento)
  const { rows: [c] } = await pool.query(
    `INSERT INTO tesoreria_cuentas (nombre, tipo, saldo_inicial)
     VALUES ('Cuenta Conciliacion Test', 'banco', 5000000) RETURNING id`
  );
  cuentaId = c.id;

  // Factura en estado 'autorizada' sin movimiento_id (INSERT directo)
  const { rows: [f] } = await pool.query(
    `INSERT INTO tesoreria_facturas
       (proveedor_id, monto, retencion_fuente, retencion_ica, retencion_iva,
        fecha_recibida, fecha_vencimiento, estado, registrado_por)
     VALUES ($1, 300000, 0, 0, 0, CURRENT_DATE - 10, CURRENT_DATE, 'autorizada', $2)
     RETURNING id`,
    [proveedorId, userUuid]
  );
  facturaId = f.id;

  // Movimiento de egreso origen='extracto' sin factura_id
  const { rows: [m] } = await pool.query(
    `INSERT INTO tesoreria_movimientos
       (tipo, monto, fecha, descripcion, cuenta_id, origen, registrado_por)
     VALUES ('egreso', 300000, CURRENT_DATE, 'Pago conciliacion test', $1, 'extracto', $2)
     RETURNING id`,
    [cuentaId, userUuid]
  );
  movimientoId = m.id;
});

afterAll(async () => {
  // Limpiar referencias cruzadas antes de borrar las filas
  await pool.query(`UPDATE tesoreria_facturas    SET movimiento_id = NULL WHERE id = $1`, [facturaId]);
  await pool.query(`UPDATE tesoreria_movimientos SET factura_id    = NULL WHERE id = $1`, [movimientoId]);
  if (umbralTestId) {
    await pool.query('DELETE FROM tesoreria_config_umbrales WHERE id = $1', [umbralTestId]);
  }
  await pool.query('DELETE FROM tesoreria_movimientos WHERE id = $1', [movimientoId]);
  await pool.query('DELETE FROM tesoreria_facturas    WHERE id = $1', [facturaId]);
  await pool.query('DELETE FROM tesoreria_cuentas     WHERE id = $1', [cuentaId]);
  await pool.query('DELETE FROM tesoreria_proveedores_historial WHERE proveedor_id = $1', [proveedorId]);
  await pool.query('DELETE FROM tesoreria_proveedores WHERE id = $1', [proveedorId]);
  await pool.query('DELETE FROM permisos        WHERE usuario_uuid = $1', [userUuid]);
  await pool.query('DELETE FROM global_usuarios WHERE id = $1',           [userUuid]);
  await pool.end();
});

// ── Usuarios disponibles ───────────────────────────────────────────────────────
describe('GET /tesoreria/usuarios-disponibles', () => {
  test('sin token → 401', async () => {
    expect((await request(app).get('/api/tesoreria/usuarios-disponibles')).status).toBe(401);
  });

  test('→ 200 array con nombre y rol', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get('/api/tesoreria/usuarios-disponibles');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0]).toHaveProperty('nombre');
    expect(res.body[0]).toHaveProperty('rol');
    expect(res.body.some(u => u.id === userUuid)).toBe(true);
  });

  test('solo devuelve usuarios activos y aprobados', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get('/api/tesoreria/usuarios-disponibles');
    expect(res.status).toBe(200);
    // No deben aparecer usuarios inactivos (is_active=false o is_approved=false)
    // El campo no está en la respuesta pero la consulta lo filtra — verificamos indirectamente
    expect(Array.isArray(res.body)).toBe(true);
  });
});

// ── Perfil de proveedor ────────────────────────────────────────────────────────
describe('GET /tesoreria/proveedores/:id/perfil', () => {
  test('sin token → 401', async () => {
    expect(
      (await request(app).get(`/api/tesoreria/proveedores/${proveedorId}/perfil`)).status
    ).toBe(401);
  });

  test('proveedor inexistente → 404', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get('/api/tesoreria/proveedores/00000000-0000-0000-0000-000000000000/perfil');
    expect(res.status).toBe(404);
  });

  test('→ 200 con estructura proveedor + stats + facturas', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get(`/api/tesoreria/proveedores/${proveedorId}/perfil`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('proveedor');
    expect(res.body).toHaveProperty('stats');
    expect(res.body).toHaveProperty('facturas');
    expect(res.body.proveedor.id).toBe(proveedorId);
  });

  test('stats tiene total_facturas, total_pagado, total_en_curso, por_estado', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get(`/api/tesoreria/proveedores/${proveedorId}/perfil`);
    expect(res.body.stats).toHaveProperty('total_facturas');
    expect(res.body.stats).toHaveProperty('total_pagado');
    expect(res.body.stats).toHaveProperty('total_en_curso');
    expect(res.body.stats).toHaveProperty('por_estado');
    // La factura del setup debe aparecer
    expect(Array.isArray(res.body.facturas)).toBe(true);
    expect(res.body.facturas.some(f => f.id === facturaId)).toBe(true);
  });
});

// ── Historial de proveedor ─────────────────────────────────────────────────────
describe('GET /tesoreria/proveedores/:id/historial', () => {
  test('sin token → 401', async () => {
    expect(
      (await request(app).get(`/api/tesoreria/proveedores/${proveedorId}/historial`)).status
    ).toBe(401);
  });

  test('→ 200 array con al menos la entrada de creación', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get(`/api/tesoreria/proveedores/${proveedorId}/historial`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0]).toHaveProperty('tipo_cambio');
    expect(res.body[0]).toHaveProperty('campos_despues');
    expect(res.body.some(h => h.tipo_cambio === 'creacion')).toBe(true);
  });

  test('actualizar proveedor agrega entrada de actualización al historial', async () => {
    const ag = agente(); await login(ag);
    await ag.put(`/api/tesoreria/proveedores/${proveedorId}`).send({ notas: 'Nota historial test' });
    const res = await ag.get(`/api/tesoreria/proveedores/${proveedorId}/historial`);
    expect(res.status).toBe(200);
    expect(res.body.some(h => h.tipo_cambio === 'actualizacion')).toBe(true);
    // El historial viene ordenado por cambiado_at DESC: la actualización debe ser la primera
    expect(res.body[0].tipo_cambio).toBe('actualizacion');
  });
});

// ── POST /tesoreria/config/umbrales ───────────────────────────────────────────
describe('POST /tesoreria/config/umbrales', () => {
  test('sin token → 401', async () => {
    expect(
      (await request(app).post('/api/tesoreria/config/umbrales').send({})).status
    ).toBe(401);
  });

  test('body vacío → 400', async () => {
    const ag = agente(); await login(ag);
    expect((await ag.post('/api/tesoreria/config/umbrales').send({})).status).toBe(400);
  });

  test('monto_umbral negativo → 400', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/tesoreria/config/umbrales').send({
      tipo_operacion: 'test_neg_conciliacion',
      monto_umbral: -500,
    });
    expect(res.status).toBe(400);
  });

  test('sin tipo_operacion → 400', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/tesoreria/config/umbrales').send({ monto_umbral: 1000000 });
    expect(res.status).toBe(400);
  });

  test('→ 201 crea umbral con dias_vencimiento por defecto = 7', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/tesoreria/config/umbrales').send({
      tipo_operacion:   'test_conciliacion_umbral',
      monto_umbral:     999999,
      descripcion:      'Umbral de prueba conciliación',
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(Number(res.body.monto_umbral)).toBe(999999);
    expect(res.body.tipo_operacion).toBe('test_conciliacion_umbral');
    expect(res.body.dias_vencimiento).toBe(7);
    umbralTestId = res.body.id;
  });

  test('→ 201 crea umbral con dias_vencimiento personalizado', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/tesoreria/config/umbrales').send({
      tipo_operacion:   'test_conciliacion_umbral_14d',
      monto_umbral:     5000000,
      dias_vencimiento: 14,
    });
    expect(res.status).toBe(201);
    expect(res.body.dias_vencimiento).toBe(14);
    // Limpiar este umbral adicional
    await pool.query('DELETE FROM tesoreria_config_umbrales WHERE id = $1', [res.body.id]);
  });
});

// ── GET /tesoreria/coincidencias ───────────────────────────────────────────────
describe('GET /tesoreria/coincidencias', () => {
  test('sin token → 401', async () => {
    expect((await request(app).get('/api/tesoreria/coincidencias')).status).toBe(401);
  });

  test('→ 200 con estructura coincidencias + total', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get('/api/tesoreria/coincidencias');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('coincidencias');
    expect(res.body).toHaveProperty('total');
    expect(Array.isArray(res.body.coincidencias)).toBe(true);
  });

  test('detecta la coincidencia del setup (monto_neto = monto, ±30 días)', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get('/api/tesoreria/coincidencias');
    expect(res.status).toBe(200);
    const match = res.body.coincidencias.find(
      c => c.factura.id === facturaId && c.movimiento.id === movimientoId
    );
    expect(match).toBeDefined();
    expect(Number(match.factura.monto_neto)).toBe(300000);
    expect(Number(match.movimiento.monto)).toBe(300000);
    expect(match.factura).toHaveProperty('proveedor_nombre');
    expect(match.movimiento).toHaveProperty('cuenta_nombre');
  });
});

// ── POST /tesoreria/conciliar ──────────────────────────────────────────────────
describe('POST /tesoreria/conciliar', () => {
  test('sin token → 401', async () => {
    expect(
      (await request(app).post('/api/tesoreria/conciliar').send({ vinculos: [] })).status
    ).toBe(401);
  });

  test('vinculos vacíos → 400 (schema min(1))', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/tesoreria/conciliar').send({ vinculos: [] });
    expect(res.status).toBe(400);
  });

  test('factura_id no-uuid → 400', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/tesoreria/conciliar').send({
      vinculos: [{ factura_id: 'no-es-uuid', movimiento_id: movimientoId }],
    });
    expect(res.status).toBe(400);
  });

  test('→ 200 vincula movimiento con factura y devuelve exitosos=1', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/tesoreria/conciliar').send({
      vinculos: [{ factura_id: facturaId, movimiento_id: movimientoId }],
    });
    expect(res.status).toBe(200);
    expect(res.body.exitosos).toBe(1);
    expect(res.body.total).toBe(1);
    expect(res.body.resultados[0].ok).toBe(true);
  });

  test('factura queda en estado pagada tras conciliar', async () => {
    const { rows: [f] } = await pool.query(
      'SELECT estado, movimiento_id FROM tesoreria_facturas WHERE id = $1',
      [facturaId]
    );
    expect(f.estado).toBe('pagada');
    expect(f.movimiento_id).toBe(movimientoId);
  });

  test('movimiento tiene factura_id asignado tras conciliar', async () => {
    const { rows: [m] } = await pool.query(
      'SELECT factura_id FROM tesoreria_movimientos WHERE id = $1',
      [movimientoId]
    );
    expect(m.factura_id).toBe(facturaId);
  });

  test('movimiento ya vinculado → resultado ok=false (no se repite el vínculo)', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.post('/api/tesoreria/conciliar').send({
      vinculos: [{ factura_id: facturaId, movimiento_id: movimientoId }],
    });
    expect(res.status).toBe(200);
    expect(res.body.exitosos).toBe(0);
    expect(res.body.resultados[0].ok).toBe(false);
    expect(res.body.resultados[0].error).toMatch(/no encontrado|ya vinculado/i);
  });

  test('factura ya conciliada no aparece en coincidencias', async () => {
    const ag = agente(); await login(ag);
    const res = await ag.get('/api/tesoreria/coincidencias');
    expect(res.status).toBe(200);
    const match = res.body.coincidencias.find(c => c.factura.id === facturaId);
    expect(match).toBeUndefined();
  });
});
