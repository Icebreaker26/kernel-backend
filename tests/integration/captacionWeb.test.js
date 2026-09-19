import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';

let app;
const pass = 'testpass123';
const empresa = 'EMP-WEB-TEST';
const usuarios = {
  asesor:       { email: 'captacion-web-asesor@kernel.test', permisos: ['READ', 'WRITE'], id: null },              // puede recibir solicitudes
  configurador: { email: 'captacion-web-config@kernel.test', permisos: ['READ', 'CONFIGURAR'], id: null },         // puede elegir el asesor
  lector:       { email: 'captacion-web-lector@kernel.test', permisos: ['READ'], id: null },                       // ni una cosa ni la otra
};
const creados = [];

const login = async (quien) => {
  const ag = request.agent(app);
  await ag.post('/api/auth/login').send({ email: usuarios[quien].email, password: pass });
  return ag;
};

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  for (const u of Object.values(usuarios)) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
       VALUES ('Web Test', $1, $2, 'asesor', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true RETURNING id`, [u.email, hash]);
    u.id = r.id;
    await pool.query(
      `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
       SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'captacion' AND a.nombre = ANY($2) ON CONFLICT DO NOTHING`,
      [u.id, u.permisos]);
  }
  await pool.query(`INSERT INTO empresas (codigo, nombre) VALUES ($1, 'Empresa Web Test') ON CONFLICT (codigo) DO UPDATE SET is_active = true`, [empresa]);
  await pool.query(`DELETE FROM captacion_config WHERE clave = 'web_asesor_uuid'`);
});

afterAll(async () => {
  const ids = Object.values(usuarios).map((u) => u.id);
  await pool.query(`DELETE FROM captacion_config WHERE clave = 'web_asesor_uuid'`);
  await pool.query(`DELETE FROM captacion_eventos WHERE prospecto_id IN (SELECT id FROM captacion_prospectos WHERE asesor_uuid = ANY($1))`, [ids]);
  await pool.query(`DELETE FROM captacion_vinculaciones WHERE prospecto_id IN (SELECT id FROM captacion_prospectos WHERE asesor_uuid = ANY($1))`, [ids]);
  await pool.query(`DELETE FROM captacion_prospectos WHERE asesor_uuid = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM empresas WHERE codigo = $1`, [empresa]);
  await pool.query(`DELETE FROM permisos WHERE usuario_uuid = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM global_usuarios WHERE id = ANY($1)`, [ids]);
  await pool.end();
});

describe('Captación — configuración de la página /asociate (desde la interfaz)', () => {
  test('sin asesor elegido, la página pública no está disponible y no crea prospectos', async () => {
    expect((await request(app).get('/api/captacion/pub/web')).body).toEqual({ disponible: false });
    const res = await request(app).post('/api/captacion/pub/web/iniciar').send({ empresa_codigo: empresa });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('WEB_NO_DISPONIBLE');
  });

  test('GET /config/web exige sesión; un lector ve el enlace pero no puede configurar ni ve candidatos', async () => {
    expect((await request(app).get('/api/captacion/config/web')).status).toBe(401);
    const res = await (await login('lector')).get('/api/captacion/config/web');
    expect(res.status).toBe(200);
    expect(res.body.enlace).toMatch(/\/asociate$/);
    expect(res.body).toMatchObject({ asesor: null, puede_configurar: false, candidatos: [] });
  });

  test('PUT /config/web — sin el permiso CONFIGURAR → 403', async () => {
    for (const quien of ['lector', 'asesor']) {
      const res = await (await login(quien)).put('/api/captacion/config/web').send({ asesor_uuid: usuarios.asesor.id });
      expect(res.status).toBe(403);
    }
  });

  test('el configurador ve los candidatos: solo usuarios activos que pueden escribir en captación', async () => {
    const res = await (await login('configurador')).get('/api/captacion/config/web');
    expect(res.body.puede_configurar).toBe(true);
    const ids = res.body.candidatos.map((c) => c.id);
    expect(ids).toContain(usuarios.asesor.id);
    expect(ids).not.toContain(usuarios.lector.id);        // solo READ: no puede atender solicitudes
    expect(ids).not.toContain(usuarios.configurador.id);  // CONFIGURAR sin WRITE tampoco
  });

  test('PUT /config/web — valida el cuerpo y que el usuario elegido pueda atender solicitudes', async () => {
    const ag = await login('configurador');
    expect((await ag.put('/api/captacion/config/web').send({})).status).toBe(400);
    expect((await ag.put('/api/captacion/config/web').send({ asesor_uuid: 'no-es-uuid' })).status).toBe(400);
    expect((await ag.put('/api/captacion/config/web').send({ asesor_uuid: usuarios.asesor.id, otro: 1 })).status).toBe(400);
    const sinPermiso = await ag.put('/api/captacion/config/web').send({ asesor_uuid: usuarios.lector.id });
    expect(sinPermiso.status).toBe(400);
    const noExiste = await ag.put('/api/captacion/config/web').send({ asesor_uuid: '00000000-0000-4000-8000-000000000000' });
    expect(noExiste.status).toBe(400);
    expect((await pool.query(`SELECT 1 FROM captacion_config WHERE clave = 'web_asesor_uuid'`)).rowCount).toBe(0);
  });

  test('al elegir el asesor, la página pública queda disponible con empresas y tarifas, sin exponer al asesor', async () => {
    const put = await (await login('configurador')).put('/api/captacion/config/web').send({ asesor_uuid: usuarios.asesor.id });
    expect(put.status).toBe(200);
    const { rows: [c] } = await pool.query(`SELECT valor, actualizado_por FROM captacion_config WHERE clave = 'web_asesor_uuid'`);
    expect(c).toEqual({ valor: usuarios.asesor.id, actualizado_por: usuarios.configurador.id });

    const res = await request(app).get('/api/captacion/pub/web');
    expect(res.body.disponible).toBe(true);
    expect(res.body.empresas).toContainEqual({ codigo: empresa, nombre: 'Empresa Web Test' });
    expect(res.body.tarifas).toMatchObject({ aporte_minimo: 74000, fondo_bienestar: 5300 });
    expect(JSON.stringify(res.body)).not.toContain(usuarios.asesor.id);

    const cfg = (await (await login('lector')).get('/api/captacion/config/web')).body;
    expect(cfg.asesor).toMatchObject({ id: usuarios.asesor.id, nombre: 'Web Test' });
  });

  test('POST /pub/web/iniciar — valida la empresa y no deja elegir asesor', async () => {
    const post = (b) => request(app).post('/api/captacion/pub/web/iniciar').send(b);
    expect((await post({})).status).toBe(400);
    expect((await post({ empresa_codigo: '' })).status).toBe(400);
    expect((await post({ empresa_codigo: 'NO-EXISTE' })).status).toBe(400);
    expect((await post({ empresa_codigo: empresa, asesor_uuid: 'otro' })).status).toBe(400);
  });

  test('crea un prospecto sin identificar de esa empresa, asignado al asesor elegido y marcado como web', async () => {
    const res = await request(app).post('/api/captacion/pub/web/iniciar').send({ empresa_codigo: empresa });
    expect(res.status).toBe(201);
    expect(res.body.token).toHaveLength(43);
    creados.push(res.body.token);

    const { rows: [p] } = await pool.query(
      `SELECT id, asesor_uuid, empresa_codigo, nombres, cedula, acepta_habeas_data FROM captacion_prospectos WHERE token = $1`, [res.body.token]);
    expect(p).toMatchObject({ asesor_uuid: usuarios.asesor.id, empresa_codigo: empresa, nombres: '', acepta_habeas_data: false });
    expect(p.cedula).toMatch(/^STAND_/);
    expect((await pool.query(`SELECT 1 FROM captacion_eventos WHERE prospecto_id = $1 AND tipo = 'web_init'`, [p.id])).rowCount).toBe(1);

    const get = await request(app).get(`/api/captacion/pub/${res.body.token}`);
    expect(get.body).toMatchObject({ requiere_identificacion: true, requiere_habeas_data: true });
  });

  test('el prospecto de la web aparece con origen "web" en la lista del asesor cuando se identifica', async () => {
    const token = creados[0];
    expect((await request(app).post(`/api/captacion/pub/${token}/habeas-data`).send({ acepta: true, version: 'hd-v1.0' })).status).toBe(200);
    expect((await request(app).put(`/api/captacion/pub/${token}/personal`).send({ nombres: 'Ana', apellidos: 'Web', cedula: '77777771' })).status).toBe(200);

    const lista = await (await login('asesor')).get('/api/captacion/prospectos');
    const fila = lista.body.find((x) => x.cedula === '77777771');
    expect(fila).toBeTruthy();
    expect(fila.origen).toBe('web');
  });

  test('si el asesor elegido se desactiva, la página avisa que no está disponible y el panel no lo muestra', async () => {
    await pool.query(`UPDATE global_usuarios SET is_active = false WHERE id = $1`, [usuarios.asesor.id]);
    try {
      expect((await request(app).get('/api/captacion/pub/web')).body).toEqual({ disponible: false });
      expect((await request(app).post('/api/captacion/pub/web/iniciar').send({ empresa_codigo: empresa })).status).toBe(503);
      expect((await (await login('lector')).get('/api/captacion/config/web')).body.asesor).toBeNull();
    } finally {
      await pool.query(`UPDATE global_usuarios SET is_active = true WHERE id = $1`, [usuarios.asesor.id]);
    }
  });

  test('PUT /config/web con asesor_uuid null quita la asignación y la página deja de estar disponible', async () => {
    const put = await (await login('configurador')).put('/api/captacion/config/web').send({ asesor_uuid: null });
    expect(put.status).toBe(200);
    expect((await request(app).get('/api/captacion/pub/web')).body).toEqual({ disponible: false });
  });
});
