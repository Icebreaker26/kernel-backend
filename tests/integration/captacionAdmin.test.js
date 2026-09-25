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
  await pool.query(`DELETE FROM captacion_verificaciones_identidad WHERE vinculacion_id IN ${vincs}`, [ids()]);
  await pool.query(`DELETE FROM captacion_correcciones WHERE vinculacion_id IN ${vincs}`, [ids()]);
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

  test('?alcance=todos: el asesor ve las vinculaciones de todos con el nombre del asesor, pero no abre las ajenas', async () => {
    const vincs = await agentes.asesorA.get('/api/captacion/vinculaciones?alcance=todos');
    expect(vincs.status).toBe(200);
    const dePrueba = vincs.body.filter((v) => ['77700001', '77700002'].includes(v.cedula));
    expect(cedulas(dePrueba).sort()).toEqual(['77700001', '77700002']);
    expect(dePrueba.find((v) => v.cedula === '77700002').asesor_nombre).toBe('Test asesorB');
    expect((await agentes.asesorA.get(`/api/captacion/vinculaciones/${creados.asesorB.vinculacionId}`)).status).toBe(404);
  });

  test('?alcance=mias: el admin ve solo las suyas', async () => {
    const vincs = await agentes.admin.get('/api/captacion/vinculaciones?alcance=mias');
    expect(vincs.status).toBe(200);
    expect(vincs.body.every((v) => v.asesor_uuid === usuarios.admin.id)).toBe(true);
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

  test('devolver a subsanar: solo el asesor dueño la pide; el admin la ve pero no la pide; otro asesor no la ve', async () => {
    const otro = creados.asesorB;
    const url = `/api/captacion/vinculaciones/${otro.vinculacionId}/subsanacion`;
    const pedido = { items: ['datos'], motivo: 'Falta corregir un dato del formulario' };
    expect((await agentes.asesorA.post(url).send(pedido)).status).toBe(404);          // ajena
    expect((await agentes.asesorA.get(url)).status).toBe(404);
    expect((await agentes.admin.post(url).send(pedido)).status).toBe(404);            // el admin ve todo, pero no actúa por el asesor
    expect((await agentes.asesorB.post(url).send(pedido)).status).toBe(201);          // el dueño sí
    const admin = await agentes.admin.get(url);
    expect(admin.status).toBe(200);
    expect(admin.body.abierta).toMatchObject({ items: ['datos'] });
  });
});

describe('Captación — verificación de identidad contra la cédula (admin y asesor)', () => {
  const urlDe = (quien) => `/api/captacion/vinculaciones/${creados[quien].vinculacionId}`;
  const quienVerifico = async (quien) => (await pool.query(
    `SELECT asesor_uuid, origen, ip FROM captacion_verificaciones_identidad WHERE vinculacion_id = $1 ORDER BY created_at DESC LIMIT 1`, [creados[quien].vinculacionId])).rows[0];

  test('el admin confirma la identidad de la solicitud de otro asesor y queda registrado él como quien verificó', async () => {
    const res = await agentes.admin.post(`${urlDe('asesorA')}/verificacion-identidad`);
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(await quienVerifico('asesorA')).toMatchObject({ asesor_uuid: usuarios.admin.id, origen: 'confirmada' });
    const info = (await agentes.admin.get(`${urlDe('asesorA')}/correcciones`)).body;
    expect(info.verificacion).toMatchObject({ origen: 'confirmada', cedula: usuarios.asesorA.cedula, vigente: true });
    const { rows: [ev] } = await pool.query(`SELECT autor_tipo, autor_uuid FROM captacion_eventos WHERE vinculacion_id = $1 AND tipo = 'identidad_verificada' ORDER BY created_at DESC LIMIT 1`, [creados.asesorA.vinculacionId]);
    expect(ev.autor_uuid).toBe(usuarios.admin.id);
  });

  test('el asesor dueño la confirma en lo suyo; otro asesor no puede en lo ajeno (404)', async () => {
    expect((await agentes.asesorB.post(`${urlDe('asesorB')}/verificacion-identidad`)).status).toBe(201);
    expect(await quienVerifico('asesorB')).toMatchObject({ asesor_uuid: usuarios.asesorB.id });
    expect((await agentes.asesorA.post(`${urlDe('asesorB')}/verificacion-identidad`)).status).toBe(404);
    expect((await agentes.asesorB.post(`${urlDe('asesorA')}/verificacion-identidad`)).status).toBe(404);
  });

  test('una solicitud inexistente o desactivada responde 404, también al admin', async () => {
    expect((await agentes.admin.post('/api/captacion/vinculaciones/00000000-0000-4000-8000-000000000000/verificacion-identidad')).status).toBe(404);
    const { rows: [v] } = await pool.query(`INSERT INTO captacion_vinculaciones (prospecto_id, is_active) VALUES ($1, false) RETURNING id`, [creados.asesorA.prospectoId]);
    expect((await agentes.admin.post(`/api/captacion/vinculaciones/${v.id}/verificacion-identidad`)).status).toBe(404);
  });

  test('sin cédula o sin nombre, no hay nada que verificar (400), también para el admin', async () => {
    const { rows: [p] } = await pool.query(`SELECT id FROM captacion_prospectos WHERE asesor_uuid = $1`, [usuarios.asesorA.id]);
    const { rows: [v] } = await pool.query(`INSERT INTO captacion_vinculaciones (prospecto_id) VALUES ($1) RETURNING id`, [p.id]);
    await pool.query(`UPDATE captacion_prospectos SET cedula = 'STAND_TEST_001' WHERE id = $1`, [p.id]);
    try {
      expect((await agentes.admin.post(`/api/captacion/vinculaciones/${v.id}/verificacion-identidad`)).status).toBe(400);
    } finally {
      await pool.query(`UPDATE captacion_prospectos SET cedula = $2 WHERE id = $1`, [p.id, usuarios.asesorA.cedula]);
    }
  });

  test('el admin corrige cédula y nombre en la solicitud de otro asesor, con trazabilidad a su nombre', async () => {
    const motivo = 'La cédula dice otro número; se escribió mal en el formulario';
    expect((await agentes.asesorA.put(`${urlDe('asesorB')}/identidad`).send({ cedula: '77700088', motivo })).status).toBe(404);   // otro asesor: no
    const res = await agentes.admin.put(`${urlDe('asesorB')}/identidad`).send({ cedula: '77700088', nombres: 'Persona Corregida', motivo });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, campos: ['cedula', 'nombres'], formato_resellado: false });
    const { rows: [p] } = await pool.query(`SELECT cedula, nombres FROM captacion_prospectos WHERE id = $1`, [creados.asesorB.prospectoId]);
    expect(p).toEqual({ cedula: '77700088', nombres: 'Persona Corregida' });
    const { correcciones, verificacion } = (await agentes.admin.get(`${urlDe('asesorB')}/correcciones`)).body;
    expect(correcciones).toHaveLength(1);
    expect(correcciones[0]).toMatchObject({ antes: { cedula: usuarios.asesorB.cedula }, despues: { cedula: '77700088', nombres: 'Persona Corregida' }, motivo });
    expect(verificacion).toMatchObject({ origen: 'corregida', cedula: '77700088', vigente: true });
    const { rows: [c] } = await pool.query(`SELECT asesor_uuid FROM captacion_correcciones WHERE vinculacion_id = $1`, [creados.asesorB.vinculacionId]);
    expect(c.asesor_uuid).toBe(usuarios.admin.id);
    // Se restablece la cédula original para no afectar a las demás pruebas del archivo
    await pool.query(`UPDATE captacion_prospectos SET cedula = $2, nombres = 'Persona asesorB' WHERE id = $1`, [creados.asesorB.prospectoId, usuarios.asesorB.cedula]);
  });

  test('el admin no puede corregir a una cédula que ya usa otra solicitud (409)', async () => {
    const res = await agentes.admin.put(`${urlDe('asesorB')}/identidad`).send({ cedula: usuarios.asesorA.cedula, motivo: 'Probando que no se repita la cédula' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CEDULA_DUPLICADA');
  });

  test('lo que el admin no puede hacer por el asesor sigue igual: pedir la subsanación (regla ya existente)', async () => {
    const res = await agentes.admin.post(`${urlDe('asesorA')}/subsanacion`).send({ items: ['datos'], motivo: 'Falta corregir un dato del formulario' });
    expect(res.status).toBe(404);
  });
});
