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

  // Asociado de test con portal activo directo (sin pasar por el flujo opt-in)
  const hashAsoc = await bcrypt.hash(asocCodigo, 4);
  await pool.query(
    `INSERT INTO asociados (codigo, nombre, apellido, empresa_dsto, nombre_empresa, password_hash, portal_activo, is_active)
     VALUES ($1, 'Test', 'Asociado', 'EMP_TEST', 'Empresa Test Sorteos', $2, true, true)
     ON CONFLICT (codigo) DO UPDATE SET
       empresa_dsto = 'EMP_TEST', nombre_empresa = 'Empresa Test Sorteos',
       password_hash = EXCLUDED.password_hash, portal_activo = true, is_active = true`,
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
  test('GET /portal/activo → 200 con array de sorteos', async () => {
    const ag = agentAsoc();
    await loginAsoc(ag);
    const res = await ag.get('/api/sorteos/portal/activo');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sorteos');
    expect(Array.isArray(res.body.sorteos)).toBe(true);
    expect(res.body.sorteos.length).toBeGreaterThan(0);
    expect(res.body.sorteos[0]).toHaveProperty('sorteo');
    expect(res.body.sorteos[0]).toHaveProperty('disponibles');
    expect(res.body.sorteos[0]).toHaveProperty('mis_boletos');
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
    const res = await ag.post(`/api/sorteos/${sorteoId}/ganador`).send({ numero: 500, mes_premiacion: '2026-07' });
    expect(res.status).toBe(409);
  });

  test('POST /:id/ganador número asignado → 201', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    await ag.post(`/api/sorteos/${sorteoId}/boletos/asignar`)
      .send({ numero: 777, asociado_codigo: asocCodigo });

    const res = await ag.post(`/api/sorteos/${sorteoId}/ganador`).send({ numero: 777, mes_premiacion: '2026-07' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('nombre_completo');
    expect(res.body).toHaveProperty('mes_premiacion');
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

// ── Programaciones automáticas ───────────────────────────────────────────────

describe('Sorteos — programaciones', () => {
  let progId;
  const futuro    = (minutos) => new Date(Date.now() + minutos * 60_000).toISOString();

  test('GET /:id/programaciones sin token → 401', async () => {
    const res = await request(app).get(`/api/sorteos/${sorteoId}/programaciones`);
    expect(res.status).toBe(401);
  });

  test('POST /:id/programaciones sin body → 400', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.post(`/api/sorteos/${sorteoId}/programaciones`).send({});
    expect(res.status).toBe(400);
  });

  test('POST /:id/programaciones con cierre en el pasado → 400', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.post(`/api/sorteos/${sorteoId}/programaciones`).send({
      fecha_cierre:   new Date(Date.now() - 60_000).toISOString(),
      fecha_apertura: futuro(60),
    });
    expect(res.status).toBe(400);
  });

  test('POST /:id/programaciones con apertura antes del cierre → 400', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.post(`/api/sorteos/${sorteoId}/programaciones`).send({
      fecha_cierre:   futuro(60),
      fecha_apertura: futuro(30),
    });
    expect(res.status).toBe(400);
  });

  test('POST /:id/programaciones válido → 201', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.post(`/api/sorteos/${sorteoId}/programaciones`).send({
      fecha_cierre:   futuro(120),
      fecha_apertura: futuro(240),
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.ejecutado_cierre).toBe(false);
    expect(res.body.ejecutado_apertura).toBe(false);
    progId = res.body.id;
  });

  test('GET /:id/programaciones → 200 incluye la creada', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.get(`/api/sorteos/${sorteoId}/programaciones`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((p) => p.id === progId)).toBe(true);
  });

  test('DELETE /:id/programaciones/:pid → 200', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.delete(`/api/sorteos/${sorteoId}/programaciones/${progId}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('DELETE /:id/programaciones/:pid ya eliminada → 404', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.delete(`/api/sorteos/${sorteoId}/programaciones/${progId}`);
    expect(res.status).toBe(404);
  });

  test('scheduler ejecuta cierre automático', async () => {
    // Insertar programación con cierre ya vencido directamente en DB
    const { rows: [prog] } = await pool.query(
      `INSERT INTO sorteo_programaciones (sorteo_id, fecha_cierre, fecha_apertura)
       VALUES ($1, NOW() - INTERVAL '1 second', NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [sorteoId]
    );

    // Ejecutar el scheduler directamente (sin el catch silencioso de startScheduler)
    const { ejecutarPendientes } = await import('../../src/services/scheduler.js');
    await ejecutarPendientes();

    // Verificar que el sorteo quedó pausado
    const { rows: [sorteo] } = await pool.query('SELECT estado FROM sorteos WHERE id = $1', [sorteoId]);
    expect(sorteo.estado).toBe('pausado');

    // Verificar log AUTO_CIERRE
    const { rows: logs } = await pool.query(
      `SELECT * FROM sorteo_logs WHERE sorteo_id = $1 AND accion = 'AUTO_CIERRE'`,
      [sorteoId]
    );
    expect(logs.length).toBeGreaterThan(0);

    // Verificar flag ejecutado_cierre
    const { rows: [p] } = await pool.query(
      'SELECT ejecutado_cierre FROM sorteo_programaciones WHERE id = $1', [prog.id]
    );
    expect(p.ejecutado_cierre).toBe(true);

    // Limpieza
    await pool.query('DELETE FROM sorteo_programaciones WHERE id = $1', [prog.id]);
    // Reactivar sorteo para no afectar otros tests
    await pool.query(`UPDATE sorteos SET estado = 'activo' WHERE id = $1`, [sorteoId]);
  });

  test('scheduler ejecuta apertura automática', async () => {
    // Insertar programación con cierre y apertura ya vencidos
    const { rows: [prog] } = await pool.query(
      `INSERT INTO sorteo_programaciones
         (sorteo_id, fecha_cierre, fecha_apertura, ejecutado_cierre)
       VALUES ($1, NOW() - INTERVAL '2 minutes', NOW() - INTERVAL '1 second', true)
       RETURNING id`,
      [sorteoId]
    );

    // Pausar el sorteo manualmente para simular el estado correcto
    await pool.query(`UPDATE sorteos SET estado = 'pausado' WHERE id = $1`, [sorteoId]);

    const { ejecutarPendientes } = await import('../../src/services/scheduler.js');
    await ejecutarPendientes();

    const { rows: [sorteo] } = await pool.query('SELECT estado FROM sorteos WHERE id = $1', [sorteoId]);
    expect(sorteo.estado).toBe('activo');

    const { rows: logs } = await pool.query(
      `SELECT * FROM sorteo_logs WHERE sorteo_id = $1 AND accion = 'AUTO_APERTURA'`,
      [sorteoId]
    );
    expect(logs.length).toBeGreaterThan(0);

    const { rows: [p] } = await pool.query(
      'SELECT ejecutado_apertura FROM sorteo_programaciones WHERE id = $1', [prog.id]
    );
    expect(p.ejecutado_apertura).toBe(true);

    await pool.query('DELETE FROM sorteo_programaciones WHERE id = $1', [prog.id]);
  });
});

// ── Cobertura por empresa ─────────────────────────────────────────────────────

describe('Sorteos — cobertura por empresa', () => {
  test('GET /:id/cobertura sin token → 401', async () => {
    const res = await request(app).get(`/api/sorteos/${sorteoId}/cobertura`);
    expect(res.status).toBe(401);
  });

  test('GET /:id/cobertura → 200 array', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.get(`/api/sorteos/${sorteoId}/cobertura`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('Cada fila tiene codigo, nombre, asociados_activos y bonos_asignados', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const { body } = await ag.get(`/api/sorteos/${sorteoId}/cobertura`);
    if (body.length > 0) {
      const fila = body[0];
      expect(fila).toHaveProperty('codigo');
      expect(fila).toHaveProperty('nombre');
      expect(fila).toHaveProperty('asociados_activos');
      expect(fila).toHaveProperty('bonos_asignados');
      expect(Number(fila.asociados_activos)).toBeGreaterThan(0);
    }
  });

  test('La empresa de test aparece en la cobertura del sorteo', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const { body } = await ag.get(`/api/sorteos/${sorteoId}/cobertura`);
    const emp = body.find((e) => e.codigo === 'EMP_TEST');
    expect(emp).toBeDefined();
  });

  test('Sorteo inexistente → todas las empresas con bonos_asignados=0', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.get('/api/sorteos/00000000-0000-0000-0000-000000000000/cobertura');
    expect(res.status).toBe(200);
    // La query devuelve empresas con asociados activos; sin sorteo, bonos_asignados es 0 para todas
    res.body.forEach((fila) => {
      expect(Number(fila.bonos_asignados)).toBe(0);
    });
  });
});

// ── tipo_pago ─────────────────────────────────────────────────────────────────

describe('Sorteos — tipo_pago', () => {
  test('PUT /:id body vacío → 400', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.put(`/api/sorteos/${sorteoId}`).send({});
    expect(res.status).toBe(400);
  });

  test('PUT /:id tipo_pago=unico → 200 + persiste en DB', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.put(`/api/sorteos/${sorteoId}`).send({ tipo_pago: 'unico' });
    expect(res.status).toBe(200);
    expect(res.body.tipo_pago).toBe('unico');
    const { rows: [row] } = await pool.query('SELECT tipo_pago FROM sorteos WHERE id = $1', [sorteoId]);
    expect(row.tipo_pago).toBe('unico');
  });

  test('PUT /:id tipo_pago=recurrente → 200 + revierte', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.put(`/api/sorteos/${sorteoId}`).send({ tipo_pago: 'recurrente' });
    expect(res.status).toBe(200);
    expect(res.body.tipo_pago).toBe('recurrente');
  });

  test('PUT /:id tipo_pago valor inválido → 400', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.put(`/api/sorteos/${sorteoId}`).send({ tipo_pago: 'invalido' });
    expect(res.status).toBe(400);
  });

  test('PUT /:id sin token → 401', async () => {
    const res = await request(app).put(`/api/sorteos/${sorteoId}`).send({ tipo_pago: 'unico' });
    expect(res.status).toBe(401);
  });
});

// ── premio ────────────────────────────────────────────────────────────────────

describe('Sorteos — premio', () => {
  test('PUT /:id con premio → 200 + persiste en DB', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.put(`/api/sorteos/${sorteoId}`).send({ premio: '$ 2.000.000' });
    expect(res.status).toBe(200);
    expect(res.body.premio).toBe('$ 2.000.000');
    const { rows: [row] } = await pool.query('SELECT premio FROM sorteos WHERE id = $1', [sorteoId]);
    expect(row.premio).toBe('$ 2.000.000');
  });

  test('PUT /:id premio=null → 200 + borra el campo', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.put(`/api/sorteos/${sorteoId}`).send({ premio: null });
    expect(res.status).toBe(200);
    expect(res.body.premio).toBeNull();
  });

  test('PUT /:id precio + premio juntos → 200 + actualiza ambos', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.put(`/api/sorteos/${sorteoId}`).send({ precio_boleto: 25000, premio: '$ 5.000.000' });
    expect(res.status).toBe(200);
    expect(Number(res.body.precio_boleto)).toBe(25000);
    expect(res.body.premio).toBe('$ 5.000.000');
    // limpiar
    await ag.put(`/api/sorteos/${sorteoId}`).send({ precio_boleto: 20000, premio: null });
  });

  test('PUT /:id premio > 200 chars → 400', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.put(`/api/sorteos/${sorteoId}`).send({ premio: 'x'.repeat(201) });
    expect(res.status).toBe(400);
  });
});

// ── Asignación en lote por discrepancia ────────────────────────────────────

describe('Sorteos — asignar-discrepancias-lote', () => {
  let loteSorteoId;
  const COD_LOTE1 = '6661111111';
  const COD_LOTE2 = '6662222222';

  beforeAll(async () => {
    const { rows: [s] } = await pool.query(
      `INSERT INTO sorteos (nombre, estado, precio_boleto)
       VALUES ('Sorteo Lote Test', 'activo', 3000) RETURNING id`
    );
    loteSorteoId = s.id;

    await pool.query(
      `INSERT INTO sorteo_empresas (sorteo_id, empresa_codigo)
       VALUES ($1, 'EMP_TEST') ON CONFLICT DO NOTHING`,
      [loteSorteoId]
    );

    for (let n = 900; n <= 915; n++) {
      await pool.query(
        `INSERT INTO boletos (numero, sorteo_id, estado)
         VALUES ($1, $2, 'libre') ON CONFLICT (numero, sorteo_id) DO NOTHING`,
        [n, loteSorteoId]
      );
    }

    for (const codigo of [COD_LOTE1, COD_LOTE2]) {
      await pool.query(
        `INSERT INTO asociados (codigo, nombre, apellido, empresa_dsto, nombre_empresa, is_active)
         VALUES ($1, 'Test', 'Lote', 'EMP_TEST', 'Empresa Test Sorteos', true)
         ON CONFLICT (codigo) DO UPDATE SET empresa_dsto = 'EMP_TEST', is_active = true`,
        [codigo]
      );
    }
  });

  afterAll(async () => {
    await pool.query('DELETE FROM sorteo_logs     WHERE sorteo_id = $1', [loteSorteoId]);
    await pool.query('DELETE FROM boletos         WHERE sorteo_id = $1', [loteSorteoId]);
    await pool.query('DELETE FROM sorteo_empresas WHERE sorteo_id = $1', [loteSorteoId]);
    await pool.query('DELETE FROM sorteos         WHERE id = $1',        [loteSorteoId]);
    await pool.query('DELETE FROM asociados       WHERE codigo = ANY($1)', [[COD_LOTE1, COD_LOTE2]]);
  });

  test('POST sin token → 401', async () => {
    const res = await request(app).post('/api/sorteos/asignar-discrepancias-lote');
    expect(res.status).toBe(401);
  });

  test('POST sin items → 400', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.post('/api/sorteos/asignar-discrepancias-lote').send({});
    expect(res.status).toBe(400);
  });

  test('POST items vacío → 400', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag.post('/api/sorteos/asignar-discrepancias-lote').send({ items: [] });
    expect(res.status).toBe(400);
  });

  test('POST item con cantidad 0 → 400', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/sorteos/asignar-discrepancias-lote')
      .send({ items: [{ codigo: COD_LOTE1, cantidad: 0 }] });
    expect(res.status).toBe(400);
  });

  test('POST asociado inexistente → va a fallidos, exitosos vacío', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/sorteos/asignar-discrepancias-lote')
      .send({ items: [{ codigo: 'CODIGO_NO_EXISTE', cantidad: 1 }] });
    expect(res.status).toBe(200);
    expect(res.body.exitosos.length).toBe(0);
    expect(res.body.fallidos.length).toBeGreaterThan(0);
    expect(res.body.fallidos[0].codigo).toBe('CODIGO_NO_EXISTE');
  });

  test('POST válido → 200, boletos asignados en DB, logs insertados', async () => {
    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/sorteos/asignar-discrepancias-lote')
      .send({
        items: [
          { codigo: COD_LOTE1, cantidad: 2 },
          { codigo: COD_LOTE2, cantidad: 3 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.exitosos.length).toBe(2);
    expect(res.body.fallidos.length).toBe(0);

    const ex1 = res.body.exitosos.find((e) => e.codigo === COD_LOTE1);
    const ex2 = res.body.exitosos.find((e) => e.codigo === COD_LOTE2);
    expect(ex1.numeros.length).toBe(2);
    expect(ex2.numeros.length).toBe(3);

    // Verificar en DB que los boletos cambiaron de estado
    const { rows: asignados } = await pool.query(
      `SELECT numero, asociado_codigo FROM boletos
       WHERE sorteo_id = $1 AND estado = 'asignado'`,
      [loteSorteoId]
    );
    expect(asignados.length).toBe(5);

    // Verificar logs
    const { rows: logs } = await pool.query(
      `SELECT accion FROM sorteo_logs WHERE sorteo_id = $1`,
      [loteSorteoId]
    );
    expect(logs.length).toBe(5);
    logs.forEach((l) => expect(l.accion).toBe('COMPRA_DIRECTA'));
  });

  test('POST con sync_id → marca discrepancias como subsanadas en JSONB', async () => {
    const detalle = {
      discrepancias: [
        { tipo: 'COBRO_SIN_BOLETO', codigo: COD_LOTE1, bonos_sugeridos: 1 },
        { tipo: 'COBRO_SIN_BOLETO', codigo: COD_LOTE2, bonos_sugeridos: 1 },
      ],
    };
    const { rows: [sinc] } = await pool.query(
      `INSERT INTO sincronizaciones
         (usuario_uuid, archivo, total, nuevos, actualizados, retirados, errores, boletos_liberados, detalle)
       VALUES ($1, 'lote-test.csv', 2, 0, 0, 0, 0, 0, $2) RETURNING id`,
      [adminUuid, JSON.stringify(detalle)]
    );

    const ag = agentAdmin();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/sorteos/asignar-discrepancias-lote')
      .send({
        items: [
          { codigo: COD_LOTE1, cantidad: 1 },
          { codigo: COD_LOTE2, cantidad: 1 },
        ],
        sync_id: sinc.id,
      });
    expect(res.status).toBe(200);

    const { rows: [row] } = await pool.query(
      'SELECT detalle FROM sincronizaciones WHERE id = $1',
      [sinc.id]
    );
    const d1 = row.detalle.discrepancias.find((d) => d.codigo === COD_LOTE1);
    const d2 = row.detalle.discrepancias.find((d) => d.codigo === COD_LOTE2);
    expect(d1.subsanada).toBe(true);
    expect(d2.subsanada).toBe(true);
    expect(Array.isArray(d1.numeros_asignados)).toBe(true);
    expect(Array.isArray(d2.numeros_asignados)).toBe(true);

    await pool.query('DELETE FROM sincronizaciones WHERE id = $1', [sinc.id]);
  });
});
