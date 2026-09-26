import request from 'supertest';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { jest } from '@jest/globals';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import { importadores } from '../../src/modules/rpa/services/flexibleService.js';

jest.setTimeout(30000);

// IMPORTANTE: el importador real (aplicar) retiraría a todo el padrón de la BD local (copia del real, con las guardas apagadas en test).
// Aquí se reemplaza por un stub: se prueba el flujo (estados, permisos, revisión humana), no el sync, que ya cubre asociados.test.js.

let app;
const pass = 'testpass123';
const u = {
  admin : { email: 'rpaflex-admin@icebreaker.com',  rpa: ['READ', 'WRITE', 'APROBAR', 'ADMIN'], asociados: ['READ', 'WRITE'], id: null },
  soloRpa: { email: 'rpaflex-solorpa@icebreaker.com', rpa: ['READ', 'WRITE', 'APROBAR'], asociados: [], id: null },
  lector: { email: 'rpaflex-lector@icebreaker.com', rpa: ['READ'], asociados: [], id: null },
};
const CSV_OK = 'linea,codigo,apellido,nombre\n1,777001,PRUEBA UNO,ANA\n1,777002,PRUEBA DOS,BEA\n';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let admin; let soloRpa; let lector; let ag; let ag2;

const login = async (x) => {
  const a = request.agent(app);
  await a.post('/api/auth/login').send({ email: x.email, password: pass });
  return a;
};
const crearAgente = async (nombre) => {
  const r = await admin.post('/api/rpa/agentes').send({ nombre });
  return { id: r.body.id, token: r.body.token };
};
const conAgente = (a) => (metodo, ruta) => request(app)[metodo](`/api/rpa/agente${ruta}`)
  .set('Authorization', `Bearer ${a.token}`).set('X-Requested-With', 'XMLHttpRequest');
const limpiar = async () => {
  await pool.query(`DELETE FROM rpa_flexibles WHERE solicitada_por = ANY($1)`, [Object.values(u).map((x) => x.id).filter(Boolean)]);
  await pool.query(`DELETE FROM rpa_agentes WHERE nombre LIKE 'agente-test-flex%'`);
};
const subir = (a, id, body, extra = {}) => conAgente(a)('post', `/flexibles/${id}/archivo`)
  .set('Content-Type', 'text/csv').set('X-Nombre-Archivo', encodeURIComponent('FLEXIBLE - 2026-09-25 18.30.csv')).set(extra).send(body);
const solicitarYReclamar = async (a) => {
  const s = await admin.post('/api/rpa/flexibles');
  const r = await conAgente(a)('post', '/tareas/reclamar').send({});
  return { id: s.body.id, tarea: r.body.tarea };
};

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  for (const x of Object.values(u)) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
       VALUES ('Rpa Flex Test', $1, $2, 'asesor', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true RETURNING id`, [x.email, hash]);
    x.id = r.id;
    await pool.query(`DELETE FROM permisos WHERE usuario_uuid = $1`, [x.id]);
    for (const [modulo, acciones] of [['rpa', x.rpa], ['asociados', x.asociados]]) {
      if (!acciones.length) continue;
      await pool.query(
        `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
         SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = $3 AND a.nombre = ANY($2) ON CONFLICT DO NOTHING`, [x.id, acciones, modulo]);
    }
  }
  await limpiar();
  admin = await login(u.admin); soloRpa = await login(u.soloRpa); lector = await login(u.lector);
  ag = await crearAgente('agente-test-flex-1');
  ag2 = await crearAgente('agente-test-flex-2');
});

afterAll(async () => {
  await limpiar();
  await pool.query(`DELETE FROM permisos WHERE usuario_uuid = ANY($1)`, [Object.values(u).map((x) => x.id)]);
  await pool.query(`DELETE FROM global_usuarios WHERE email LIKE 'rpaflex-%@icebreaker.com'`);
  await pool.end();
});

beforeEach(async () => { await pool.query(`UPDATE rpa_flexibles SET estado = 'cancelada' WHERE estado IN ('solicitada','ejecutando')`); });

describe('Flexible — permisos y solicitud', () => {
  test('sin sesión 401; el lector ve la lista pero no puede pedir el flexible', async () => {
    expect((await request(app).get('/api/rpa/flexibles')).status).toBe(401);
    expect((await lector.get('/api/rpa/flexibles')).status).toBe(200);
    expect((await lector.post('/api/rpa/flexibles')).status).toBe(403);
  });

  test('solicitar crea la tarea y no se permite una segunda mientras hay una en curso', async () => {
    const s = await admin.post('/api/rpa/flexibles');
    expect(s.status).toBe(201);
    expect(s.body.estado).toBe('solicitada');
    expect((await admin.post('/api/rpa/flexibles')).status).toBe(409);
  });

  test('una solicitud que el agente aún no empezó se puede cancelar', async () => {
    const s = await admin.post('/api/rpa/flexibles');
    const c = await admin.post(`/api/rpa/flexibles/${s.body.id}/cancelar`);
    expect(c.status).toBe(200);
    expect(c.body.estado).toBe('cancelada');
    expect((await admin.post('/api/rpa/flexibles')).status).toBe(201);       // ya se puede pedir otra
  });
});

describe('Flexible — el agente', () => {
  test('sin token de agente no hay tareas; un agente pausado no recibe nada; el activo la recibe y queda ejecutando', async () => {
    expect((await request(app).post('/api/rpa/agente/tareas/reclamar')).status).toBe(401);
    const s = await admin.post('/api/rpa/flexibles');
    await admin.put(`/api/rpa/agentes/${ag2.id}`).send({ pausado: true });
    expect((await conAgente(ag2)('post', '/tareas/reclamar').send({})).body.tarea).toBeNull();
    await admin.put(`/api/rpa/agentes/${ag2.id}`).send({ pausado: false });
    const r = await conAgente(ag)('post', '/tareas/reclamar').send({});
    expect(r.body.tarea).toEqual({ id: s.body.id, tipo: 'flexible' });
    expect((await admin.get(`/api/rpa/flexibles/${s.body.id}`)).body.estado).toBe('ejecutando');
    expect((await conAgente(ag)('post', '/tareas/reclamar').send({})).body.tarea).toBeNull();   // no hay otra
  });

  test('entrega del CSV: queda recibida con su tamaño, filas y SHA-256; NADA se aplica solo', async () => {
    const { id } = await solicitarYReclamar(ag);
    const body = Buffer.from(CSV_OK);
    const r = await subir(ag, id, body, { 'X-Sha256': sha(body) });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ estado: 'recibida', filas: 2 });
    const f = (await admin.get(`/api/rpa/flexibles/${id}`)).body;
    expect(f).toMatchObject({ estado: 'recibida', tamano_bytes: body.length, sha256: sha(body), tiene_archivo: true, nombre_archivo: 'FLEXIBLE - 2026-09-25 18.30.csv' });
    const { rows } = await pool.query(`SELECT count(*)::int n FROM asociados WHERE codigo IN ('777001','777002')`);
    expect(rows[0].n).toBe(0);
  });

  test('un SHA-256 que no coincide se rechaza (archivo alterado en el envío)', async () => {
    const { id } = await solicitarYReclamar(ag);
    const r = await subir(ag, id, Buffer.from(CSV_OK), { 'X-Sha256': 'a'.repeat(64) });
    expect(r.status).toBe(400);
    expect((await admin.get(`/api/rpa/flexibles/${id}`)).body.estado).toBe('ejecutando');   // sigue esperando un envío correcto
  });

  test('un archivo que no es el padrón deja la exportación en fallida con el motivo', async () => {
    const { id } = await solicitarYReclamar(ag);
    const r = await subir(ag, id, Buffer.from('foo,bar\n1,2\n'));
    expect(r.body.estado).toBe('fallida');
    expect(r.body.error ?? (await admin.get(`/api/rpa/flexibles/${id}`)).body.error).toMatch(/filas válidas|padrón/i);
  });

  test('otro agente no puede entregar una exportación ajena; el agente puede reportar un fallo', async () => {
    const { id } = await solicitarYReclamar(ag);
    expect((await subir(ag2, id, Buffer.from(CSV_OK))).status).toBe(409);
    const f = await conAgente(ag)('post', `/flexibles/${id}/fallo`).send({ error: 'Excel no abrió el archivo' });
    expect(f.body.estado).toBe('fallida');
    expect((await admin.get(`/api/rpa/flexibles/${id}`)).body.error).toMatch(/Excel/);
  });

  test('una exportación que el agente dejó colgada más de 45 min se da por fallida y se puede pedir otra', async () => {
    const { id } = await solicitarYReclamar(ag);
    await pool.query(`UPDATE rpa_flexibles SET iniciada_at = NOW() - interval '2 hours' WHERE id = $1`, [id]);
    const s = await admin.post('/api/rpa/flexibles');
    expect(s.status).toBe(201);
    expect((await admin.get(`/api/rpa/flexibles/${id}`)).body.estado).toBe('fallida');
  });
});

describe('Flexible — revisión humana', () => {
  let original;
  beforeAll(() => { original = { ...importadores }; });
  afterEach(() => { Object.assign(importadores, original); });

  const recibida = async () => {
    const { id } = await solicitarYReclamar(ag);
    await subir(ag, id, Buffer.from(CSV_OK));
    return id;
  };

  test('el análisis de impacto no escribe nada y solo lo ve quien puede aprobar', async () => {
    const id = await recibida();
    expect((await lector.get(`/api/rpa/flexibles/${id}/analisis`)).status).toBe(403);
    const r = await admin.get(`/api/rpa/flexibles/${id}/analisis`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('impacto');
    expect(r.body.validos).toBe(2);
    expect((await admin.get(`/api/rpa/flexibles/${id}`)).body.estado).toBe('recibida');
  });

  test('aprobar exige rpa APROBAR Y asociados WRITE; con ambos aplica y queda aplicada con quién y qué resultado', async () => {
    const id = await recibida();
    importadores.aplicar = async (req, res) => { expect(req.file.buffer.toString()).toBe(CSV_OK); expect(req.user.id).toBe(u.admin.id); expect(req.file.originalname).toMatch(/FLEXIBLE.*\(agente RPA\)/); res.json({ nuevos: 2, retirados: 0 }); };   // el historial de sincronizaciones guarda el nombre del archivo
    expect((await lector.post(`/api/rpa/flexibles/${id}/aplicar`)).status).toBe(403);
    expect((await soloRpa.post(`/api/rpa/flexibles/${id}/aplicar`)).status).toBe(403);       // sin permiso sobre asociados
    const r = await admin.post(`/api/rpa/flexibles/${id}/aplicar`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ aplicada: true, nuevos: 2 });
    const f = (await admin.get(`/api/rpa/flexibles/${id}`)).body;
    expect(f).toMatchObject({ estado: 'aplicada', revisada_por_nombre: 'Rpa Flex Test' });
    expect(f.resultado).toMatchObject({ nuevos: 2 });
    expect((await admin.post(`/api/rpa/flexibles/${id}/aplicar`)).status).toBe(409);            // no se aplica dos veces
  });

  test('si el importador rechaza el archivo (guardas), sigue pendiente de revisión y devuelve el motivo', async () => {
    const id = await recibida();
    importadores.aplicar = async (_req, res) => res.status(422).json({ error: 'Este sync retiraría 900 asociados (44 %). El límite es 20 %.' });
    const r = await admin.post(`/api/rpa/flexibles/${id}/aplicar`);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ aplicada: false });
    expect(r.body.error).toMatch(/retiraría/);
    expect((await admin.get(`/api/rpa/flexibles/${id}`)).body.estado).toBe('recibida');
  });

  test('un error inesperado del importador no deja la exportación bloqueada en "aplicando"', async () => {
    const id = await recibida();
    importadores.aplicar = async () => { throw new Error('boom'); };
    expect((await admin.post(`/api/rpa/flexibles/${id}/aplicar`)).status).toBe(500);
    expect((await admin.get(`/api/rpa/flexibles/${id}`)).body.estado).toBe('recibida');
  });

  test('rechazar exige una nota y la deja rechazada; ya no se puede aplicar', async () => {
    const id = await recibida();
    expect((await admin.post(`/api/rpa/flexibles/${id}/rechazar`).send({ nota: 'no' })).status).toBe(400);
    const r = await admin.post(`/api/rpa/flexibles/${id}/rechazar`).send({ nota: 'El archivo es de otra fecha' });
    expect(r.body).toMatchObject({ estado: 'rechazada', nota: 'El archivo es de otra fecha' });
    expect((await admin.post(`/api/rpa/flexibles/${id}/aplicar`)).status).toBe(409);
  });

  test('el archivo guardado se puede descargar (solo quien aprueba)', async () => {
    const id = await recibida();
    expect((await lector.get(`/api/rpa/flexibles/${id}/archivo`)).status).toBe(403);
    const r = await admin.get(`/api/rpa/flexibles/${id}/archivo`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.text).toBe(CSV_OK);
  });
});
