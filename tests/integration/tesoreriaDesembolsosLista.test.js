import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';

let app;
const pass = 'testpass123';
const usuarios = {
  tes:      { email: 'tesl-tes@kernel.test',      permisos: { tesoreria: ['READ', 'PAGAR_CREDITOS'] } },
  lector:   { email: 'tesl-lector@kernel.test',   permisos: { tesoreria: ['READ'] } },
  // Aprobó en Control Interno y además puede pagar: no debe poder pagar lo que él aprobó
  ciTes:    { email: 'tesl-cites@kernel.test',    permisos: { control_interno: ['READ', 'REVISAR_CREDITOS'], tesoreria: ['READ', 'PAGAR_CREDITOS'] } },
  ciB:      { email: 'tesl-cib@kernel.test',      permisos: { control_interno: ['READ', 'REVISAR_CREDITOS'] } },
  asesor:   { email: 'tesl-asesor@kernel.test',   permisos: { creditos: ['READ', 'WRITE'] } },
  nada:     { email: 'tesl-nada@kernel.test',     permisos: {} },
};
const E = { e1: 'ZZTSL-E1', e2: 'ZZTSL-E2' };
const A = { a1: '9960000001', a2: '9960000002', a3: '9960000003', a4: '9960000004' };
const ag = {};
const cuentas = {};
const ord = {};

const login = async (quien) => { const a = request.agent(app); await a.post('/api/auth/login').send({ email: usuarios[quien].email, password: pass }); return a; };
// Todo se limita a los datos de esta prueba con q=996 (código del asociado)
const lista = (query = '', quien = 'tes') => ag[quien].get(`/api/tesoreria/desembolsos?q=99600${query}`);
const radicados = (res) => res.body.map((o) => o.radicado);
const de = (...r) => r.map((x) => x.radicado).sort();

const crear = async ({ asociado, empresa, estado, forma, monto, aprobadaPor, diasAprob, tercero = false, cuentaOrigen = null, referencia = null, diasPago = null, motivo = null }) => {
  const { rows: [s] } = await pool.query(
    `INSERT INTO credito_solicitudes (radicado, asociado_codigo, empresa_codigo, categoria_id, asesor_uuid, canal_origen, valor_solicitado, forma_desembolso, modalidad_firma, autorizacion_requerida, autorizacion_momento, estado)
     VALUES ('CR-ZZ-' || substr(md5(random()::text), 1, 8), $1, $2, (SELECT id FROM credito_categorias WHERE is_active LIMIT 1), $3, 'presencial', $4, $5, 'externa', false, 'indiferente', $6) RETURNING id, radicado`,
    [asociado, empresa, usuarios.asesor.id, monto, forma, estado === 'pagada' ? 'pagada' : estado === 'pendiente' ? 'en_tesoreria' : 'completada']);
  const tr = forma === 'transferencia';
  // Una orden pagada siempre tiene su movimiento contable (la tabla lo exige)
  const movimiento = estado === 'pagada'
    ? (await pool.query(`INSERT INTO tesoreria_movimientos (tipo, monto, fecha, descripcion, referencia, cuenta_id, registrado_por) VALUES ('egreso', $1, CURRENT_DATE, 'ZZ prueba lista', $2, $3, $4) RETURNING id`, [monto, referencia, cuentaOrigen, usuarios.tes.id])).rows[0].id
    : null;
  const { rows: [o] } = await pool.query(
    `INSERT INTO credito_ordenes_pago (solicitud_id, estado, radicado, asociado_codigo, asociado_nombre, forma_pago, monto, banco, tipo_cuenta, numero_cuenta, titular_nombre, titular_documento, titular_es_asociado,
        huella, aprobada_por, aprobada_at, cuenta_origen_id, referencia_pago, fecha_pago, pagada_por, pagada_at, anulada_motivo, movimiento_id)
     VALUES ($1, $2::varchar, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, repeat('a', 64), $14, NOW() - ($15 || ' days')::interval, $16, $17,
        CASE WHEN $2::text = 'pagada' THEN (NOW() - ($18 || ' days')::interval)::date END, CASE WHEN $2::text = 'pagada' THEN $19::uuid END, CASE WHEN $2::text = 'pagada' THEN NOW() - ($18 || ' days')::interval END, $20, $21)
     RETURNING id`,
    [s.id, estado, s.radicado, asociado, `PRUEBA ${asociado}`, forma, monto, tr ? 'Bancolombia' : null, tr ? 'ahorros' : null, tr ? '12345678901' : null, tr ? (tercero ? 'LUIS RUIZ' : `PRUEBA ${asociado}`) : null,
      tr ? (tercero ? '52000222' : asociado) : null, !tercero, aprobadaPor, String(diasAprob), cuentaOrigen, referencia, String(diasPago ?? 0), usuarios.tes.id, motivo, movimiento]);
  return { ...s, orden_id: o.id };
};

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  for (const u of Object.values(usuarios)) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved) VALUES ('Tes Lista Test', $1, $2, 'asesor', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true RETURNING id`, [u.email, hash]);
    u.id = r.id;
    for (const [m, acc] of Object.entries(u.permisos)) await pool.query(`INSERT INTO permisos (usuario_uuid, modulo_id, accion_id) SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = $2 AND a.nombre = ANY($3) ON CONFLICT DO NOTHING`, [r.id, m, acc]);
  }
  await pool.query(`UPDATE global_usuarios SET nombre = 'Aprobador Uno' WHERE id = $1`, [usuarios.ciTes.id]);
  await pool.query(`UPDATE global_usuarios SET nombre = 'Aprobador Dos' WHERE id = $1`, [usuarios.ciB.id]);
  await pool.query(`INSERT INTO empresas (codigo, nombre) VALUES ($1, 'Empresa Tes Uno'), ($2, 'Empresa Tes Dos') ON CONFLICT (codigo) DO NOTHING`, [E.e1, E.e2]);
  for (const [c, e] of [[A.a1, E.e1], [A.a2, E.e1], [A.a3, E.e2], [A.a4, E.e2]]) {
    await pool.query(`INSERT INTO asociados (codigo, nombre, apellido, empresa_dsto, nombre_empresa, is_active) VALUES ($1, 'PRUEBA', $2, $3, 'X', true) ON CONFLICT (codigo) DO NOTHING`, [c, `TES ${c}`, e]);
  }
  cuentas.banco = (await pool.query(`INSERT INTO tesoreria_cuentas (nombre, tipo, entidad, numero, saldo_inicial, is_active) VALUES ('ZZ TSL Banco', 'banco', 'Banco', '000', 0, true) RETURNING id`)).rows[0];
  cuentas.caja = (await pool.query(`INSERT INTO tesoreria_cuentas (nombre, tipo, entidad, numero, saldo_inicial, is_active) VALUES ('ZZ TSL Caja', 'caja', 'Caja', '000', 0, true) RETURNING id`)).rows[0];
  for (const k of Object.keys(usuarios)) ag[k] = await login(k);
  // o1 y o2 por pagar; o3 y o4 pagadas; o5 devuelta
  ord.o1 = await crear({ asociado: A.a1, empresa: E.e1, estado: 'pendiente', forma: 'transferencia', monto: 5000000, aprobadaPor: usuarios.ciTes.id, diasAprob: 10, tercero: true });
  ord.o2 = await crear({ asociado: A.a2, empresa: E.e1, estado: 'pendiente', forma: 'cheque', monto: 2000000, aprobadaPor: usuarios.ciB.id, diasAprob: 1 });
  ord.o3 = await crear({ asociado: A.a3, empresa: E.e2, estado: 'pagada', forma: 'efectivo', monto: 7000000, aprobadaPor: usuarios.ciB.id, diasAprob: 8, cuentaOrigen: cuentas.caja.id, referencia: 'REC-777', diasPago: 6 });
  ord.o4 = await crear({ asociado: A.a4, empresa: E.e2, estado: 'pagada', forma: 'transferencia', monto: 9000000, aprobadaPor: usuarios.ciTes.id, diasAprob: 5, cuentaOrigen: cuentas.banco.id, referencia: 'TRF-123', diasPago: 4 });
  ord.o5 = await crear({ asociado: A.a4, empresa: E.e2, estado: 'anulada', forma: 'cheque', monto: 3000000, aprobadaPor: usuarios.ciB.id, diasAprob: 3, motivo: 'El banco rechazó la cuenta' });
});

afterAll(async () => {
  const uids = Object.values(usuarios).map((u) => u.id);
  await pool.query('ALTER TABLE credito_eventos DISABLE TRIGGER USER');
  await pool.query('ALTER TABLE credito_ordenes_pago DISABLE TRIGGER trg_credito_orden_foto_inmutable');
  try {
    const { rows: sol } = await pool.query('SELECT id FROM credito_solicitudes WHERE asesor_uuid = ANY($1)', [uids]);
    const sids = sol.map((s) => s.id);
    await pool.query('DELETE FROM credito_ordenes_pago WHERE solicitud_id = ANY($1)', [sids]);
    await pool.query('DELETE FROM tesoreria_movimientos WHERE registrado_por = ANY($1)', [uids]);
    await pool.query('DELETE FROM credito_solicitudes WHERE id = ANY($1)', [sids]);
  } finally {
    await pool.query('ALTER TABLE credito_eventos ENABLE TRIGGER USER');
    await pool.query('ALTER TABLE credito_ordenes_pago ENABLE TRIGGER trg_credito_orden_foto_inmutable');
  }
  await pool.query('DELETE FROM tesoreria_cuentas WHERE id = ANY($1)', [Object.values(cuentas).map((c) => c.id)]);
  await pool.query('DELETE FROM asociados WHERE codigo = ANY($1)', [Object.values(A)]);
  await pool.query('DELETE FROM empresas WHERE codigo = ANY($1)', [Object.values(E)]);
  await pool.query('DELETE FROM permisos WHERE usuario_uuid = ANY($1)', [uids]);
  await pool.query('DELETE FROM global_usuarios WHERE id = ANY($1)', [uids]);
  await pool.end();
});

describe('Desembolsos de Tesorería — acceso', () => {
  test('exige sesión y permiso de Tesorería', async () => {
    for (const ruta of ['/api/tesoreria/desembolsos', '/api/tesoreria/desembolsos/resumen', '/api/tesoreria/desembolsos/filtros']) {
      expect((await request(app).get(ruta)).status).toBe(401);
      expect((await ag.nada.get(ruta)).status).toBe(403);
      expect((await ag.asesor.get(ruta)).status).toBe(403);
    }
  });

  test('quien solo puede leer ve la lista; rechaza parámetros que no conoce', async () => {
    expect((await lista('', 'lector')).status).toBe(200);
    for (const malo of ['&estado=raro', '&nada=1', '&orden=raro', '&forma=cripto', '&aprobador=no-es-uuid']) expect((await lista(malo)).status).toBe(400);
  });
});

describe('Desembolsos de Tesorería — pestañas', () => {
  test('cada estado trae solo lo suyo; sin estado abre "pendiente"', async () => {
    expect(radicados(await lista()).sort()).toEqual(de(ord.o1, ord.o2));
    expect(radicados(await lista('&estado=pendiente')).sort()).toEqual(de(ord.o1, ord.o2));
    expect(radicados(await lista('&estado=pagada')).sort()).toEqual(de(ord.o3, ord.o4));
    expect(radicados(await lista('&estado=anulada'))).toEqual(de(ord.o5));
  });

  test('"todas" trae las tres (para el tablero)', async () => {
    expect(radicados(await lista('&estado=todas')).sort()).toEqual(de(ord.o1, ord.o2, ord.o3, ord.o4, ord.o5));
  });

  test('por pagar: lo que más lleva esperando va primero; pagados: lo más reciente primero', async () => {
    expect(radicados(await lista('&estado=pendiente'))).toEqual([ord.o1.radicado, ord.o2.radicado]);   // 10 días y 1 día
    expect(radicados(await lista('&estado=pagada'))).toEqual([ord.o4.radicado, ord.o3.radicado]);      // pagada hace 4 y hace 6 días
  });

  test('en "todas" van primero los pendientes por antigüedad y luego el resto por lo más reciente', async () => {
    expect(radicados(await lista('&estado=todas')).slice(0, 2)).toEqual([ord.o1.radicado, ord.o2.radicado]);
  });
});

describe('Desembolsos de Tesorería — lo que trae cada fila', () => {
  test('empresa, días de espera y quién aprobó', async () => {
    const f = (await lista('&estado=pendiente')).body.find((o) => o.id === ord.o1.orden_id);
    expect(f).toMatchObject({ empresa_nombre: 'Empresa Tes Uno', dias_espera: 10, aprobada_por_nombre: 'Aprobador Uno', titular_es_asociado: false, forma_pago: 'transferencia' });
    expect(f).not.toHaveProperty('aprobada_por');   // el id interno no sale
  });

  test('en un pago hecho, los días de espera son lo que tardó en pagarse (no crecen con el tiempo)', async () => {
    const f = (await lista('&estado=pagada')).body.find((o) => o.id === ord.o3.orden_id);
    expect(f).toMatchObject({ dias_espera: 2, referencia_pago: 'REC-777', cuenta_origen_nombre: 'ZZ TSL Caja' });   // aprobada hace 8 días, pagada hace 6
  });

  test('una orden devuelta no tiene días de espera y trae el motivo', async () => {
    const f = (await lista('&estado=anulada')).body[0];
    expect(f.dias_espera).toBeNull();
    expect(f.anulada_motivo).toBe('El banco rechazó la cuenta');
  });
});

describe('Desembolsos de Tesorería — quién puede pagar', () => {
  const por = async (quien, estado = 'pendiente') => Object.fromEntries((await lista(`&estado=${estado}`, quien)).body.map((o) => [o.id, o]));

  test('con el permiso, puede pagar lo que aprobó otra persona', async () => {
    const o = await por('tes');
    expect(o[ord.o1.orden_id]).toMatchObject({ puede_pagar: true, motivo_bloqueo: null });
    expect(o[ord.o2.orden_id].puede_pagar).toBe(true);
  });

  test('quien aprobó en Control Interno no puede pagar lo suyo, y se le dice por qué', async () => {
    const o = await por('ciTes');
    expect(o[ord.o1.orden_id]).toMatchObject({ puede_pagar: false, motivo_bloqueo: expect.stringMatching(/lo debe pagar otra persona/) });
    expect(o[ord.o2.orden_id].puede_pagar).toBe(true);   // esta la aprobó otro
  });

  test('sin el permiso de pagar, ninguna se puede pagar y se explica', async () => {
    const o = await por('lector');
    for (const x of Object.values(o)) expect(x).toMatchObject({ puede_pagar: false, motivo_bloqueo: expect.stringMatching(/permiso para pagar/) });
  });

  test('devolver solo pide el permiso: quien aprobó puede devolver pero no pagar; sin permiso, ninguna de las dos', async () => {
    expect((await por('ciTes'))[ord.o1.orden_id]).toMatchObject({ puede_pagar: false, puede_devolver: true });
    expect((await por('tes'))[ord.o1.orden_id]).toMatchObject({ puede_pagar: true, puede_devolver: true });
    expect((await por('lector'))[ord.o1.orden_id]).toMatchObject({ puede_pagar: false, puede_devolver: false });
  });

  test('lo ya pagado o devuelto no se paga y no lleva motivo de bloqueo', async () => {
    for (const x of Object.values(await por('tes', 'pagada'))) expect(x).toMatchObject({ puede_pagar: false, motivo_bloqueo: null });
  });
});

describe('Desembolsos de Tesorería — filtros y orden', () => {
  test('por forma de pago, empresa y quién aprobó', async () => {
    expect(radicados(await lista('&estado=todas&forma=transferencia')).sort()).toEqual(de(ord.o1, ord.o4));
    expect(radicados(await lista('&estado=todas&forma=efectivo'))).toEqual(de(ord.o3));
    expect(radicados(await lista(`&estado=todas&empresa=${E.e1}`)).sort()).toEqual(de(ord.o1, ord.o2));
    expect(radicados(await lista(`&estado=todas&aprobador=${usuarios.ciTes.id}`)).sort()).toEqual(de(ord.o1, ord.o4));
  });

  test('por monto', async () => {
    expect(radicados(await lista('&estado=todas&min=7000000')).sort()).toEqual(de(ord.o3, ord.o4));
    expect(radicados(await lista('&estado=todas&max=3000000')).sort()).toEqual(de(ord.o2, ord.o5));
  });

  test('por cuenta de origen (solo lo ya pagado tiene)', async () => {
    expect(radicados(await lista(`&estado=todas&cuenta=${cuentas.caja.id}`))).toEqual(de(ord.o3));
    expect(radicados(await lista(`&estado=todas&cuenta=${cuentas.banco.id}`))).toEqual(de(ord.o4));
  });

  test('solo cuentas de un tercero', async () => {
    expect(radicados(await lista('&estado=todas&tercero=1'))).toEqual(de(ord.o1));
  });

  test('por días de espera (lo que ya se pagó cuenta lo que tardó; lo devuelto no cuenta)', async () => {
    expect(radicados(await lista('&estado=pendiente&dias=5'))).toEqual(de(ord.o1));
    // o1 espera 10 días; o3 esperó 2 (aprobada hace 8, pagada hace 6); o4 esperó 1 (hace 5 y hace 4); o5 devuelta no cuenta
    expect(radicados(await lista('&estado=todas&dias=2')).sort()).toEqual(de(ord.o1, ord.o3));
  });

  test('por referencia y por nombre del titular', async () => {
    const con = (q) => ag.tes.get(`/api/tesoreria/desembolsos?estado=todas&q=${encodeURIComponent(q)}`);
    expect(radicados(await con('TRF-123'))).toEqual(de(ord.o4));
    expect(radicados(await con('LUIS RUIZ'))).toEqual(de(ord.o1));
  });

  test('por fecha de aprobación, y un rango incoherente da 400', async () => {
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    expect((await lista(`&estado=todas&desde=${hoy}`)).body).toHaveLength(0);   // todas se aprobaron antes de hoy
    expect((await lista('&estado=todas&desde=2030-02-01&hasta=2030-01-01')).status).toBe(400);
    expect((await lista('&min=9&max=1')).status).toBe(400);
  });

  test('ordena por monto, asociado y espera en ambos sentidos', async () => {
    expect(radicados(await lista('&estado=todas&orden=monto&dir=desc'))[0]).toBe(ord.o4.radicado);
    expect(radicados(await lista('&estado=todas&orden=monto&dir=asc'))[0]).toBe(ord.o2.radicado);
    expect(radicados(await lista('&estado=todas&orden=dias&dir=desc'))[0]).toBe(ord.o1.radicado);
  });
});

describe('Desembolsos de Tesorería — resumen y opciones', () => {
  test('cuenta y suma el monto por estado, con los mismos filtros', async () => {
    const { body } = await ag.tes.get('/api/tesoreria/desembolsos/resumen?q=99600');
    const por = Object.fromEntries(body.estados.map((e) => [e.estado, e]));
    expect(por.pendiente).toMatchObject({ n: 2, valor: 7000000 });
    expect(por.pagada).toMatchObject({ n: 2, valor: 16000000 });
    expect(por.anulada).toMatchObject({ n: 1, valor: 3000000 });
    const filtrado = (await ag.tes.get(`/api/tesoreria/desembolsos/resumen?q=99600&forma=transferencia`)).body.estados;
    expect(filtrado.find((e) => e.estado === 'anulada')).toBeUndefined();
    expect(filtrado.find((e) => e.estado === 'pagada').n).toBe(1);
  });

  test('las opciones traen empresas, quienes aprobaron y cuentas de origen', async () => {
    const { body } = await ag.tes.get('/api/tesoreria/desembolsos/filtros');
    expect(body.empresas.map((e) => e.codigo)).toEqual(expect.arrayContaining([E.e1, E.e2]));
    expect(body.aprobadores.map((a) => a.id)).toEqual(expect.arrayContaining([usuarios.ciTes.id, usuarios.ciB.id]));
    expect(body.cuentas.map((c) => c.id)).toEqual(expect.arrayContaining([cuentas.banco.id, cuentas.caja.id]));
  });
});
