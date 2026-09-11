import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';

let app;
const adminEmail = 'admin-control-test@kernel.test';
const adminPass  = 'testpass123';
let adminUuid;
let targetUuid;

const agAdmin = () => request.agent(app);
const login   = (ag) => ag.post('/api/auth/login').send({ email: adminEmail, password: adminPass });

// Inserta filas de actividad para simular uso real
const seedActividad = async (usuarioId, modulo, n = 5) => {
  for (let i = 0; i < n; i++) {
    await pool.query(
      `INSERT INTO global_actividad
         (usuario_id, modulo, metodo, endpoint, status_code, duracion_ms, ip, created_at)
       VALUES ($1, $2, 'GET', $3, 200, 120,
               '127.0.0.1', NOW() - ($4 || ' hours')::interval)`,
      [usuarioId, modulo, `/api/${modulo}/test`, String(i * 2)]
    );
  }
};

const seedSesion = async (usuarioId) => {
  await pool.query(
    `INSERT INTO global_actividad
       (usuario_id, modulo, metodo, endpoint, status_code, duracion_ms, ip)
     VALUES ($1, 'auth', 'SESSION', 'login', 200, 0, '10.0.0.1')`,
    [usuarioId]
  );
};

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(adminPass, 4);

  const { rows: [admin] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Admin Control Test', $1, $2, 'admin', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true, is_approved = true
     RETURNING id`,
    [adminEmail, hash]
  );
  adminUuid = admin.id;

  const { rows: [target] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Target Control Test', 'admin-control-target@kernel.test', $1, 'usuario', true, true)
     ON CONFLICT (email) DO UPDATE SET is_active = true, is_approved = true
     RETURNING id`,
    [hash]
  );
  targetUuid = target.id;

  // Permisos admin
  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a
     WHERE m.nombre = 'admin' ON CONFLICT DO NOTHING`,
    [adminUuid]
  );

  // Seed actividad para target: tesoreria y contable
  await seedActividad(targetUuid, 'tesoreria', 6);
  await seedActividad(targetUuid, 'contable', 3);
  await seedSesion(targetUuid);

  // Actualizar last_active_at
  await pool.query(`UPDATE global_usuarios SET last_active_at = NOW() WHERE id = $1`, [targetUuid]);
});

afterAll(async () => {
  await pool.query('DELETE FROM global_actividad  WHERE usuario_id IN ($1,$2)', [adminUuid, targetUuid]);
  await pool.query('DELETE FROM permisos          WHERE usuario_uuid IN ($1,$2)', [adminUuid, targetUuid]);
  await pool.query('DELETE FROM admin_logs        WHERE usuario_uuid IN ($1,$2)', [adminUuid, targetUuid]);
  await pool.query('DELETE FROM global_usuarios   WHERE id IN ($1,$2)', [adminUuid, targetUuid]);
  await pool.end();
});

// ── Auth guard ────────────────────────────────────────────────────────────────

describe('Control — sin token', () => {
  test('GET /api/admin/usuarios/resumen → 401', async () => {
    const res = await request(app).get('/api/admin/usuarios/resumen');
    expect(res.status).toBe(401);
  });

  test('GET /api/admin/modulos/adopcion → 401', async () => {
    const res = await request(app).get('/api/admin/modulos/adopcion');
    expect(res.status).toBe(401);
  });

  test('GET /api/admin/actividad/alertas → 401', async () => {
    const res = await request(app).get('/api/admin/actividad/alertas');
    expect(res.status).toBe(401);
  });

  test(`GET /api/admin/usuarios/:id/actividad → 401`, async () => {
    const res = await request(app).get(`/api/admin/usuarios/${targetUuid}/actividad`);
    expect(res.status).toBe(401);
  });

  test(`PATCH /api/admin/usuarios/:id/permisos/toggle → 401`, async () => {
    const res = await request(app)
      .patch(`/api/admin/usuarios/${targetUuid}/permisos/toggle`)
      .send({ modulo: 'admin', accion: 'READ' });
    expect(res.status).toBe(401);
  });
});

// ── GET /admin/usuarios/resumen ───────────────────────────────────────────────

describe('Control — resumen de usuarios', () => {
  test('200 — devuelve array', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get('/api/admin/usuarios/resumen');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('Cada elemento tiene los campos requeridos', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get('/api/admin/usuarios/resumen');
    expect(res.status).toBe(200);
    const campos = ['id', 'nombre', 'email', 'rol', 'is_active', 'acciones_hoy', 'minutos_hoy', 'acciones_semana'];
    for (const u of res.body) {
      for (const c of campos) {
        expect(u).toHaveProperty(c);
      }
    }
  });

  test('Target aparece en el listado', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get('/api/admin/usuarios/resumen');
    const target = res.body.find(u => u.id === targetUuid);
    expect(target).toBeDefined();
    expect(target.nombre).toBe('Target Control Test');
  });

  test('acciones_semana del target > 0 (tiene actividad seedeada)', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get('/api/admin/usuarios/resumen');
    const target = res.body.find(u => u.id === targetUuid);
    expect(target.acciones_semana).toBeGreaterThan(0);
  });

  test('modulo_principal refleja el módulo con más acciones', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get('/api/admin/usuarios/resumen');
    const target = res.body.find(u => u.id === targetUuid);
    // tesoreria tiene 6 registros vs contable 3 → debe ser tesoreria
    expect(target.modulo_principal).toBe('tesoreria');
  });
});

// ── GET /admin/usuarios/:id/actividad ─────────────────────────────────────────

describe('Control — actividad de usuario', () => {
  test('200 — estructura esperada', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get(`/api/admin/usuarios/${targetUuid}/actividad`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('heatmap');
    expect(res.body).toHaveProperty('sesiones');
    expect(res.body).toHaveProperty('modulos');
    expect(res.body).toHaveProperty('timeline');
  });

  test('heatmap es array con registros de actividad', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get(`/api/admin/usuarios/${targetUuid}/actividad`);
    expect(Array.isArray(res.body.heatmap)).toBe(true);
    expect(res.body.heatmap.length).toBeGreaterThan(0);
    const dia = res.body.heatmap[0];
    expect(dia).toHaveProperty('dia');
    expect(dia).toHaveProperty('acciones');
  });

  test('sesiones incluye el login seedeado', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get(`/api/admin/usuarios/${targetUuid}/actividad`);
    expect(res.body.sesiones.length).toBeGreaterThan(0);
    expect(res.body.sesiones[0]).toHaveProperty('created_at');
    expect(res.body.sesiones[0]).toHaveProperty('ip');
  });

  test('modulos lista tesoreria con total > contable', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get(`/api/admin/usuarios/${targetUuid}/actividad`);
    const tesoreria = res.body.modulos.find(m => m.modulo === 'tesoreria');
    const contable  = res.body.modulos.find(m => m.modulo === 'contable');
    expect(tesoreria).toBeDefined();
    expect(contable).toBeDefined();
    expect(tesoreria.total).toBeGreaterThan(contable.total);
  });

  test('timeline tiene las últimas acciones (excluyendo SESSION)', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get(`/api/admin/usuarios/${targetUuid}/actividad`);
    expect(res.body.timeline.length).toBeGreaterThan(0);
    for (const t of res.body.timeline) {
      expect(t.metodo).not.toBe('SESSION');
      expect(t).toHaveProperty('modulo');
      expect(t).toHaveProperty('endpoint');
      expect(t).toHaveProperty('status_code');
    }
  });

  test('UUID inexistente → heatmap vacío (no error)', async () => {
    const ag = agAdmin();
    await login(ag);
    const fakeId = '00000000-0000-0000-0000-000000000099';
    const res = await ag.get(`/api/admin/usuarios/${fakeId}/actividad`);
    expect(res.status).toBe(200);
    expect(res.body.heatmap).toHaveLength(0);
    expect(res.body.sesiones).toHaveLength(0);
    expect(res.body.modulos).toHaveLength(0);
    expect(res.body.timeline).toHaveLength(0);
  });
});

// ── GET /admin/modulos/adopcion ───────────────────────────────────────────────

describe('Control — adopción de módulos', () => {
  test('200 — devuelve array', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get('/api/admin/modulos/adopcion');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('Campos requeridos en cada módulo', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get('/api/admin/modulos/adopcion');
    expect(res.body.length).toBeGreaterThan(0);
    const campos = ['modulo', 'usuarios_activos', 'acciones_semana', 'promedio_diario', 'errores'];
    for (const m of res.body) {
      for (const c of campos) {
        expect(m).toHaveProperty(c);
      }
    }
  });

  test('tesoreria aparece con acciones > 0', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get('/api/admin/modulos/adopcion');
    const tesoreria = res.body.find(m => m.modulo === 'tesoreria');
    expect(tesoreria).toBeDefined();
    expect(tesoreria.acciones_semana).toBeGreaterThan(0);
  });

  test('Excluye módulo auth y sesiones', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get('/api/admin/modulos/adopcion');
    const auth = res.body.find(m => m.modulo === 'auth');
    expect(auth).toBeUndefined();
  });

  test('Ordenado por acciones_semana DESC', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get('/api/admin/modulos/adopcion');
    for (let i = 1; i < res.body.length; i++) {
      expect(res.body[i - 1].acciones_semana).toBeGreaterThanOrEqual(res.body[i].acciones_semana);
    }
  });
});

// ── GET /admin/actividad/alertas ──────────────────────────────────────────────

describe('Control — alertas de actividad', () => {
  test('200 — estructura esperada', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get('/api/admin/actividad/alertas');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('inactivos');
    expect(res.body).toHaveProperty('zombies');
    expect(Array.isArray(res.body.inactivos)).toBe(true);
    expect(Array.isArray(res.body.zombies)).toBe(true);
  });

  test('Inactivos: tiene campos requeridos', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get('/api/admin/actividad/alertas');
    for (const u of res.body.inactivos) {
      expect(u).toHaveProperty('id');
      expect(u).toHaveProperty('nombre');
      expect(u).toHaveProperty('email');
      expect(u).toHaveProperty('dias_inactivo');
    }
  });

  test('Zombies: tiene campos requeridos', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get('/api/admin/actividad/alertas');
    for (const z of res.body.zombies) {
      expect(z).toHaveProperty('id');
      expect(z).toHaveProperty('nombre');
      expect(z).toHaveProperty('modulo');
    }
  });

  test('Target con last_active_at reciente NO aparece en inactivos', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.get('/api/admin/actividad/alertas');
    const enInactivos = res.body.inactivos.some(u => u.id === targetUuid);
    expect(enInactivos).toBe(false);
  });

  test('Usuario sin last_active_at aparece en inactivos', async () => {
    // Insertar usuario sin actividad
    const { rows: [dormido] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved, last_active_at)
       VALUES ('Dormido Test', 'dormido-test@kernel.test', 'x', 'usuario', true, true, NULL)
       ON CONFLICT (email) DO UPDATE SET last_active_at = NULL
       RETURNING id`
    );

    const ag = agAdmin();
    await login(ag);
    const res = await ag.get('/api/admin/actividad/alertas');
    const enInactivos = res.body.inactivos.some(u => u.id === dormido.id);
    expect(enInactivos).toBe(true);

    await pool.query('DELETE FROM global_usuarios WHERE id = $1', [dormido.id]);
  });
});

// ── PATCH /admin/usuarios/:id/permisos/toggle ─────────────────────────────────

describe('Control — toggle de permiso', () => {
  const modulo = 'tesoreria';
  const accion = 'READ';

  test('400 sin body', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}/permisos/toggle`).send({});
    expect(res.status).toBe(400);
  });

  test('400 sin accion', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}/permisos/toggle`).send({ modulo });
    expect(res.status).toBe(400);
  });

  test('404 módulo inexistente', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}/permisos/toggle`)
      .send({ modulo: 'no_existe_xyz', accion: 'READ' });
    expect(res.status).toBe(404);
  });

  test('404 acción inexistente', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}/permisos/toggle`)
      .send({ modulo, accion: 'SUPER_POWER' });
    expect(res.status).toBe(404);
  });

  test('DAR permiso → 200 activo:true', async () => {
    // Asegurar que no tenga el permiso
    await pool.query(
      `DELETE FROM permisos WHERE usuario_uuid = $1
       AND modulo_id = (SELECT id FROM modulos WHERE nombre = $2)
       AND accion_id = (SELECT id FROM acciones WHERE nombre = $3)`,
      [targetUuid, modulo, accion]
    );

    const ag = agAdmin();
    await login(ag);
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}/permisos/toggle`)
      .send({ modulo, accion });
    expect(res.status).toBe(200);
    expect(res.body.activo).toBe(true);
  });

  test('El permiso realmente existe en DB tras dar', async () => {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM permisos p
       JOIN modulos m ON m.id = p.modulo_id AND m.nombre = $2
       JOIN acciones a ON a.id = p.accion_id AND a.nombre = $3
       WHERE p.usuario_uuid = $1`,
      [targetUuid, modulo, accion]
    );
    expect(rowCount).toBe(1);
  });

  test('QUITAR permiso (toggle sobre existente) → 200 activo:false', async () => {
    const ag = agAdmin();
    await login(ag);
    const res = await ag.patch(`/api/admin/usuarios/${targetUuid}/permisos/toggle`)
      .send({ modulo, accion });
    expect(res.status).toBe(200);
    expect(res.body.activo).toBe(false);
  });

  test('El permiso ya no existe en DB tras quitar', async () => {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM permisos p
       JOIN modulos m ON m.id = p.modulo_id AND m.nombre = $2
       JOIN acciones a ON a.id = p.accion_id AND a.nombre = $3
       WHERE p.usuario_uuid = $1`,
      [targetUuid, modulo, accion]
    );
    expect(rowCount).toBe(0);
  });

  test('Dar y quitar otro permiso (WRITE) — ciclo completo', async () => {
    const ag = agAdmin();
    await login(ag);

    const dar = await ag.patch(`/api/admin/usuarios/${targetUuid}/permisos/toggle`)
      .send({ modulo, accion: 'WRITE' });
    expect(dar.status).toBe(200);
    expect(dar.body.activo).toBe(true);

    const quitar = await ag.patch(`/api/admin/usuarios/${targetUuid}/permisos/toggle`)
      .send({ modulo, accion: 'WRITE' });
    expect(quitar.status).toBe(200);
    expect(quitar.body.activo).toBe(false);
  });

  test('Toggle registra en admin_logs', async () => {
    const ag = agAdmin();
    await login(ag);
    await ag.patch(`/api/admin/usuarios/${targetUuid}/permisos/toggle`)
      .send({ modulo: 'contable', accion: 'READ' });

    const { rows } = await pool.query(
      `SELECT accion, detalle FROM admin_logs
       WHERE usuario_uuid = $1 AND detalle LIKE 'contable:READ'
       ORDER BY created_at DESC LIMIT 1`,
      [adminUuid]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].detalle).toBe('contable:READ');

    // Limpiar permiso que quedó activo
    await pool.query(
      `DELETE FROM permisos WHERE usuario_uuid = $1
       AND modulo_id = (SELECT id FROM modulos WHERE nombre = 'contable')
       AND accion_id = (SELECT id FROM acciones WHERE nombre = 'READ')`,
      [targetUuid]
    );
  });
});
