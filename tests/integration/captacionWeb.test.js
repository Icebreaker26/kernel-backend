import request from 'supertest';
import bcrypt from 'bcrypt';
import { jest } from '@jest/globals';

jest.setTimeout(30000);

// El asesor por defecto se lee de la configuración al cargar: se fija antes de importar la app
const ASESOR_WEB = '5a1f0c1e-0000-4000-8000-00000000c0de';
process.env.CAPTACION_ASESOR_WEB_UUID = ASESOR_WEB;

const { createApp } = await import('../../src/createApp.js');
const { default: pool } = await import('../../src/db/database.js');

let app;
const empresa = 'EMP-WEB-TEST';
const email = 'captacion-web-test@kernel.test';
const pass = 'testpass123';
const creados = [];

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  await pool.query(
    `INSERT INTO global_usuarios (id, nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ($1, 'Asesor Web Test', $2, $3, 'asesor', true, true)
     ON CONFLICT (email) DO UPDATE SET id = EXCLUDED.id, password_hash = EXCLUDED.password_hash, is_active = true`,
    [ASESOR_WEB, email, hash]
  );
  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a
      WHERE m.nombre = 'captacion' AND a.nombre IN ('READ','WRITE') ON CONFLICT DO NOTHING`, [ASESOR_WEB]
  );
  await pool.query(`INSERT INTO empresas (codigo, nombre) VALUES ($1, 'Empresa Web Test') ON CONFLICT (codigo) DO UPDATE SET is_active = true`, [empresa]);
});

afterAll(async () => {
  await pool.query(`DELETE FROM captacion_eventos WHERE prospecto_id IN (SELECT id FROM captacion_prospectos WHERE asesor_uuid = $1)`, [ASESOR_WEB]);
  await pool.query(`DELETE FROM captacion_vinculaciones WHERE prospecto_id IN (SELECT id FROM captacion_prospectos WHERE asesor_uuid = $1)`, [ASESOR_WEB]);
  await pool.query(`DELETE FROM captacion_prospectos WHERE asesor_uuid = $1`, [ASESOR_WEB]);
  await pool.query(`DELETE FROM empresas WHERE codigo = $1`, [empresa]);
  await pool.query(`DELETE FROM permisos WHERE usuario_uuid = $1`, [ASESOR_WEB]);
  await pool.query(`DELETE FROM global_usuarios WHERE id = $1`, [ASESOR_WEB]);
  await pool.end();
});

describe('Captación — página pública /asociate', () => {
  test('GET /pub/web — disponible, con empresas activas y las tarifas oficiales, sin datos del asesor', async () => {
    const res = await request(app).get('/api/captacion/pub/web');
    expect(res.status).toBe(200);
    expect(res.body.disponible).toBe(true);
    expect(res.body.empresas).toContainEqual({ codigo: empresa, nombre: 'Empresa Web Test' });
    expect(res.body.tarifas).toMatchObject({ aporte_minimo: 74000, fondo_bienestar: 5300 });
    expect(JSON.stringify(res.body)).not.toContain(ASESOR_WEB);
  });

  test('POST /pub/web/iniciar — sin empresa, vacía, inexistente o con campos de más → 400', async () => {
    const post = (b) => request(app).post('/api/captacion/pub/web/iniciar').send(b);
    expect((await post({})).status).toBe(400);
    expect((await post({ empresa_codigo: '' })).status).toBe(400);
    expect((await post({ empresa_codigo: 'NO-EXISTE' })).status).toBe(400);
    expect((await post({ empresa_codigo: empresa, asesor_uuid: 'otro' })).status).toBe(400); // .strict(): no acepta elegir asesor
  });

  test('POST /pub/web/iniciar — crea un prospecto sin identificar de esa empresa, asignado al asesor por defecto y marcado como web', async () => {
    const res = await request(app).post('/api/captacion/pub/web/iniciar').send({ empresa_codigo: empresa });
    expect(res.status).toBe(201);
    expect(res.body.token).toHaveLength(43);
    creados.push(res.body.token);

    const { rows: [p] } = await pool.query(
      `SELECT id, asesor_uuid, empresa_codigo, nombres, cedula, acepta_habeas_data FROM captacion_prospectos WHERE token = $1`, [res.body.token]);
    expect(p).toMatchObject({ asesor_uuid: ASESOR_WEB, empresa_codigo: empresa, nombres: '', acepta_habeas_data: false });
    expect(p.cedula).toMatch(/^STAND_/);
    expect((await pool.query(`SELECT 1 FROM captacion_eventos WHERE prospecto_id = $1 AND tipo = 'web_init'`, [p.id])).rowCount).toBe(1);

    // El enlace personal funciona, pide identificarse y pide primero la autorización de datos
    const get = await request(app).get(`/api/captacion/pub/${res.body.token}`);
    expect(get.status).toBe(200);
    expect(get.body.requiere_identificacion).toBe(true);
    expect(get.body.requiere_habeas_data).toBe(true);
  });

  test('el prospecto de la web aparece con origen "web" en la lista del asesor cuando se identifica', async () => {
    const token = creados[0];
    expect((await request(app).post(`/api/captacion/pub/${token}/habeas-data`).send({ acepta: true, version: 'hd-v1.0' })).status).toBe(200);
    expect((await request(app).put(`/api/captacion/pub/${token}/personal`).send({ nombres: 'Ana', apellidos: 'Web', cedula: '77777771' })).status).toBe(200);

    const ag = request.agent(app);
    await ag.post('/api/auth/login').send({ email, password: pass });
    const lista = await ag.get('/api/captacion/prospectos');
    const fila = lista.body.find((x) => x.cedula === '77777771');
    expect(fila).toBeTruthy();
    expect(fila.origen).toBe('web');
  });

  test('si el asesor por defecto se desactiva, la página avisa que no está disponible y no crea prospectos', async () => {
    await pool.query(`UPDATE global_usuarios SET is_active = false WHERE id = $1`, [ASESOR_WEB]);
    try {
      expect((await request(app).get('/api/captacion/pub/web')).body).toEqual({ disponible: false });
      const antes = (await pool.query('SELECT COUNT(*)::int AS n FROM captacion_prospectos WHERE asesor_uuid = $1', [ASESOR_WEB])).rows[0].n;
      const res = await request(app).post('/api/captacion/pub/web/iniciar').send({ empresa_codigo: empresa });
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('WEB_NO_DISPONIBLE');
      expect((await pool.query('SELECT COUNT(*)::int AS n FROM captacion_prospectos WHERE asesor_uuid = $1', [ASESOR_WEB])).rows[0].n).toBe(antes);
    } finally {
      await pool.query(`UPDATE global_usuarios SET is_active = true WHERE id = $1`, [ASESOR_WEB]);
    }
  });
});
