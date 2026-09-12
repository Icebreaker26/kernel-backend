import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';

let app;
const adminEmail  = 'seguridad-admin-test@kernel.test';
const adminPass   = 'Pass1234567!';
const victimEmail = 'seguridad-victim-test@kernel.test';
const otherEmail  = 'seguridad-nonadmin-test@kernel.test';
let adminUuid, victimUuid, otherUuid, alertaId;

const adminAgent = () => request.agent(app);
const otherAgent = () => request.agent(app);

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(adminPass, 4);

  const { rows: [admin] } = await pool.query(`
    INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
    VALUES ('Admin Seguridad Test', $1, $2, 'admin', true, true)
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, rol = 'admin', is_approved = true
    RETURNING id
  `, [adminEmail, hash]);
  adminUuid = admin.id;
  await pool.query(`UPDATE global_usuarios SET sessions_valid_from = '2020-01-01' WHERE id = $1`, [adminUuid]);

  // Usuario sin privilegios para verificar el 403
  const { rows: [other] } = await pool.query(`
    INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
    VALUES ('Other Seg Test', $1, $2, 'usuario', true, true)
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, rol = 'usuario', is_approved = true
    RETURNING id
  `, [otherEmail, hash]);
  otherUuid = other.id;
  await pool.query(`UPDATE global_usuarios SET sessions_valid_from = '2020-01-01' WHERE id = $1`, [otherUuid]);

  // Usuario con intentos fallidos para loginFallidos y desbloquear
  const { rows: [victim] } = await pool.query(`
    INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved, failed_attempts, locked_until)
    VALUES ('Victim Seg Test', $1, $2, 'usuario', true, true, 5, NOW() + INTERVAL '15 minutes')
    ON CONFLICT (email) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          failed_attempts = 5,
          locked_until = NOW() + INTERVAL '15 minutes'
    RETURNING id
  `, [victimEmail, hash]);
  victimUuid = victim.id;
  await pool.query(`UPDATE global_usuarios SET sessions_valid_from = '2020-01-01' WHERE id = $1`, [victimUuid]);

  // Alerta de prueba
  const { rows: [alerta] } = await pool.query(`
    INSERT INTO security_alerts (regla, tipo, severidad, titulo, dedupe_key, estado)
    VALUES ('password_spraying', 'acceso', 'alta', 'Test: múltiples contraseñas fallidas', 'test-dedupe-seg-' || floor(extract(epoch from now()))::text, 'nueva')
    RETURNING id
  `);
  alertaId = alerta.id;

  // Algunos intentos en auth_intentos para el endpoint historial
  await pool.query(`
    INSERT INTO auth_intentos (email, usuario_id, exitoso, motivo, ip, user_agent)
    VALUES
      ($1, $2, false, 'password', '127.0.0.1', 'test-agent'),
      ($1, $2, false, 'password', '127.0.0.1', 'test-agent'),
      ($1, $2, true,  'ok',       '127.0.0.1', 'test-agent')
  `, [victimEmail, victimUuid]);
});

afterAll(async () => {
  await pool.query('DELETE FROM security_alerts WHERE id = $1', [alertaId]);
  await pool.query('DELETE FROM auth_intentos WHERE email IN ($1, $2)', [victimEmail, adminEmail]);
  await pool.query('DELETE FROM global_usuarios WHERE id IN ($1, $2, $3)', [adminUuid, victimUuid, otherUuid]);
});

// ── Helper: sesión autenticada ────────────────────────────────────────────────
const loginAs = async (ag, email) => {
  await ag.post('/api/auth/login').send({ email, password: adminPass });
};

// ── Auth guard ────────────────────────────────────────────────────────────────
describe('Seguridad — sin token', () => {
  test('GET /api/seguridad/alertas → 401', async () => {
    const res = await request(app).get('/api/seguridad/alertas');
    expect(res.status).toBe(401);
  });

  test('GET /api/seguridad/metricas → 401', async () => {
    const res = await request(app).get('/api/seguridad/metricas');
    expect(res.status).toBe(401);
  });
});

// ── Solo admin ────────────────────────────────────────────────────────────────
describe('Seguridad — no admin → 403', () => {
  let ag;
  beforeAll(async () => { ag = otherAgent(); await loginAs(ag, otherEmail); });

  test('GET /api/seguridad/alertas → 403', async () => {
    const res = await ag.get('/api/seguridad/alertas');
    expect(res.status).toBe(403);
  });

  test('GET /api/seguridad/metricas → 403', async () => {
    const res = await ag.get('/api/seguridad/metricas');
    expect(res.status).toBe(403);
  });

  test('GET /api/seguridad/login-fallidos → 403', async () => {
    const res = await ag.get('/api/seguridad/login-fallidos');
    expect(res.status).toBe(403);
  });
});

// ── Alertas ───────────────────────────────────────────────────────────────────
describe('Seguridad — alertas', () => {
  let ag;
  beforeAll(async () => { ag = adminAgent(); await loginAs(ag, adminEmail); });

  test('GET /alertas → array con la alerta de prueba', async () => {
    const res = await ag.get('/api/seguridad/alertas?estado=nueva');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const alerta = res.body.find(a => a.id === alertaId);
    expect(alerta).toBeDefined();
    expect(alerta.titulo).toBe('Test: múltiples contraseñas fallidas');
    expect(alerta.severidad).toBe('alta');
  });

  test('GET /alertas?estado=todas → incluye la alerta de prueba', async () => {
    const res = await ag.get('/api/seguridad/alertas?estado=todas');
    expect(res.status).toBe(200);
    expect(res.body.find(a => a.id === alertaId)).toBeDefined();
  });

  test('GET /alertas?regla=password_spraying → filtro por regla', async () => {
    const res = await ag.get('/api/seguridad/alertas?estado=nueva&regla=password_spraying');
    expect(res.status).toBe(200);
    expect(res.body.every(a => a.regla === 'password_spraying')).toBe(true);
  });

  test('GET /alertas?regla=origina_y_aprueba → no incluye la alerta de prueba', async () => {
    const res = await ag.get('/api/seguridad/alertas?estado=nueva&regla=origina_y_aprueba');
    expect(res.status).toBe(200);
    expect(res.body.find(a => a.id === alertaId)).toBeUndefined();
  });

  test('PATCH /alertas/:id — marcar reconocida', async () => {
    const res = await ag.patch(`/api/seguridad/alertas/${alertaId}`).send({ estado: 'reconocida', nota: 'Revisado en test' });
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('reconocida');
    expect(res.body.reconocida_por_uuid).toBe(adminUuid);
  });

  test('PATCH /alertas/:id — marcar resuelta', async () => {
    const res = await ag.patch(`/api/seguridad/alertas/${alertaId}`).send({ estado: 'resuelta' });
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('resuelta');
  });

  test('PATCH /alertas/:id — estado inválido → 400', async () => {
    const res = await ag.patch(`/api/seguridad/alertas/${alertaId}`).send({ estado: 'inventado' });
    expect(res.status).toBe(400);
  });

  test('PATCH /alertas/:id — id inexistente → 404', async () => {
    const res = await ag.patch('/api/seguridad/alertas/00000000-0000-0000-0000-000000000000').send({ estado: 'resuelta' });
    expect(res.status).toBe(404);
  });
});

// ── Métricas ──────────────────────────────────────────────────────────────────
describe('Seguridad — métricas', () => {
  let ag;
  beforeAll(async () => { ag = adminAgent(); await loginAs(ag, adminEmail); });

  test('GET /metricas → shape correcta', async () => {
    const res = await ag.get('/api/seguridad/metricas');
    expect(res.status).toBe(200);
    // Snapshot puede estar vacío en test, pero sesiones_activas siempre viene
    expect(res.body).toHaveProperty('sesiones_activas');
    expect(typeof res.body.sesiones_activas).toBe('number');
  });
});

// ── Login fallidos ────────────────────────────────────────────────────────────
describe('Seguridad — login fallidos', () => {
  let ag;
  beforeAll(async () => { ag = adminAgent(); await loginAs(ag, adminEmail); });

  test('GET /login-fallidos → incluye usuario con failed_attempts > 0', async () => {
    const res = await ag.get('/api/seguridad/login-fallidos');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const victim = res.body.find(u => u.id === victimUuid);
    expect(victim).toBeDefined();
    expect(victim.failed_attempts).toBe(5);
    expect(victim.bloqueado).toBe(true);
  });

  test('POST /usuarios/:id/desbloquear → resetea contadores', async () => {
    const res = await ag.post(`/api/seguridad/usuarios/${victimUuid}/desbloquear`);
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT failed_attempts, locked_until FROM global_usuarios WHERE id = $1`,
      [victimUuid]
    );
    expect(rows[0].failed_attempts).toBe(0);
    expect(rows[0].locked_until).toBeNull();
  });

  test('GET /login-fallidos — usuario desbloqueado ya no aparece', async () => {
    const res = await ag.get('/api/seguridad/login-fallidos');
    expect(res.status).toBe(200);
    expect(res.body.find(u => u.id === victimUuid)).toBeUndefined();
  });
});

// ── Forzar logout ─────────────────────────────────────────────────────────────
describe('Seguridad — forzar logout', () => {
  let ag, victimAg;

  beforeAll(async () => {
    ag = adminAgent();
    await loginAs(ag, adminEmail);

    // El victim se loguea para obtener una sesión válida
    victimAg = request.agent(app);
    await victimAg.post('/api/auth/login').send({ email: victimEmail, password: adminPass });
  });

  test('Victim puede autenticarse antes de forzar logout', async () => {
    const res = await victimAg.get('/api/auth/me');
    expect(res.status).toBe(200);
  });

  test('POST /usuarios/:id/forzar-logout → 200 y actualiza sessions_valid_from', async () => {
    const res = await ag.post(`/api/seguridad/usuarios/${victimUuid}/forzar-logout`);
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT sessions_valid_from FROM global_usuarios WHERE id = $1`,
      [victimUuid]
    );
    // sessions_valid_from debe ser reciente (en los últimos 5 segundos)
    const diff = Date.now() - new Date(rows[0].sessions_valid_from).getTime();
    expect(diff).toBeLessThan(5000);
  });

  test('Victim recibe 401 después del forzar-logout (sessions_valid_from)', async () => {
    const res = await victimAg.get('/api/auth/me');
    expect(res.status).toBe(401);
  });
});

// ── Historial de intentos ─────────────────────────────────────────────────────
describe('Seguridad — intentos de login', () => {
  let ag;
  beforeAll(async () => { ag = adminAgent(); await loginAs(ag, adminEmail); });

  test('GET /intentos-login → devuelve array', async () => {
    const res = await ag.get('/api/seguridad/intentos-login');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /intentos-login?email=victim → solo registros de ese email', async () => {
    const res = await ag.get(`/api/seguridad/intentos-login?email=${encodeURIComponent(victimEmail)}`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
    expect(res.body.every(r => r.email === victimEmail)).toBe(true);
  });

  test('GET /intentos-login?motivo=password → solo intentos con contraseña incorrecta', async () => {
    const res = await ag.get(`/api/seguridad/intentos-login?email=${encodeURIComponent(victimEmail)}&motivo=password`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    expect(res.body.every(r => r.motivo === 'password')).toBe(true);
  });

  test('GET /intentos-login?motivo=ok → solo accesos exitosos', async () => {
    const res = await ag.get(`/api/seguridad/intentos-login?email=${encodeURIComponent(victimEmail)}&motivo=ok`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body.every(r => r.exitoso === true)).toBe(true);
  });
});
