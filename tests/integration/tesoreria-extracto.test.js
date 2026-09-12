import request  from 'supertest';
import path     from 'path';
import { createApp } from '../../src/createApp.js';
import pool     from '../../src/db/database.js';
import bcrypt   from 'bcrypt';
import { parseBancolombiaPwxl } from '../../src/modules/tesoreria/services/bancolombiaPwxlParser.js';
import { readFileSync }          from 'fs';

const FIXTURE = path.resolve('tests/fixtures/extracto_bancolombia.xls');
const EMAIL   = 'extracto-test@kernel.test';
const PASS    = 'testpass123';

let app;
let userUuid;
let cuentaId;

const agente = () => request.agent(app);

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(PASS, 4);

  const { rows: [u] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Extracto Test', $1, $2, 'tesorera', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL, hash]
  );
  userUuid = u.id;

  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a
     WHERE m.nombre = 'tesoreria'
     ON CONFLICT DO NOTHING`,
    [userUuid]
  );

  const { rows: [c] } = await pool.query(
    `INSERT INTO tesoreria_cuentas (nombre, tipo, entidad, numero, saldo_inicial)
     VALUES ('Bancolombia Test', 'banco', 'Bancolombia', '21002671568', 5000000)
     RETURNING id`
  );
  cuentaId = c.id;
});

afterAll(async () => {
  await pool.query('DELETE FROM tesoreria_extractos  WHERE cuenta_id = $1', [cuentaId]);
  await pool.query('DELETE FROM tesoreria_movimientos WHERE cuenta_id = $1', [cuentaId]);
  await pool.query('DELETE FROM tesoreria_cuentas    WHERE id = $1',        [cuentaId]);
  await pool.query('DELETE FROM permisos             WHERE usuario_uuid = $1', [userUuid]);
  await pool.query('DELETE FROM global_usuarios      WHERE id = $1',           [userUuid]);
  await pool.end();
});

// ── Parser PWXL (unit) ────────────────────────────────────────────────────────

describe('Parser PWXL — unit', () => {
  let resultado;

  beforeAll(() => {
    const raw = readFileSync(FIXTURE, 'latin1');
    resultado  = parseBancolombiaPwxl(raw);
  });

  test('Extrae transacciones reales (sin SALDO INICIAL/FINAL)', () => {
    expect(resultado.transacciones).toHaveLength(4);
  });

  test('Extrae saldos por día (inicial y final)', () => {
    expect(resultado.saldos).toHaveLength(2);
    expect(resultado.saldos[0]).toMatchObject({ tipo: 'inicial', monto: 5000000 });
    expect(resultado.saldos[1]).toMatchObject({ tipo: 'final',   monto: 5051000 });
  });

  test('Convierte fecha DD/MM/YYYY → YYYY-MM-DD', () => {
    expect(resultado.transacciones[0].fecha).toBe('2026-09-01');
  });

  test('Valor positivo → tipo_movimiento ingreso', () => {
    const ing = resultado.transacciones.find(t => t.referencia_bancaria === 'REF001UNICO');
    expect(ing.tipo_movimiento).toBe('ingreso');
    expect(ing.monto).toBe(126000);
  });

  test('Valor negativo → tipo_movimiento egreso (monto positivo)', () => {
    const eg = resultado.transacciones.find(t => t.referencia_bancaria === 'REFEGRESO01');
    expect(eg.tipo_movimiento).toBe('egreso');
    expect(eg.monto).toBe(200000);
  });

  test('Popula referencia_bancaria, tipo_bancario, oficina_bancaria, detalles_banco', () => {
    const tx = resultado.transacciones.find(t => t.referencia_bancaria === 'REF001UNICO');
    expect(tx.tipo_bancario).toBe('N109');
    expect(tx.oficina_bancaria).toBe('(BCS) ACH');
    expect(tx.detalles_banco).toMatch(/Empresa A/);
  });

  test('Dos transacciones con misma referencia se mantienen separadas', () => {
    const compartidas = resultado.transacciones.filter(t => t.referencia_bancaria === 'REFCOMPARTIDA');
    expect(compartidas).toHaveLength(2);
    expect(compartidas[0].monto).toBe(75000);
    expect(compartidas[1].monto).toBe(50000);
  });
});

// ── Auth guard ────────────────────────────────────────────────────────────────

describe('Auth', () => {
  // No adjuntamos archivo: el middleware verifyToken rechaza antes de que multer
  // lea el body. Enviar un archivo sin cookie activa produce ECONNRESET.
  test('POST /extracto/preview sin token → 401', async () => {
    const res = await request(app)
      .post(`/api/tesoreria/extracto/preview?cuenta_id=${cuentaId}`)
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(401);
  });

  test('POST /extracto/confirmar sin token → 401', async () => {
    const res = await request(app)
      .post('/api/tesoreria/extracto/confirmar')
      .set('Content-Type', 'application/json');
    expect(res.status).toBe(401);
  });
});

// ── Validaciones de entrada ───────────────────────────────────────────────────

describe('Validación de entrada', () => {
  let ag;
  beforeAll(async () => { ag = agente(); await ag.post('/api/auth/login').send({ email: EMAIL, password: PASS }); });

  test('Preview sin archivo → 400', async () => {
    const res = await ag.post(`/api/tesoreria/extracto/preview?cuenta_id=${cuentaId}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/archivo/i);
  });

  test('Preview sin cuenta_id → 400', async () => {
    const res = await ag.post('/api/tesoreria/extracto/preview').attach('archivo', FIXTURE);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cuenta_id/i);
  });

  test('Preview con cuenta_id inexistente → 404', async () => {
    const res = await ag
      .post('/api/tesoreria/extracto/preview?cuenta_id=00000000-0000-0000-0000-000000000000')
      .attach('archivo', FIXTURE);
    expect(res.status).toBe(404);
  });

  test('Confirmar sin referencias válidas → 400', async () => {
    const res = await ag
      .post('/api/tesoreria/extracto/confirmar')
      .attach('archivo', FIXTURE)
      .field('cuenta_id', cuentaId)
      .field('referencias', JSON.stringify(['REFERENCIA_QUE_NO_EXISTE']));
    expect(res.status).toBe(400);
  });
});

// ── Preview ───────────────────────────────────────────────────────────────────

describe('Preview', () => {
  let ag;
  beforeAll(async () => { ag = agente(); await ag.post('/api/auth/login').send({ email: EMAIL, password: PASS }); });

  test('Cuenta sin movimientos → todas las transacciones marcadas como nuevo', async () => {
    const res = await ag
      .post(`/api/tesoreria/extracto/preview?cuenta_id=${cuentaId}`)
      .attach('archivo', FIXTURE);

    expect(res.status).toBe(200);
    expect(res.body.resumen.total).toBe(4);
    expect(res.body.resumen.nuevas).toBe(4);
    expect(res.body.resumen.duplicadas).toBe(0);
    expect(res.body.transacciones.every(t => t.estado === 'nuevo')).toBe(true);
  });

  test('Devuelve saldos del extracto', async () => {
    const res = await ag
      .post(`/api/tesoreria/extracto/preview?cuenta_id=${cuentaId}`)
      .attach('archivo', FIXTURE);

    expect(res.body.saldos).toHaveLength(2);
    expect(res.body.saldos[0].tipo).toBe('inicial');
  });

  test('Devuelve info de la cuenta seleccionada', async () => {
    const res = await ag
      .post(`/api/tesoreria/extracto/preview?cuenta_id=${cuentaId}`)
      .attach('archivo', FIXTURE);

    expect(res.body.cuenta).toMatchObject({ id: cuentaId, nombre: 'Bancolombia Test' });
  });
});

// ── Confirmar importación ─────────────────────────────────────────────────────

describe('Confirmar importación', () => {
  let ag;
  beforeAll(async () => { ag = agente(); await ag.post('/api/auth/login').send({ email: EMAIL, password: PASS }); });

  test('Importa correctamente las 4 transacciones del fixture', async () => {
    // C-4: referencias son claves compuestas ref|fecha|monto (dos decimales)
    // para distinguir transacciones del banco que reutilizan el mismo código.
    const claves = [
      'REF001UNICO|2026-09-01|126000.00',
      'REFCOMPARTIDA|2026-09-01|75000.00',
      'REFCOMPARTIDA|2026-09-01|50000.00',
      'REFEGRESO01|2026-09-01|200000.00',
    ];

    const res = await ag
      .post('/api/tesoreria/extracto/confirmar')
      .attach('archivo', FIXTURE)
      .field('cuenta_id', cuentaId)
      .field('referencias', JSON.stringify(claves));

    expect(res.status).toBe(200);
    expect(res.body.importadas).toBe(4);
    expect(res.body.omitidas).toBe(0);
  });

  test('Los movimientos quedan en BD con origen=extracto', async () => {
    const { rows } = await pool.query(
      `SELECT * FROM tesoreria_movimientos WHERE cuenta_id = $1 ORDER BY monto`,
      [cuentaId]
    );
    expect(rows).toHaveLength(4);
    expect(rows.every(r => r.origen === 'extracto')).toBe(true);
  });

  test('Los movimientos tienen referencia_bancaria poblada', async () => {
    const { rows } = await pool.query(
      `SELECT referencia_bancaria FROM tesoreria_movimientos WHERE cuenta_id = $1`,
      [cuentaId]
    );
    const refs = rows.map(r => r.referencia_bancaria);
    expect(refs).toContain('REF001UNICO');
    expect(refs).toContain('REFEGRESO01');
    expect(refs.filter(r => r === 'REFCOMPARTIDA')).toHaveLength(2);
  });

  test('El log en tesoreria_extractos queda registrado', async () => {
    const { rows } = await pool.query(
      `SELECT * FROM tesoreria_extractos WHERE cuenta_id = $1`,
      [cuentaId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].importadas).toBe(4);
    expect(rows[0].omitidas).toBe(0);
  });
});

// ── Deduplicación ─────────────────────────────────────────────────────────────

describe('Deduplicación', () => {
  let ag;
  beforeAll(async () => { ag = agente(); await ag.post('/api/auth/login').send({ email: EMAIL, password: PASS }); });

  test('Re-importar el mismo archivo: importadas=0, omitidas=4 (caída elegante)', async () => {
    const claves = [
      'REF001UNICO|2026-09-01|126000.00',
      'REFCOMPARTIDA|2026-09-01|75000.00',
      'REFCOMPARTIDA|2026-09-01|50000.00',
      'REFEGRESO01|2026-09-01|200000.00',
    ];

    const res = await ag
      .post('/api/tesoreria/extracto/confirmar')
      .attach('archivo', FIXTURE)
      .field('cuenta_id', cuentaId)
      .field('referencias', JSON.stringify(claves));

    expect(res.status).toBe(200);
    expect(res.body.importadas).toBe(0);
    expect(res.body.omitidas).toBe(4);
    expect(res.body.detalle_omitidas.every(o => o.razon === 'ya registrada')).toBe(true);
  });

  test('Preview tras importar: todas aparecen como ya_registrado', async () => {
    const res = await ag
      .post(`/api/tesoreria/extracto/preview?cuenta_id=${cuentaId}`)
      .attach('archivo', FIXTURE);

    expect(res.status).toBe(200);
    expect(res.body.resumen.nuevas).toBe(0);
    expect(res.body.resumen.duplicadas).toBe(4);
    expect(res.body.transacciones.every(t => t.estado === 'ya_registrado')).toBe(true);
  });

  test('Misma referencia + diferente monto NO es duplicado', async () => {
    // REFCOMPARTIDA existe con montos 75000 y 50000.
    // Si llegara una tercera con REFCOMPARTIDA + monto distinto, debe importarse.
    // Verificamos el índice directamente: el constraint es (cuenta_id, ref, fecha, monto).
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS total FROM tesoreria_movimientos
        WHERE cuenta_id = $1 AND referencia_bancaria = 'REFCOMPARTIDA'`,
      [cuentaId]
    );
    expect(Number(rows[0].total)).toBe(2); // ambas coexisten
  });

  test('Misma referencia + mismo monto + misma fecha SÍ es duplicado (constraint BD)', async () => {
    await expect(
      pool.query(
        `INSERT INTO tesoreria_movimientos
           (tipo, monto, fecha, referencia_bancaria, cuenta_id, origen)
         VALUES ('ingreso', 75000, '2026-09-01', 'REFCOMPARTIDA', $1, 'extracto')`,
        [cuentaId]
      )
    ).rejects.toMatchObject({ code: '23505' });
  });
});
