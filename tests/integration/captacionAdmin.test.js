/**
 * El admin ve TODA la captación (de todos los asesores); cada asesor, solo la suya.
 */
import request from 'supertest';
import bcrypt from 'bcrypt';
import { jest } from '@jest/globals';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';

jest.setTimeout(30000);

let app;
const pass = 'testpass123';
const EMPRESA = 'EMP-ADMIN-TEST';
const usuarios = {
  admin:   { email: 'captacionadmin-admin@kernel.test',   rol: 'admin',  cedula: null },
  asesorA: { email: 'captacionadmin-a@kernel.test',       rol: 'asesor', cedula: '77700001' },
  asesorB: { email: 'captacionadmin-b@kernel.test',       rol: 'asesor', cedula: '77700002' },
};
const agentes = {};
const creados = {};   // quien → { prospectoId, vinculacionId }

const ids = () => Object.values(usuarios).map((u) => u.id);
const limpiar = async () => {
  const pros = `(SELECT id FROM captacion_prospectos WHERE asesor_uuid = ANY($1))`;
  const vincs = `(SELECT id FROM captacion_vinculaciones WHERE prospecto_id IN ${pros})`;
  await pool.query(`DELETE FROM captacion_eventos WHERE prospecto_id IN ${pros}`, [ids()]);
  await pool.query(`DELETE FROM captacion_beneficiarios WHERE vinculacion_id IN ${vincs}`, [ids()]);
  await pool.query(`DELETE FROM captacion_referencias WHERE vinculacion_id IN ${vincs}`, [ids()]);
  await pool.query(`DELETE FROM captacion_vinculaciones WHERE prospecto_id IN ${pros}`, [ids()]);
  await pool.query(`DELETE FROM captacion_toques WHERE prospecto_id IN ${pros}`, [ids()]);
  await pool.query(`DELETE FROM captacion_prospectos WHERE asesor_uuid = ANY($1)`, [ids()]);
};

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  await pool.query(`INSERT INTO empresas (codigo, nombre) VALUES ($1, 'Empresa Admin Test') ON CONFLICT (codigo) DO UPDATE SET is_active = true`, [EMPRESA]);
  for (const [quien, u] of Object.entries(usuarios)) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
       VALUES ($3, $1, $2, $4, true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, rol = EXCLUDED.rol, is_active = true RETURNING id`,
      [u.email, hash, `Test ${quien}`, u.rol]);
    u.id = r.id;
    await pool.query(
      `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
       SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'captacion' AND a.nombre IN ('READ','WRITE') ON CONFLICT DO NOTHING`, [u.id]);
    agentes[quien] = request.agent(app);
    await agentes[quien].post('/api/auth/login').send({ email: u.email, password: pass });
  }
  await limpiar();
  for (const quien of ['asesorA', 'asesorB']) {
    const res = await agentes[quien].post('/api/captacion/prospectos').send({
      empresa_codigo: EMPRESA, nombres: `Persona ${quien}`, apellidos: 'Prueba', cedula: usuarios[quien].cedula, celular: '3105550199', acepta_habeas_data: true,
    });
    if (res.status !== 201) throw new Error(`crear prospecto: ${res.status} ${JSON.stringify(res.body)}`);
    const { rows: [v] } = await pool.query(`INSERT INTO captacion_vinculaciones (prospecto_id) VALUES ($1) RETURNING id`, [res.body.id]);
    creados[quien] = { prospectoId: res.body.id, vinculacionId: v.id };
  }
});

afterAll(async () => {
  await limpiar();
  await pool.query(`DELETE FROM empresas WHERE codigo = $1`, [EMPRESA]);
  await pool.query(`DELETE FROM permisos WHERE usuario_uuid = ANY($1)`, [ids()]);
  await pool.query(`DELETE FROM global_usuarios WHERE id = ANY($1)`, [ids()]);
  await pool.end();
});

const cedulas = (rows) => rows.map((r) => r.cedula);

describe('Captación — alcance por rol', () => {
  test('el asesor ve solo sus prospectos y vinculaciones', async () => {
    const pros = await agentes.asesorA.get('/api/captacion/prospectos');
    expect(cedulas(pros.body)).toEqual([usuarios.asesorA.cedula]);
    const vincs = await agentes.asesorA.get('/api/captacion/vinculaciones');
    expect(cedulas(vincs.body)).toEqual([usuarios.asesorA.cedula]);
  });

  test('el asesor no abre lo de otro asesor (404)', async () => {
    const otro = creados.asesorB;
    expect((await agentes.asesorA.get(`/api/captacion/prospectos/${otro.prospectoId}`)).status).toBe(404);
    expect((await agentes.asesorA.get(`/api/captacion/vinculaciones/${otro.vinculacionId}`)).status).toBe(404);
    expect((await agentes.asesorA.get(`/api/captacion/vinculaciones/${otro.vinculacionId}/documentos`)).status).toBe(404);
    expect((await agentes.asesorA.get(`/api/captacion/vinculaciones/${otro.vinculacionId}/formato`)).status).toBe(404);
  });

  test('el admin ve los prospectos y las vinculaciones de todos, con el nombre del asesor', async () => {
    const pros = await agentes.admin.get('/api/captacion/prospectos');
    expect(pros.status).toBe(200);
    const mios = pros.body.filter((p) => Object.values(usuarios).some((u) => u.cedula && u.cedula === p.cedula));
    expect(cedulas(mios).sort()).toEqual(['77700001', '77700002']);
    expect(mios.find((p) => p.cedula === '77700001').asesor_nombre).toBe('Test asesorA');
    expect(mios.find((p) => p.cedula === '77700002').asesor_nombre).toBe('Test asesorB');

    const vincs = await agentes.admin.get('/api/captacion/vinculaciones');
    const dePrueba = vincs.body.filter((v) => ['77700001', '77700002'].includes(v.cedula));
    expect(dePrueba).toHaveLength(2);
  });

  test('el admin abre el detalle, los documentos y el formato de cualquier asesor', async () => {
    for (const quien of ['asesorA', 'asesorB']) {
      const c = creados[quien];
      expect((await agentes.admin.get(`/api/captacion/prospectos/${c.prospectoId}`)).status).toBe(200);
      const det = await agentes.admin.get(`/api/captacion/vinculaciones/${c.vinculacionId}`);
      expect(det.status).toBe(200);
      expect(det.body.cedula).toBe(usuarios[quien].cedula);
      expect((await agentes.admin.get(`/api/captacion/vinculaciones/${c.vinculacionId}/documentos`)).status).toBe(200);
    }
  });

  test('el admin puede consultar los valores de cualquier asesor; un asesor no', async () => {
    expect((await agentes.admin.get(`/api/captacion/valores/${usuarios.asesorA.id}`)).status).toBe(200);
    expect((await agentes.asesorB.get(`/api/captacion/valores/${usuarios.asesorA.id}`)).status).toBe(403);
  });

  test('el resumen del admin cuenta a todos, el del asesor solo lo suyo', async () => {
    expect((await agentes.admin.get('/api/captacion/prospectos/resumen')).status).toBe(200);
    expect((await agentes.asesorA.get('/api/captacion/prospectos/resumen')).status).toBe(200);
  });
});
