import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';

let app;
const pass = 'testpass123';
const usuarios = {
  ana:   { email: 'lista-ana@kernel.test',   permisos: { creditos: ['READ', 'WRITE'] } },
  beto:  { email: 'lista-beto@kernel.test',  permisos: { creditos: ['READ', 'WRITE'] } },
  jefe:  { email: 'lista-jefe@kernel.test',  permisos: { creditos: ['READ', 'CONFIGURAR'] } },
  nada:  { email: 'lista-nada@kernel.test',  permisos: {} },
};
const E = { e1: 'ZZLST-E1', e2: 'ZZLST-E2' };
const A = { a1: 'ZZLST001', a2: 'ZZLST002', a3: 'ZZLST003', a4: 'ZZLST004' };
let ag = {};
let cats;
const ids = {};

const login = async (quien) => { const a = request.agent(app); await a.post('/api/auth/login').send({ email: usuarios[quien].email, password: pass }); return a; };
const lista = async (quien, query = '') => (await ag[quien].get(`/api/creditos${query}`));
const radicados = (res) => res.body.map((s) => s.radicado);

// Crea una solicitud directa en la base (la lista no depende del resto del flujo)
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
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved) VALUES ('Lista Test', $1, $2, 'asesor', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true RETURNING id`, [u.email, hash]);
    u.id = r.id;
    for (const [m, acc] of Object.entries(u.permisos)) await pool.query(`INSERT INTO permisos (usuario_uuid, modulo_id, accion_id) SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = $2 AND a.nombre = ANY($3) ON CONFLICT DO NOTHING`, [r.id, m, acc]);
  }
  await pool.query(`UPDATE global_usuarios SET nombre = 'Beto Lista' WHERE id = $1`, [usuarios.beto.id]);
  await pool.query(`UPDATE global_usuarios SET nombre = 'Ana Lista' WHERE id = $1`, [usuarios.ana.id]);
  await pool.query(`INSERT INTO empresas (codigo, nombre) VALUES ($1, 'Empresa Lista Uno'), ($2, 'Empresa Lista Dos') ON CONFLICT (codigo) DO NOTHING`, [E.e1, E.e2]);
  for (const [c, e] of [[A.a1, E.e1], [A.a2, E.e1], [A.a3, E.e2], [A.a4, E.e2]]) {
    await pool.query(`INSERT INTO asociados (codigo, nombre, apellido, empresa_dsto, nombre_empresa, is_active) VALUES ($1, 'PRUEBA', $2, $3, 'X', true) ON CONFLICT (codigo) DO NOTHING`, [c, `LISTA ${c}`, e]);
  }
  for (const k of Object.keys(usuarios)) ag[k] = await login(k);
  cats = (await ag.ana.get('/api/creditos/categorias')).body;
  // Ana: 3 solicitudes; Beto: 2
  ids.r1 = await crear('ana', A.a1, E.e1, { valor: 1000000, forma: 'transferencia', modalidad: 'externa', estado: 'en_tramite', dias: 1, categoria: cats[0].id });
  ids.r2 = await crear('ana', A.a2, E.e1, { valor: 5000000, forma: 'cheque', modalidad: 'presencial', estado: 'devuelta', dias: 20, categoria: cats[1].id });
  ids.r3 = await crear('ana', A.a3, E.e2, { valor: 9000000, forma: 'efectivo', modalidad: 'externa', estado: 'pagada', dias: 40, categoria: cats[0].id });
  ids.r4 = await crear('beto', A.a4, E.e2, { valor: 2000000, forma: 'transferencia', modalidad: 'presencial', estado: 'entregada', dias: 5, categoria: cats[1].id });
  ids.r5 = await crear('beto', A.a4, E.e2, { valor: 7000000, forma: 'cheque', modalidad: 'externa', estado: 'recibida', dias: 10, categoria: cats[0].id });
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

describe('Lista de créditos — acceso y alcance', () => {
  test('exige sesión y permiso', async () => {
    for (const ruta of ['/api/creditos', '/api/creditos/resumen', '/api/creditos/filtros']) {
      expect((await request(app).get(ruta)).status).toBe(401);
      expect((await ag.nada.get(ruta)).status).toBe(403);
    }
  });

  test('cada asesor ve solo lo suyo', async () => {
    expect(radicados(await lista('ana')).sort()).toEqual([ids.r1, ids.r2, ids.r3].map((x) => x.radicado).sort());
    expect(radicados(await lista('beto')).sort()).toEqual([ids.r4, ids.r5].map((x) => x.radicado).sort());
  });

  test('quien administra créditos ve todas con todas=1 y sin él solo las suyas', async () => {
    expect((await lista('jefe')).body).toHaveLength(0);
    const todas = await lista('jefe', '?todas=1');
    expect(radicados(todas)).toEqual(expect.arrayContaining([ids.r1, ids.r4].map((x) => x.radicado)));
    expect(todas.body.length).toBeGreaterThanOrEqual(5);
  });

  test('un asesor sin permiso de administrar no ve las de otros ni con todas=1', async () => {
    const r = await lista('ana', '?todas=1');
    expect(radicados(r).sort()).toEqual([ids.r1, ids.r2, ids.r3].map((x) => x.radicado).sort());
  });

  test('filtrar por asesor solo aplica a quien ve todas', async () => {
    const conAsesor = await lista('jefe', `?todas=1&asesor=${usuarios.beto.id}`);
    expect(radicados(conAsesor).sort()).toEqual([ids.r4, ids.r5].map((x) => x.radicado).sort());
    // Ana no puede pedir lo de Beto pasando su id
    const r = await lista('ana', `?todas=1&asesor=${usuarios.beto.id}`);
    expect(radicados(r).sort()).toEqual([ids.r1, ids.r2, ids.r3].map((x) => x.radicado).sort());
  });
});

describe('Lista de créditos — filtros', () => {
  const pedir = async (query) => radicados(await lista('ana', query)).sort();
  const de = (...r) => r.map((x) => x.radicado).sort();

  test('por estado', async () => {
    expect(await pedir('?estado=devuelta')).toEqual(de(ids.r2));
    expect(await pedir('?estado=pagada')).toEqual(de(ids.r3));
  });
  test('por categoría', async () => {
    expect(await pedir(`?categoria=${cats[1].id}`)).toEqual(de(ids.r2));
    expect(await pedir(`?categoria=${cats[0].id}`)).toEqual(de(ids.r1, ids.r3));
  });
  test('por empresa', async () => {
    expect(await pedir(`?empresa=${E.e1}`)).toEqual(de(ids.r1, ids.r2));
    expect(await pedir(`?empresa=${E.e2}`)).toEqual(de(ids.r3));
  });
  test('por forma de desembolso y por modalidad de firma', async () => {
    expect(await pedir('?forma=transferencia')).toEqual(de(ids.r1));
    expect(await pedir('?forma=efectivo')).toEqual(de(ids.r3));
    expect(await pedir('?modalidad=presencial')).toEqual(de(ids.r2));
    expect(await pedir('?modalidad=externa')).toEqual(de(ids.r1, ids.r3));
  });
  test('por rango de valor', async () => {
    expect(await pedir('?min=2000000')).toEqual(de(ids.r2, ids.r3));
    expect(await pedir('?max=5000000')).toEqual(de(ids.r1, ids.r2));
    expect(await pedir('?min=2000000&max=5000000')).toEqual(de(ids.r2));
  });
  test('por antigüedad mínima en días', async () => {
    expect(await pedir('?dias=15')).toEqual(de(ids.r2, ids.r3));
    expect(await pedir('?dias=30')).toEqual(de(ids.r3));
    expect(await pedir('?dias=0')).toHaveLength(3);
  });
  test('por rango de fechas de radicación', async () => {
    const hace = (n) => new Date(Date.now() - n * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    expect(await pedir(`?desde=${hace(25)}`)).toEqual(de(ids.r1, ids.r2));
    expect(await pedir(`?hasta=${hace(25)}`)).toEqual(de(ids.r3));
    expect(await pedir(`?desde=${hace(30)}&hasta=${hace(15)}`)).toEqual(de(ids.r2));
  });
  test('"requiere acción": solo en trámite o devuelta', async () => {
    expect(await pedir('?accion=1')).toEqual(de(ids.r1, ids.r2));
  });
  test('por texto (radicado, cédula o nombre) y combinando filtros', async () => {
    expect(await pedir(`?q=${ids.r2.radicado}`)).toEqual(de(ids.r2));
    expect(await pedir(`?q=${A.a3}`)).toEqual(de(ids.r3));
    expect(await pedir(`?empresa=${E.e1}&forma=cheque&dias=10`)).toEqual(de(ids.r2));
    expect(await pedir(`?empresa=${E.e1}&forma=efectivo`)).toEqual([]);
  });
  test('los valores vacíos se ignoran (así los manda el formulario)', async () => {
    expect(await pedir('?estado=&categoria=&empresa=&forma=&min=&max=&desde=&hasta=&dias=&q=')).toHaveLength(3);
  });
});

describe('Lista de créditos — validación', () => {
  test.each([
    ['estado inexistente', '?estado=inventado'],
    ['categoría que no es uuid', '?categoria=no-es-uuid'],
    ['forma inválida', '?forma=trueque'],
    ['modalidad inválida', '?modalidad=otra'],
    ['fecha mal escrita', '?desde=24/09/2026'],
    ['rango de fechas al revés', '?desde=2026-09-24&hasta=2026-01-01'],
    ['valor no numérico', '?min=abc'],
    ['rango de valor al revés', '?min=10&max=5'],
    ['días negativos', '?dias=-1'],
    ['orden inválido', '?orden=contraseña'],
    ['parámetro desconocido', '?x=1'],
  ])('%s → 400', async (_, query) => {
    expect((await lista('ana', query)).status).toBe(400);
  });
});

describe('Lista de créditos — orden', () => {
  const orden = async (q) => (await lista('ana', q)).body.map((s) => Number(s.valor_solicitado));
  test('por valor ascendente y descendente', async () => {
    expect(await orden('?orden=valor&dir=asc')).toEqual([1000000, 5000000, 9000000]);
    expect(await orden('?orden=valor&dir=desc')).toEqual([9000000, 5000000, 1000000]);
  });
  test('por días: descendente = la más antigua primero', async () => {
    const r = (await lista('ana', '?orden=dias&dir=desc')).body.map((s) => s.dias);
    expect(r).toEqual([...r].sort((a, b) => b - a));
    expect(r[0]).toBeGreaterThanOrEqual(40);
  });
  test('por defecto, la más reciente primero', async () => {
    const r = (await lista('ana')).body.map((s) => s.dias);
    expect(r).toEqual([...r].sort((a, b) => a - b));
  });
});

describe('Lista de créditos — resumen y opciones de filtros', () => {
  test('cuenta y suma por estado con los mismos filtros, sin aplicar el estado', async () => {
    const r = (await ag.ana.get('/api/creditos/resumen')).body;
    const por = Object.fromEntries(r.estados.map((e) => [e.estado, e]));
    expect(por.en_tramite).toEqual({ estado: 'en_tramite', n: 1, valor: 1000000 });
    expect(por.pagada).toEqual({ estado: 'pagada', n: 1, valor: 9000000 });
    expect(por.entregada).toBeUndefined();   // es de Beto
    expect(r.limite).toBe(500);
    const filtrado = (await ag.ana.get(`/api/creditos/resumen?empresa=${E.e1}&estado=pagada`)).body;   // el estado se ignora; la empresa no
    expect(filtrado.estados.map((e) => e.estado).sort()).toEqual(['devuelta', 'en_tramite']);
  });

  test('la franja de resumen respeta el alcance del usuario', async () => {
    const jefe = (await ag.jefe.get('/api/creditos/resumen?todas=1')).body;
    expect(jefe.estados.reduce((t, e) => t + e.n, 0)).toBeGreaterThanOrEqual(5);
    expect((await ag.jefe.get('/api/creditos/resumen')).body.estados).toEqual([]);
  });

  test('las opciones de filtros solo traen empresas y asesores de lo que el usuario ve', async () => {
    const a = (await ag.ana.get('/api/creditos/filtros')).body;
    expect(a.empresas.map((e) => e.codigo).sort()).toEqual([E.e1, E.e2]);
    expect(a.asesores.map((x) => x.id)).toEqual([usuarios.ana.id]);
    const j = (await ag.jefe.get('/api/creditos/filtros?todas=1')).body;
    expect(j.asesores.map((x) => x.id)).toEqual(expect.arrayContaining([usuarios.ana.id, usuarios.beto.id]));
  });
});
