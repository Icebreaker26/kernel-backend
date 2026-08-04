import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';

let app;
const adminEmail = 'gerencia-admin@kernel.test';
const adminPass  = 'testpass123';
let adminUuid;

const agAdmin = () => request.agent(app);

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(adminPass, 4);

  const { rows: [admin] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Gerencia Admin', $1, $2, 'admin', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [adminEmail, hash]
  );
  adminUuid = admin.id;
});

afterAll(async () => {
  await pool.query('DELETE FROM global_usuarios WHERE id = $1', [adminUuid]);
  await pool.end();
});

// ── Auth ─────────────────────────────────────────────────────────────────────

describe('Gerencia — Auth', () => {
  test('Rechaza sin token en /resumen', async () => {
    const res = await request(app).get('/api/gerencia/resumen');
    expect(res.status).toBe(401);
  });

  test('Rechaza sin token en /cobertura/:sorteoId', async () => {
    const res = await request(app).get('/api/gerencia/cobertura/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(401);
  });
});

// ── GET /resumen ──────────────────────────────────────────────────────────────

describe('GET /gerencia/resumen', () => {
  let ag;
  beforeAll(async () => {
    ag = agAdmin();
    await ag.post('/api/auth/login').send({ email: adminEmail, password: adminPass });
  });

  test('Responde 200 con estructura completa', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);

    // Asociados
    expect(res.body).toHaveProperty('asociados');
    expect(res.body.asociados).toHaveProperty('activos');
    expect(res.body.asociados).toHaveProperty('total');
    expect(res.body.asociados).toHaveProperty('con_portal');
    expect(res.body.asociados).toHaveProperty('adopcion_pct');
    expect(res.body.asociados).toHaveProperty('adopcion_serie');
    expect(Array.isArray(res.body.asociados.adopcion_serie)).toBe(true);

    // Sorteos
    expect(res.body).toHaveProperty('sorteos');
    expect(Array.isArray(res.body.sorteos)).toBe(true);

    // Serie sorteos
    expect(res.body).toHaveProperty('sorteos_serie');
    expect(Array.isArray(res.body.sorteos_serie)).toBe(true);

    // Patronales
    expect(res.body).toHaveProperty('patronales');
    expect(res.body.patronales).toHaveProperty('total_causado');
    expect(res.body.patronales).toHaveProperty('total_cobrado');
    expect(res.body.patronales).toHaveProperty('total_mora');
    expect(res.body.patronales).toHaveProperty('empresas_en_deuda');
    expect(res.body.patronales).toHaveProperty('top_mora');
    expect(Array.isArray(res.body.patronales.top_mora)).toBe(true);

    // Logs
    expect(res.body).toHaveProperty('logs');
    expect(Array.isArray(res.body.logs)).toBe(true);

    // Pendientes
    expect(res.body).toHaveProperty('pendientes');
    expect(res.body.pendientes).toHaveProperty('bonos');
    expect(res.body.pendientes).toHaveProperty('portal');
  });

  test('adopcion_pct es número entre 0 y 100', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const pct = res.body.asociados.adopcion_pct;
    expect(typeof pct).toBe('number');
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(100);
  });

  test('adopcion_serie tiene estructura correcta', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    for (const fila of res.body.asociados.adopcion_serie) {
      expect(fila).toHaveProperty('mes');
      expect(fila).toHaveProperty('nuevos');
      expect(fila).toHaveProperty('acumulado');
      expect(typeof fila.acumulado).toBe('number');
      // Acumulado siempre creciente
    }
  });

  test('acumulado de adopción es monótonamente creciente', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const serie = res.body.asociados.adopcion_serie;
    for (let i = 1; i < serie.length; i++) {
      expect(serie[i].acumulado).toBeGreaterThanOrEqual(serie[i - 1].acumulado);
    }
  });

  test('campos numéricos de asociados son enteros no negativos', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    const { activos, total, con_portal } = res.body.asociados;
    expect(Number.isInteger(activos)).toBe(true);
    expect(Number.isInteger(total)).toBe(true);
    expect(Number.isInteger(con_portal)).toBe(true);
    expect(activos).toBeGreaterThanOrEqual(0);
    expect(total).toBeGreaterThanOrEqual(activos);
    expect(con_portal).toBeGreaterThanOrEqual(0);
  });

  test('logs tiene máximo 10 entradas', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    expect(res.body.logs.length).toBeLessThanOrEqual(10);
  });

  test('top_mora tiene máximo 5 entradas', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    expect(res.body.patronales.top_mora.length).toBeLessThanOrEqual(5);
  });

  test('cada sorteo tiene campos requeridos', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    for (const s of res.body.sorteos) {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('nombre');
      expect(s).toHaveProperty('boletos_asignados');
      expect(s).toHaveProperty('boletos_total');
      expect(s).toHaveProperty('ingreso_mensual');
      expect(s).toHaveProperty('solicitudes_pendientes');
    }
  });
});

// ── GET /cobertura/:sorteoId ──────────────────────────────────────────────────

describe('GET /gerencia/cobertura/:sorteoId', () => {
  let ag;
  beforeAll(async () => {
    ag = agAdmin();
    await ag.post('/api/auth/login').send({ email: adminEmail, password: adminPass });
  });

  test('UUID inexistente devuelve array vacío (no error)', async () => {
    const res = await ag.get('/api/gerencia/cobertura/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  test('Con sorteo real devuelve estructura correcta', async () => {
    // Buscar cualquier sorteo existente
    const { rows } = await pool.query(`SELECT id FROM sorteos LIMIT 1`);
    if (!rows.length) return; // Si no hay sorteos, skip

    const sorteoId = rows[0].id;
    const res = await ag.get(`/api/gerencia/cobertura/${sorteoId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    for (const emp of res.body) {
      expect(emp).toHaveProperty('codigo');
      expect(emp).toHaveProperty('nombre');
      expect(emp).toHaveProperty('asociados_activos');
      expect(emp).toHaveProperty('bonos_asignados');
      expect(Number(emp.asociados_activos)).toBeGreaterThan(0);
      expect(Number(emp.bonos_asignados)).toBeGreaterThanOrEqual(0);
    }
  });

  test('UUID mal formado devuelve 500 o 400 (no crash sin respuesta)', async () => {
    const res = await ag.get('/api/gerencia/cobertura/no-es-un-uuid');
    // PostgreSQL rechazará el UUID inválido — debe llegar respuesta (no timeout)
    expect([400, 422, 500]).toContain(res.status);
  });
});
