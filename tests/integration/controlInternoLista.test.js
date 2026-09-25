import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';

let app;
const pass = 'testpass123';
const usuarios = {
  ci:     { email: 'cilista-ci@kernel.test',     permisos: { control_interno: ['READ'] } },
  cartera: { email: 'cilista-cartera@kernel.test', permisos: { cartera: ['READ', 'WRITE'] } },
  ana:    { email: 'cilista-ana@kernel.test',    permisos: { creditos: ['READ', 'WRITE'] } },
  beto:   { email: 'cilista-beto@kernel.test',   permisos: { creditos: ['READ', 'WRITE'] } },
  nada:   { email: 'cilista-nada@kernel.test',   permisos: {} },
};
const E = { e1: 'ZZCIL-E1', e2: 'ZZCIL-E2' };
const A = { a1: '9980000001', a2: '9980000002', a3: '9980000003', a4: '9980000004' };
const ag = {};
let cats;
const ids = {};

const login = async (quien) => { const a = request.agent(app); await a.post('/api/auth/login').send({ email: usuarios[quien].email, password: pass }); return a; };
// Todo se limita a los datos de esta prueba con q=998 (código del asociado)
const lista = (query = '') => ag.ci.get(`/api/control_interno/creditos?q=99800${query}`);
const radicados = (res) => res.body.map((s) => s.radicado);
const de = (...r) => r.map((x) => x.radicado).sort();

const crear = async (asesor, asociado, empresa, extra = {}) => {
  const { rows: [s] } = await pool.query(
    `INSERT INTO credito_solicitudes (radicado, asociado_codigo, empresa_codigo, categoria_id, asesor_uuid, canal_origen, valor_solicitado, forma_desembolso, modalidad_firma,
       autorizacion_requerida, autorizacion_momento, estado, created_at, completada_at, completada_por)
     VALUES ('CR-ZZ-' || substr(md5(random()::text), 1, 8), $1, $2, $3, $4, 'presencial', $5, $6, $7, false, 'indiferente', $8, NOW() - ($9 || ' days')::interval, NOW() - ($10 || ' days')::interval, $11)
     RETURNING id, radicado`,
    [asociado, empresa, extra.categoria ?? cats[0].id, usuarios[asesor].id, extra.valor ?? 1000000, extra.forma ?? 'cheque', extra.modalidad ?? 'externa', extra.estado ?? 'completada',
      String((extra.dias ?? 0) + 3), String(extra.dias ?? 0), usuarios.cartera.id]);
  const neto = extra.neto ?? (extra.valor ?? 1000000) - 15000;
  await pool.query(
    `INSERT INTO credito_cierre (solicitud_id, con_aval, aval_porcentaje, aval_valor, firma_electronica_valor, desembolso_neto, banco, tipo_cuenta, numero_cuenta, titular_nombre, titular_documento)
     VALUES ($1, false, NULL, 0, 15000, $2, $3, $4, $5, $6, $7)`,
    [s.id, neto, extra.forma === 'transferencia' ? 'Bancolombia' : null, extra.forma === 'transferencia' ? 'ahorros' : null, extra.forma === 'transferencia' ? '12345678901' : null,
      extra.forma === 'transferencia' ? 'TITULAR' : null, extra.forma === 'transferencia' ? (extra.titular ?? asociado) : null]);
  if (extra.revision) {
    await pool.query(`INSERT INTO credito_revisiones_ci (solicitud_id, decision, destino, motivo, revisor_uuid) VALUES ($1, $2, $3, $4, $5)`,
      [s.id, extra.revision, extra.revision === 'devuelta' ? 'cartera' : null, extra.revision === 'devuelta' ? 'La cuenta no coincide' : null, usuarios.ci.id]);
  }
  return s;
};

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  for (const u of Object.values(usuarios)) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved) VALUES ('CI Lista Test', $1, $2, 'asesor', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true RETURNING id`, [u.email, hash]);
    u.id = r.id;
    for (const [m, acc] of Object.entries(u.permisos)) await pool.query(`INSERT INTO permisos (usuario_uuid, modulo_id, accion_id) SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = $2 AND a.nombre = ANY($3) ON CONFLICT DO NOTHING`, [r.id, m, acc]);
  }
  await pool.query(`UPDATE global_usuarios SET nombre = 'Ana CI' WHERE id = $1`, [usuarios.ana.id]);
  await pool.query(`UPDATE global_usuarios SET nombre = 'Beto CI' WHERE id = $1`, [usuarios.beto.id]);
  await pool.query(`INSERT INTO empresas (codigo, nombre) VALUES ($1, 'Empresa CI Uno'), ($2, 'Empresa CI Dos') ON CONFLICT (codigo) DO NOTHING`, [E.e1, E.e2]);
  for (const [c, e] of [[A.a1, E.e1], [A.a2, E.e1], [A.a3, E.e2], [A.a4, E.e2]]) {
    await pool.query(`INSERT INTO asociados (codigo, nombre, apellido, empresa_dsto, nombre_empresa, is_active) VALUES ($1, 'PRUEBA', $2, $3, 'X', true) ON CONFLICT (codigo) DO NOTHING`, [c, `CI ${c}`, e]);
  }
  for (const k of Object.keys(usuarios)) ag[k] = await login(k);
  cats = (await ag.ana.get('/api/creditos/categorias')).body;
  // Por revisar: r1 (viejo, transferencia a un tercero), r2 (reciente, cheque). En Tesorería: r3. Pagado: r4. Devuelto: r5 (vuelve a Cartera). Devuelto y ya reenviado: r6 (completada de nuevo)
  ids.r1 = await crear('ana',  A.a1, E.e1, { valor: 5000000, forma: 'transferencia', titular: '55555555', dias: 10, categoria: cats[0].id });
  ids.r2 = await crear('ana',  A.a2, E.e1, { valor: 2000000, forma: 'cheque', modalidad: 'presencial', dias: 1, categoria: cats[1].id });
  ids.r3 = await crear('beto', A.a3, E.e2, { valor: 9000000, forma: 'transferencia', estado: 'en_tesoreria', dias: 4, revision: 'aprobada', categoria: cats[0].id });
  ids.r4 = await crear('beto', A.a4, E.e2, { valor: 7000000, forma: 'efectivo', estado: 'pagada', dias: 8, revision: 'aprobada', categoria: cats[0].id });
  ids.r5 = await crear('beto', A.a4, E.e2, { valor: 3000000, forma: 'cheque', estado: 'recibida', dias: 6, revision: 'devuelta', categoria: cats[1].id });
  ids.r6 = await crear('ana',  A.a1, E.e1, { valor: 4000000, forma: 'cheque', estado: 'completada', dias: 2, revision: 'devuelta', categoria: cats[0].id });
});

afterAll(async () => {
  const uids = Object.values(usuarios).map((u) => u.id);
  await pool.query('ALTER TABLE credito_eventos DISABLE TRIGGER USER');
  try {
    const { rows: sol } = await pool.query('SELECT id FROM credito_solicitudes WHERE asesor_uuid = ANY($1)', [uids]);
    const sids = sol.map((s) => s.id);
    await pool.query('DELETE FROM credito_revisiones_ci WHERE solicitud_id = ANY($1)', [sids]);
    await pool.query('DELETE FROM credito_cierre WHERE solicitud_id = ANY($1)', [sids]);
    await pool.query('DELETE FROM credito_solicitudes WHERE id = ANY($1)', [sids]);
  } finally { await pool.query('ALTER TABLE credito_eventos ENABLE TRIGGER USER'); }
  await pool.query('DELETE FROM asociados WHERE codigo = ANY($1)', [Object.values(A)]);
  await pool.query('DELETE FROM empresas WHERE codigo = ANY($1)', [Object.values(E)]);
  await pool.query('DELETE FROM permisos WHERE usuario_uuid = ANY($1)', [uids]);
  await pool.query('DELETE FROM global_usuarios WHERE id = ANY($1)', [uids]);
  await pool.end();
});

describe('Bandeja de Control Interno — acceso', () => {
  test('exige sesión y permiso de Control Interno (Cartera y asesores no entran)', async () => {
    for (const ruta of ['/api/control_interno/creditos', '/api/control_interno/creditos/resumen', '/api/control_interno/creditos/filtros']) {
      expect((await request(app).get(ruta)).status).toBe(401);
      for (const quien of ['nada', 'cartera', 'ana']) expect((await ag[quien].get(ruta)).status).toBe(403);
    }
  });

  test('ve los créditos de todos los asesores y rechaza parámetros que no conoce', async () => {
    const r = await lista('&tab=todas');
    expect(new Set(r.body.map((s) => s.asesor_nombre))).toEqual(new Set(['Ana CI', 'Beto CI']));
    expect((await lista('&todas=1')).status).toBe(400);
    expect((await lista('&estado=pagada')).status).toBe(400);
    expect((await lista('&nada=1')).status).toBe(400);
  });
});

describe('Bandeja de Control Interno — pestañas', () => {
  test('cada pestaña trae solo lo suyo', async () => {
    expect(radicados(await lista('&tab=por_revisar')).sort()).toEqual(de(ids.r1, ids.r2, ids.r6));
    expect(radicados(await lista('&tab=en_tesoreria'))).toEqual(de(ids.r3));
    expect(radicados(await lista('&tab=pagados'))).toEqual(de(ids.r4));
    expect(radicados(await lista('&tab=devueltos'))).toEqual(de(ids.r5));
  });

  test('un crédito devuelto que Cartera vuelve a completar sale de "devueltos" y regresa a "por revisar"', async () => {
    expect(radicados(await lista('&tab=devueltos'))).not.toContain(ids.r6.radicado);
    expect(radicados(await lista('&tab=por_revisar'))).toContain(ids.r6.radicado);
  });

  test('sin pestaña abre "por revisar"; una inexistente da 400; "todas" trae las cuatro', async () => {
    expect(radicados(await lista()).sort()).toEqual(de(ids.r1, ids.r2, ids.r6));
    expect((await lista('&tab=inventada')).status).toBe(400);
    expect(radicados(await lista('&tab=todas')).sort()).toEqual(de(ids.r1, ids.r2, ids.r3, ids.r4, ids.r5, ids.r6));
  });

  test('por revisar: lo que más lleva esperando va primero', async () => {
    expect(radicados(await lista('&tab=por_revisar'))).toEqual([ids.r1, ids.r6, ids.r2].map((x) => x.radicado));
  });

  test('las demás pestañas muestran lo más reciente primero', async () => {
    expect(radicados(await lista('&tab=todas')).slice(0, 2)).toEqual([ids.r2.radicado, ids.r6.radicado]);
  });
});

describe('Bandeja de Control Interno — lo que trae cada fila', () => {
  test('valores del cierre, quién completó y días en Control Interno', async () => {
    const f = (await lista('&tab=por_revisar')).body.find((s) => s.id === ids.r1.id);
    expect(f).toMatchObject({ estado: 'completada', forma_desembolso: 'transferencia', desembolso_neto: '4985000.00', firma_electronica_valor: '15000.00', con_aval: false, dias: 10 });
    expect(f.completada_por_nombre).toBe('CI Lista Test');
  });

  test('avisa cuando la cuenta es de un tercero (y no cuando es del asociado ni con cheque)', async () => {
    const por = Object.fromEntries((await lista('&tab=todas')).body.map((s) => [s.id, s.titular_tercero]));
    expect(por[ids.r1.id]).toBe(true);
    expect(por[ids.r3.id]).toBe(false);   // titular = el asociado
    expect(por[ids.r2.id]).toBe(false);   // cheque: no hay cuenta
  });

  test('un devuelto trae la última revisión: decisión, destino, motivo y quién', async () => {
    const f = (await lista('&tab=devueltos')).body[0];
    expect(f).toMatchObject({ revision_decision: 'devuelta', revision_destino: 'cartera', revision_motivo: 'La cuenta no coincide' });
    expect(f.revision_por).toBe('CI Lista Test');
  });

  test('un aprobado trae la revisión que lo aprobó', async () => {
    const f = (await lista('&tab=en_tesoreria')).body[0];
    expect(f).toMatchObject({ revision_decision: 'aprobada', revision_destino: null });
  });
});

describe('Bandeja de Control Interno — filtros y orden', () => {
  test('por categoría, empresa, forma, firma y asesor', async () => {
    expect(radicados(await lista(`&tab=todas&categoria=${cats[1].id}`)).sort()).toEqual(de(ids.r2, ids.r5));
    expect(radicados(await lista(`&tab=todas&empresa=${E.e2}`)).sort()).toEqual(de(ids.r3, ids.r4, ids.r5));
    expect(radicados(await lista('&tab=todas&forma=transferencia')).sort()).toEqual(de(ids.r1, ids.r3));
    expect(radicados(await lista('&tab=todas&modalidad=presencial'))).toEqual(de(ids.r2));
    expect(radicados(await lista(`&tab=todas&asesor=${usuarios.beto.id}`)).sort()).toEqual(de(ids.r3, ids.r4, ids.r5));
  });

  test('por valor solicitado', async () => {
    expect(radicados(await lista('&tab=todas&min=7000000')).sort()).toEqual(de(ids.r3, ids.r4));
    expect(radicados(await lista('&tab=todas&max=3000000')).sort()).toEqual(de(ids.r2, ids.r5));
  });

  test('"días" son los que lleva en Control Interno (desde que Cartera lo completó), no desde la radicación', async () => {
    expect(radicados(await lista('&tab=todas&dias=8')).sort()).toEqual(de(ids.r1, ids.r4));
    expect(radicados(await lista('&tab=todas&dias=5')).sort()).toEqual(de(ids.r1, ids.r4, ids.r5));
  });

  test('los filtros se combinan con la pestaña y los rangos incoherentes dan 400', async () => {
    expect(radicados(await lista('&tab=por_revisar&forma=cheque')).sort()).toEqual(de(ids.r2, ids.r6));
    expect((await lista('&min=9&max=1')).status).toBe(400);
  });

  test('ordena por desembolso, valor y días en ambos sentidos', async () => {
    expect(radicados(await lista('&tab=todas&orden=desembolso&dir=asc'))[0]).toBe(ids.r2.radicado);
    expect(radicados(await lista('&tab=todas&orden=desembolso&dir=desc'))[0]).toBe(ids.r3.radicado);
    expect(radicados(await lista('&tab=todas&orden=valor&dir=desc')).slice(0, 2)).toEqual([ids.r3.radicado, ids.r4.radicado]);
    expect(radicados(await lista('&tab=todas&orden=dias&dir=desc'))[0]).toBe(ids.r1.radicado);
    expect((await lista('&orden=raro')).status).toBe(400);
  });
});

describe('Bandeja de Control Interno — resumen y opciones', () => {
  test('cuenta y suma el desembolso neto por pestaña, con los mismos filtros', async () => {
    const { body } = await ag.ci.get('/api/control_interno/creditos/resumen?q=99800');
    const por = Object.fromEntries(body.tabs.map((t) => [t.tab, t]));
    expect(por.por_revisar).toMatchObject({ n: 3, valor: 4985000 + 1985000 + 3985000 });
    expect(por.en_tesoreria).toMatchObject({ n: 1, valor: 8985000 });
    expect(por.pagados).toMatchObject({ n: 1, valor: 6985000 });
    expect(por.devueltos).toMatchObject({ n: 1, valor: 2985000 });
    const filtrado = (await ag.ci.get(`/api/control_interno/creditos/resumen?q=99800&empresa=${E.e2}`)).body.tabs;
    expect(filtrado.find((t) => t.tab === 'por_revisar')).toBeUndefined();
    expect(filtrado.find((t) => t.tab === 'pagados').n).toBe(1);
  });

  test('las opciones de los filtros traen empresas, asesores y categorías', async () => {
    const { body } = await ag.ci.get('/api/control_interno/creditos/filtros');
    expect(body.empresas.map((e) => e.codigo)).toEqual(expect.arrayContaining([E.e1, E.e2]));
    expect(body.asesores.map((a) => a.id)).toEqual(expect.arrayContaining([usuarios.ana.id, usuarios.beto.id]));
    expect(body.categorias[0]).toHaveProperty('nombre');
  });
});
