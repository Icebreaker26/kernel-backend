import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';

let app;

const EMAIL_ADMIN  = 'mailing-test@kernel.test';
const PASS         = 'testpass123';
let adminUuid;
let campanaId;

// Asociado de test con email para candidatos / preview
const ASOC_CODIGO = '9999991234';
const ASOC_EMAIL  = 'mailing-asoc@kernel.test';

const agent  = () => request.agent(app);
const login  = (ag) => ag.post('/api/auth/login').send({ email: EMAIL_ADMIN, password: PASS });

// ── Setup ─────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(PASS, 4);

  const { rows: [u] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Mailing Test', $1, $2, 'admin', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL_ADMIN, hash]
  );
  adminUuid = u.id;

  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a
     WHERE m.nombre = 'mailing'
     ON CONFLICT DO NOTHING`,
    [adminUuid]
  );

  // Asociado con email para que preview/candidatos devuelvan al menos uno
  await pool.query(
    `INSERT INTO asociados (codigo, nombre, apellido, empresa_dsto, nombre_empresa, email, is_active)
     VALUES ($1, 'Test', 'Mailing', 'EMP_TEST', 'Empresa Test', $2, true)
     ON CONFLICT (codigo) DO UPDATE SET email = EXCLUDED.email, is_active = true`,
    [ASOC_CODIGO, ASOC_EMAIL]
  );
});

// ── Teardown ──────────────────────────────────────────────────────────────────
afterAll(async () => {
  if (campanaId) {
    await pool.query('DELETE FROM cola_mailing WHERE campana_id = $1', [campanaId]);
    await pool.query('DELETE FROM campanas     WHERE id = $1',         [campanaId]);
  }
  await pool.query('DELETE FROM email_logs       WHERE destinatario = $1',  [ASOC_EMAIL]);
  await pool.query('DELETE FROM asociados        WHERE codigo = $1',        [ASOC_CODIGO]);
  await pool.query('DELETE FROM permisos         WHERE usuario_uuid = $1',  [adminUuid]);
  await pool.query('DELETE FROM global_usuarios  WHERE id = $1',            [adminUuid]);
  await pool.end();
});

// ── Auth ──────────────────────────────────────────────────────────────────────
describe('Mailing — auth', () => {
  test('GET /api/mailing sin token → 401', async () => {
    const res = await request(app).get('/api/mailing');
    expect(res.status).toBe(401);
  });

  test('GET /api/mailing/candidatos sin token → 401', async () => {
    const res = await request(app).get('/api/mailing/candidatos');
    expect(res.status).toBe(401);
  });
});

// ── Validación Zod ────────────────────────────────────────────────────────────
describe('Mailing — validación', () => {
  test('POST body vacío → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/mailing').send({});
    expect(res.status).toBe(400);
  });

  test('POST sin cuerpo_html → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/mailing').send({ asunto: 'Solo asunto' });
    expect(res.status).toBe(400);
  });

  test('POST con segmento.sorteos con UUID inválido → 400', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/mailing').send({
      asunto:      'Test',
      cuerpo_html: '<p>Test</p>',
      segmento:    { sorteos: ['no-es-uuid'] },
    });
    expect(res.status).toBe(400);
  });
});

// ── CRUD ──────────────────────────────────────────────────────────────────────
describe('Mailing — CRUD', () => {
  test('POST /api/mailing → 201 crea campaña en borrador', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post('/api/mailing').send({
      asunto:      'Campaña de prueba integración',
      cuerpo_html: '<p>Hola asociado, esto es una prueba.</p>',
      cuerpo_texto: 'Hola asociado, esto es una prueba.',
      segmento:    { empresas: [], sorteos: [], codigos: [] },
      plantilla:   {
        tipo:   'comunicado',
        campos: { titulo: 'Prueba', cuerpo: 'Mensaje de prueba.' },
      },
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.estado).toBe('borrador');
    expect(res.body.plantilla).toBeDefined();
    campanaId = res.body.id;
  });

  test('GET /api/mailing → 200 lista incluye la campaña creada', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.get('/api/mailing');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(c => c.id === campanaId)).toBe(true);
  });

  test('GET /api/mailing/candidatos → 200 array (incluye el asociado de test)', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.get('/api/mailing/candidatos');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some(c => c.codigo === ASOC_CODIGO)).toBe(true);
  });

  test('GET /api/mailing/:id/preview → 200 con destinatarios_count ≥ 1', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.get(`/api/mailing/${campanaId}/preview`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('destinatarios_count');
    expect(Number(res.body.destinatarios_count)).toBeGreaterThanOrEqual(1);
  });

  test('PUT /api/mailing/:id → 200 actualiza asunto y segmento', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.put(`/api/mailing/${campanaId}`).send({
      asunto:   'Campaña actualizada',
      segmento: { empresas: [], sorteos: [], codigos: [ASOC_CODIGO] },
    });
    expect(res.status).toBe(200);
    expect(res.body.asunto).toBe('Campaña actualizada');
  });

  test('PUT /api/mailing/:id con campo extra → 400 (.strict())', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.put(`/api/mailing/${campanaId}`).send({
      asunto:        'Test',
      campo_invalido: true,
    });
    expect(res.status).toBe(400);
  });
});

// ── Enviar (cola) ─────────────────────────────────────────────────────────────
describe('Mailing — enviar', () => {
  test('POST /api/mailing/:id/enviar → 200, encola destinatarios', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post(`/api/mailing/${campanaId}/enviar`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Number(res.body.destinatarios)).toBeGreaterThanOrEqual(1);

    // Verificar que la cola se pobló
    const { rows } = await pool.query(
      'SELECT COUNT(*) AS n FROM cola_mailing WHERE campana_id = $1 AND estado = $2',
      [campanaId, 'pendiente']
    );
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(1);

    // Verificar que la campaña pasó a 'enviando'
    const { rows: [camp] } = await pool.query(
      'SELECT estado FROM campanas WHERE id = $1', [campanaId]
    );
    expect(camp.estado).toBe('enviando');
  });

  test('POST /api/mailing/:id/enviar segunda vez → 409 (ya está enviando)', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.post(`/api/mailing/${campanaId}/enviar`);
    expect(res.status).toBe(409);
  });
});

// ── Borrado lógico ────────────────────────────────────────────────────────────
describe('Mailing — eliminar', () => {
  test('DELETE campaña enviando → borrado lógico (is_active = false)', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.delete(`/api/mailing/${campanaId}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const { rows: [c] } = await pool.query(
      'SELECT is_active FROM campanas WHERE id = $1', [campanaId]
    );
    expect(c.is_active).toBe(false);
  });

  test('GET /api/mailing ya no incluye la campaña eliminada', async () => {
    const ag = agent(); await login(ag);
    const res = await ag.get('/api/mailing');
    expect(res.status).toBe(200);
    expect(res.body.some(c => c.id === campanaId)).toBe(false);
  });
});
