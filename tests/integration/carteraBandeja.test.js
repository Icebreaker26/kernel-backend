import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';

let app;
const pass = 'testpass123';
const usuarios = {
  cartera: { email: 'bandeja-cartera@kernel.test', permisos: { cartera: ['READ', 'WRITE'] } },
  ana:     { email: 'bandeja-ana@kernel.test',     permisos: { creditos: ['READ', 'WRITE'] } },
  beto:    { email: 'bandeja-beto@kernel.test',    permisos: { creditos: ['READ', 'WRITE'] } },
  nada:    { email: 'bandeja-nada@kernel.test',    permisos: {} },
};
const E = { e1: 'ZZBND-E1', e2: 'ZZBND-E2' };
const A = { a1: 'ZZBND001', a2: 'ZZBND002', a3: 'ZZBND003', a4: 'ZZBND004' };
const ag = {};
let cats;
const ids = {};

const login = async (quien) => { const a = request.agent(app); await a.post('/api/auth/login').send({ email: usuarios[quien].email, password: pass }); return a; };
// Todas las consultas se limitan a los datos de esta prueba con q=ZZBND (código del asociado)
const bandeja = (query = '') => ag.cartera.get(`/api/cartera?q=ZZBND${query}`);
const radicados = (res) => res.body.map((s) => s.radicado);
const de = (...r) => r.map((x) => x.radicado).sort();

const crear = async (asesor, asociado, empresa, extra = {}) => {
  const { rows: [s] } = await pool.query(
    `INSERT INTO credito_solicitudes (radicado, asociado_codigo, empresa_codigo, categoria_id, asesor_uuid, canal_origen, valor_solicitado, forma_desembolso, modalidad_firma,
       autorizacion_requerida, autorizacion_momento, estado, created_at)
     VALUES ('CR-ZZ-' || substr(md5(random()::text), 1, 8), $1, $2, $3, $4, 'presencial', $5, $6, $7, false, 'indiferente', $8, NOW() - ($9 || ' days')::interval) RETURNING id, radicado`,
    [asociado, empresa, extra.categoria ?? cats[0].id, usuarios[asesor].id, extra.valor ?? 1000000, extra.forma ?? 'cheque', extra.modalidad ?? 'externa', extra.estado ?? 'en_tramite', String(extra.dias ?? 0)]);
  return s;
};

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  for (const u of Object.values(usuarios)) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved) VALUES ('Bandeja Test', $1, $2, 'asesor', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true RETURNING id`, [u.email, hash]);
    u.id = r.id;
    for (const [m, acc] of Object.entries(u.permisos)) await pool.query(`INSERT INTO permisos (usuario_uuid, modulo_id, accion_id) SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = $2 AND a.nombre = ANY($3) ON CONFLICT DO NOTHING`, [r.id, m, acc]);
  }
  await pool.query(`UPDATE global_usuarios SET nombre = 'Ana Bandeja' WHERE id = $1`, [usuarios.ana.id]);
  await pool.query(`UPDATE global_usuarios SET nombre = 'Beto Bandeja' WHERE id = $1`, [usuarios.beto.id]);
  await pool.query(`INSERT INTO empresas (codigo, nombre) VALUES ($1, 'Empresa Bandeja Uno'), ($2, 'Empresa Bandeja Dos') ON CONFLICT (codigo) DO NOTHING`, [E.e1, E.e2]);
  for (const [c, e] of [[A.a1, E.e1], [A.a2, E.e1], [A.a3, E.e2], [A.a4, E.e2]]) {
    await pool.query(`INSERT INTO asociados (codigo, nombre, apellido, empresa_dsto, nombre_empresa, is_active) VALUES ($1, 'PRUEBA', $2, $3, 'X', true) ON CONFLICT (codigo) DO NOTHING`, [c, `BANDEJA ${c}`, e]);
  }
  for (const k of Object.keys(usuarios)) ag[k] = await login(k);
  cats = (await ag.ana.get('/api/creditos/categorias')).body;
  ids.r1 = await crear('ana',  A.a1, E.e1, { valor: 1000000, forma: 'transferencia', modalidad: 'externa',    estado: 'entregada', dias: 12, categoria: cats[0].id });
  ids.r2 = await crear('ana',  A.a2, E.e1, { valor: 5000000, forma: 'cheque',        modalidad: 'presencial', estado: 'entregada', dias: 3,  categoria: cats[1].id });
  ids.r3 = await crear('beto', A.a3, E.e2, { valor: 9000000, forma: 'efectivo',      modalidad: 'externa',    estado: 'recibida',  dias: 8,  categoria: cats[0].id });
  ids.r4 = await crear('beto', A.a4, E.e2, { valor: 2000000, forma: 'transferencia', modalidad: 'presencial', estado: 'devuelta',  dias: 5,  categoria: cats[1].id });
  ids.r5 = await crear('beto', A.a4, E.e2, { valor: 7000000, forma: 'cheque',        modalidad: 'externa',    estado: 'completada', dias: 20, categoria: cats[0].id });
  ids.r6 = await crear('ana',  A.a1, E.e1, { valor: 3000000, forma: 'cheque',        modalidad: 'externa',    estado: 'pagada',    dias: 30, categoria: cats[0].id });   // fuera de la bandeja
  ids.r7 = await crear('ana',  A.a2, E.e1, { valor: 4000000, forma: 'cheque',        modalidad: 'externa',    estado: 'en_tramite', dias: 1,  categoria: cats[0].id });
});

afterAll(async () => {
  const uids = Object.values(usuarios).map((u) => u.id);
  await pool.query('ALTER TABLE credito_eventos DISABLE TRIGGER USER');
  try { await pool.query('DELETE FROM credito_solicitudes WHERE asesor_uuid = ANY($1)', [uids]); } finally { await pool.query('ALTER TABLE credito_eventos ENABLE TRIGGER USER'); }
  await pool.query('DELETE FROM asociados WHERE codigo = ANY($1)', [Object.values(A)]);
  await pool.query('DELETE FROM empresas WHERE codigo = ANY($1)', [Object.values(E)]);
  await pool.query('DELETE FROM permisos WHERE usuario_uuid = ANY($1)', [uids]);
  await pool.query('DELETE FROM global_usuarios WHERE id = ANY($1)', [uids]);
  await pool.end();
});

describe('Bandeja de Cartera — acceso', () => {
  test('exige sesión y permiso de Cartera (un asesor no entra)', async () => {
    for (const ruta of ['/api/cartera', '/api/cartera/resumen', '/api/cartera/filtros']) {
      expect((await request(app).get(ruta)).status).toBe(401);
      expect((await ag.nada.get(ruta)).status).toBe(403);
      expect((await ag.ana.get(ruta)).status).toBe(403);
    }
  });

  test('Cartera ve los expedientes de todos los asesores, sin pedir "todas"', async () => {
    const r = await bandeja('&tab=todas');
    expect(radicados(r).sort()).toEqual(de(ids.r1, ids.r2, ids.r3, ids.r4, ids.r5, ids.r7));
    expect(new Set(r.body.map((s) => s.asesor_nombre))).toEqual(new Set(['Ana Bandeja', 'Beto Bandeja']));
  });

  test('un parámetro desconocido se rechaza (el esquema es estricto)', async () => {
    expect((await bandeja('&tab=entregadas&nada=1')).status).toBe(400);
    expect((await bandeja('&todas=1')).status).toBe(400);
  });
});

describe('Bandeja de Cartera — pestañas', () => {
  test('cada pestaña trae solo su estado', async () => {
    expect(radicados(await bandeja('&tab=entregadas')).sort()).toEqual(de(ids.r1, ids.r2));
    expect(radicados(await bandeja('&tab=recibidas'))).toEqual(de(ids.r3));
    expect(radicados(await bandeja('&tab=devueltas'))).toEqual(de(ids.r4));
    expect(radicados(await bandeja('&tab=completadas'))).toEqual(de(ids.r5));
    expect(radicados(await bandeja('&tab=por_llegar'))).toEqual(de(ids.r7));
  });

  test('sin pestaña abre "entregadas"; una inexistente da 400; "todas" no incluye pagadas ni cerradas', async () => {
    expect(radicados(await bandeja()).sort()).toEqual(de(ids.r1, ids.r2));
    expect((await bandeja('&tab=inexistente')).status).toBe(400);
    expect(radicados(await bandeja('&tab=todas'))).not.toContain(ids.r6.radicado);
  });

  test('sin orden elegido, lo que lleva más tiempo esperando va primero', async () => {
    expect(radicados(await bandeja('&tab=entregadas'))).toEqual([ids.r1.radicado, ids.r2.radicado]);   // r1 tiene 12 días, r2 tiene 3
  });
});

describe('Bandeja de Cartera — filtros y orden', () => {
  test('por categoría, empresa, forma y firma', async () => {
    expect(radicados(await bandeja(`&tab=todas&categoria=${cats[1].id}`)).sort()).toEqual(de(ids.r2, ids.r4));
    expect(radicados(await bandeja(`&tab=todas&empresa=${E.e1}`)).sort()).toEqual(de(ids.r1, ids.r2, ids.r7));
    expect(radicados(await bandeja('&tab=todas&forma=transferencia')).sort()).toEqual(de(ids.r1, ids.r4));
    expect(radicados(await bandeja('&tab=todas&modalidad=presencial')).sort()).toEqual(de(ids.r2, ids.r4));
  });

  test('por asesor', async () => {
    expect(radicados(await bandeja(`&tab=todas&asesor=${usuarios.beto.id}`)).sort()).toEqual(de(ids.r3, ids.r4, ids.r5));
  });

  test('por valor y por antigüedad', async () => {
    expect(radicados(await bandeja('&tab=todas&min=5000000')).sort()).toEqual(de(ids.r2, ids.r3, ids.r5));
    expect(radicados(await bandeja('&tab=todas&max=2000000')).sort()).toEqual(de(ids.r1, ids.r4));
    expect(radicados(await bandeja('&tab=todas&dias=10')).sort()).toEqual(de(ids.r1, ids.r5));
  });

  test('los filtros se combinan con la pestaña', async () => {
    expect(radicados(await bandeja('&tab=entregadas&forma=cheque'))).toEqual(de(ids.r2));
  });

  test('rangos incoherentes dan 400', async () => {
    expect((await bandeja('&min=9&max=1')).status).toBe(400);
    expect((await bandeja('&desde=2026-05-02&hasta=2026-05-01')).status).toBe(400);
  });

  test('ordena por valor en ambos sentidos', async () => {
    expect(radicados(await bandeja('&tab=todas&orden=valor&dir=asc'))).toEqual([ids.r1, ids.r4, ids.r7, ids.r2, ids.r5, ids.r3].map((x) => x.radicado));
    expect(radicados(await bandeja('&tab=todas&orden=valor&dir=desc'))[0]).toBe(ids.r3.radicado);
  });

  test('ordenar por días pone primero los más antiguos con "desc"', async () => {
    expect(radicados(await bandeja('&tab=todas&orden=dias&dir=desc')).slice(0, 2)).toEqual([ids.r5.radicado, ids.r1.radicado]);
  });
});

describe('Bandeja de Cartera — resumen y opciones', () => {
  test('cuenta y suma por estado, con los mismos filtros', async () => {
    const { body } = await ag.cartera.get('/api/cartera/resumen?q=ZZBND');
    const por = Object.fromEntries(body.estados.map((e) => [e.estado, e]));
    expect(por.entregada).toMatchObject({ n: 2, valor: 6000000 });
    expect(por.recibida).toMatchObject({ n: 1, valor: 9000000 });
    expect(por.devuelta).toMatchObject({ n: 1, valor: 2000000 });
    expect(por.completada).toMatchObject({ n: 1, valor: 7000000 });
    expect(por.en_tramite).toMatchObject({ n: 1, valor: 4000000 });
    expect(por.pagada).toBeUndefined();
    const filtrado = (await ag.cartera.get(`/api/cartera/resumen?q=ZZBND&empresa=${E.e2}`)).body.estados;
    expect(filtrado.find((e) => e.estado === 'entregada')).toBeUndefined();
    expect(filtrado.find((e) => e.estado === 'recibida').n).toBe(1);
  });

  test('las opciones de los filtros traen empresas, asesores y categorías', async () => {
    const { body } = await ag.cartera.get('/api/cartera/filtros');
    expect(body.empresas.map((e) => e.codigo)).toEqual(expect.arrayContaining([E.e1, E.e2]));
    expect(body.asesores.map((a) => a.id)).toEqual(expect.arrayContaining([usuarios.ana.id, usuarios.beto.id]));
    expect(body.categorias.length).toBeGreaterThan(0);
    expect(body.categorias[0]).toHaveProperty('nombre');
  });
});
