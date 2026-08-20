import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';

let app;
const adminEmail = 'gerencia-admin@kernel.test';
const adminPass  = 'testpass123';
let adminUuid;

const agAdmin = () => request.agent(app);

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(adminPass, 4);

  const { rows: [admin] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Gerencia Admin', $1, $2, 'admin', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [adminEmail, hash]
  );
  adminUuid = admin.id;
});

afterAll(async () => {
  await pool.query('DELETE FROM global_usuarios WHERE id = $1', [adminUuid]);
  await pool.end();
});

// ── Auth ─────────────────────────────────────────────────────────────────────

describe('Gerencia — Auth', () => {
  test('Rechaza sin token en /resumen', async () => {
    const res = await request(app).get('/api/gerencia/resumen');
    expect(res.status).toBe(401);
  });

  test('Rechaza sin token en /cobertura/:sorteoId', async () => {
    const res = await request(app).get('/api/gerencia/cobertura/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(401);
  });
});

// ── GET /resumen ──────────────────────────────────────────────────────────────

describe('GET /gerencia/resumen', () => {
  let ag;
  beforeAll(async () => {
    ag = agAdmin();
    await ag.post('/api/auth/login').send({ email: adminEmail, password: adminPass });
  });

  test('Responde 200 con estructura completa', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);

    // Asociados
    expect(res.body).toHaveProperty('asociados');
    expect(res.body.asociados).toHaveProperty('activos');
    expect(res.body.asociados).toHaveProperty('total');
    expect(res.body.asociados).toHaveProperty('con_portal');
    expect(res.body.asociados).toHaveProperty('adopcion_pct');
    expect(res.body.asociados).toHaveProperty('adopcion_serie');
    expect(Array.isArray(res.body.asociados.adopcion_serie)).toBe(true);

    // Sorteos
    expect(res.body).toHaveProperty('sorteos');
    expect(Array.isArray(res.body.sorteos)).toBe(true);

    // Serie sorteos
    expect(res.body).toHaveProperty('sorteos_serie');
    expect(Array.isArray(res.body.sorteos_serie)).toBe(true);

    // Patronales
    expect(res.body).toHaveProperty('patronales');
    expect(res.body.patronales).toHaveProperty('total_causado');
    expect(res.body.patronales).toHaveProperty('total_cobrado');
    expect(res.body.patronales).toHaveProperty('total_mora');
    expect(res.body.patronales).toHaveProperty('empresas_en_deuda');
    expect(res.body.patronales).toHaveProperty('top_mora');
    expect(Array.isArray(res.body.patronales.top_mora)).toBe(true);

    // Logs
    expect(res.body).toHaveProperty('logs');
    expect(Array.isArray(res.body.logs)).toBe(true);

    // Pendientes
    expect(res.body).toHaveProperty('pendientes');
    expect(res.body.pendientes).toHaveProperty('bonos');
    expect(res.body.pendientes).toHaveProperty('portal');
  });

  test('adopcion_pct es número entre 0 y 100', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const pct = res.body.asociados.adopcion_pct;
    expect(typeof pct).toBe('number');
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(100);
  });

  test('adopcion_serie tiene estructura correcta', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    for (const fila of res.body.asociados.adopcion_serie) {
      expect(fila).toHaveProperty('dia');
      expect(fila).toHaveProperty('nuevos');
      expect(fila).toHaveProperty('acumulado');
      expect(typeof fila.acumulado).toBe('number');
      // Acumulado siempre creciente
    }
  });

  test('acumulado de adopción es monótonamente creciente', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const serie = res.body.asociados.adopcion_serie;
    for (let i = 1; i < serie.length; i++) {
      expect(serie[i].acumulado).toBeGreaterThanOrEqual(serie[i - 1].acumulado);
    }
  });

  test('campos numéricos de asociados son enteros no negativos', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    const { activos, total, con_portal } = res.body.asociados;
    expect(Number.isInteger(activos)).toBe(true);
    expect(Number.isInteger(total)).toBe(true);
    expect(Number.isInteger(con_portal)).toBe(true);
    expect(activos).toBeGreaterThanOrEqual(0);
    expect(total).toBeGreaterThanOrEqual(activos);
    expect(con_portal).toBeGreaterThanOrEqual(0);
  });

  test('logs tiene máximo 10 entradas', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    expect(res.body.logs.length).toBeLessThanOrEqual(10);
  });

  test('top_mora tiene máximo 5 entradas', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    expect(res.body.patronales.top_mora.length).toBeLessThanOrEqual(5);
  });

  test('cada sorteo tiene campos requeridos', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    for (const s of res.body.sorteos) {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('nombre');
      expect(s).toHaveProperty('boletos_asignados');
      expect(s).toHaveProperty('boletos_total');
      expect(s).toHaveProperty('ingreso_mensual');
      expect(s).toHaveProperty('solicitudes_pendientes');
    }
  });

  test('cartera tiene estructura correcta', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('cartera');
    const { cartera } = res.body;
    expect(cartera).toHaveProperty('creditos_activos');
    expect(cartera).toHaveProperty('cartera_total');
    expect(cartera).toHaveProperty('obligacion_total');
    expect(cartera).toHaveProperty('intereses_mensual');
    expect(cartera).toHaveProperty('tasa_promedio_ponderada');
    expect(cartera).toHaveProperty('distribucion');
    expect(cartera).toHaveProperty('vencimientos');
    expect(cartera).toHaveProperty('plazos');
    expect(Number.isInteger(cartera.creditos_activos)).toBe(true);
    expect(cartera.creditos_activos).toBeGreaterThanOrEqual(0);
    expect(Number(cartera.cartera_total)).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(cartera.distribucion)).toBe(true);
    expect(Array.isArray(cartera.vencimientos)).toBe(true);
    expect(Array.isArray(cartera.plazos)).toBe(true);
  });

  test('vencimientos devuelve exactamente 12 meses', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    expect(res.body.cartera.vencimientos.length).toBe(12);
  });

  test('vencimientos tiene campos correctos por fila', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    for (const fila of res.body.cartera.vencimientos) {
      expect(fila).toHaveProperty('mes');
      expect(fila).toHaveProperty('creditos');
      expect(fila).toHaveProperty('capital');
      expect(fila).toHaveProperty('intereses');
      expect(fila.mes).toMatch(/^\d{4}-\d{2}$/);
      expect(Number(fila.creditos)).toBeGreaterThanOrEqual(0);
      expect(Number(fila.capital)).toBeGreaterThanOrEqual(0);
      expect(Number(fila.intereses)).toBeGreaterThanOrEqual(0);
    }
  });

  test('vencimientos ordenados cronológicamente', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const venc = res.body.cartera.vencimientos;
    for (let i = 1; i < venc.length; i++) {
      expect(venc[i].mes > venc[i - 1].mes).toBe(true);
    }
  });

  test('plazos tiene campos correctos por fila', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    for (const fila of res.body.cartera.plazos) {
      expect(fila).toHaveProperty('plazo_id');
      expect(fila).toHaveProperty('plazo');
      expect(fila).toHaveProperty('creditos');
      expect(fila).toHaveProperty('saldo');
      expect(fila).toHaveProperty('intereses_mensual');
      expect(fila).toHaveProperty('cuotas_promedio');
      expect(typeof fila.plazo).toBe('string');
      expect(Number(fila.creditos)).toBeGreaterThan(0);
      expect(Number(fila.saldo)).toBeGreaterThan(0);
    }
  });

  test('plazos ordenados por plazo_id ascendente', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const plazos = res.body.cartera.plazos;
    for (let i = 1; i < plazos.length; i++) {
      expect(Number(plazos[i].plazo_id)).toBeGreaterThan(Number(plazos[i - 1].plazo_id));
    }
  });

  test('distribucion tiene estructura correcta por fila', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    for (const fila of res.body.cartera.distribucion) {
      expect(fila).toHaveProperty('rango_id');
      expect(fila).toHaveProperty('rango');
      expect(fila).toHaveProperty('cantidad');
      expect(fila).toHaveProperty('subtotal');
      expect(typeof fila.rango).toBe('string');
      expect(Number(fila.cantidad)).toBeGreaterThan(0);
      expect(Number(fila.subtotal)).toBeGreaterThan(0);
    }
  });

  test('distribucion ordenada por rango_id ascendente', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const dist = res.body.cartera.distribucion;
    for (let i = 1; i < dist.length; i++) {
      expect(Number(dist[i].rango_id)).toBeGreaterThan(Number(dist[i - 1].rango_id));
    }
  });
});

// ── Cartera — cálculos con datos reales ──────────────────────────────────────

describe('Cartera de créditos — cálculos', () => {
  let ag;
  const codigoTest = '99999999';

  beforeAll(async () => {
    ag = agAdmin();
    await ag.post('/api/auth/login').send({ email: adminEmail, password: adminPass });

    // Asociado activo de prueba
    await pool.query(`
      INSERT INTO asociados (codigo, apellido, nombre, clase_cuota, is_active)
      VALUES ($1, 'Cartera', 'Test Gerencia', '1', true)
      ON CONFLICT (codigo) DO UPDATE SET is_active = true
    `, [codigoTest]);

    // Dos créditos: uno en rango $1M–$5M y otro en rango $5M–$10M
    await pool.query(`
      INSERT INTO asociado_descuentos (asociado_codigo, linea_id, nombre_linea, valor, saldo_credito, valor_obligacion)
      VALUES
        ($1, 9901, 'Crédito Test A', 100000, 3000000, 5000000),
        ($1, 9902, 'Crédito Test B', 200000, 7000000, 10000000)
      ON CONFLICT (asociado_codigo, linea_id) DO UPDATE
        SET saldo_credito = EXCLUDED.saldo_credito,
            valor_obligacion = EXCLUDED.valor_obligacion
    `, [codigoTest]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM asociado_descuentos WHERE asociado_codigo = $1`, [codigoTest]);
    await pool.query(`DELETE FROM asociados WHERE codigo = $1`, [codigoTest]);
  });

  test('cartera_total incluye los saldos de prueba', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    // La suma total debe incluir al menos los 10M de los dos créditos de prueba
    expect(Number(res.body.cartera.cartera_total)).toBeGreaterThanOrEqual(10_000_000);
  });

  test('creditos_activos incluye los créditos de prueba', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    expect(res.body.cartera.creditos_activos).toBeGreaterThanOrEqual(2);
  });

  test('obligacion_total es mayor o igual a cartera_total', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const { cartera_total, obligacion_total } = res.body.cartera;
    expect(Number(obligacion_total)).toBeGreaterThanOrEqual(Number(cartera_total));
  });

  test('distribucion contiene los rangos de los créditos de prueba', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const dist = res.body.cartera.distribucion;
    const rangos = dist.map(r => r.rango);
    // $3M → rango '$1M–$5M' (rango_id 2)
    expect(rangos).toContain('$1M–$5M');
    // $7M → rango '$5M–$10M' (rango_id 3)
    expect(rangos).toContain('$5M–$10M');
  });

  test('crédito de asociado inactivo no se cuenta', async () => {
    // Desactivar el asociado de prueba
    await pool.query(`UPDATE asociados SET is_active = false WHERE codigo = $1`, [codigoTest]);

    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);

    // Verificar en DB cuántos créditos activos hay sin el asociado inactivo
    const { rows: [{ total }] } = await pool.query(`
      SELECT COUNT(ad.id)::int AS total
      FROM asociado_descuentos ad
      JOIN asociados a ON a.codigo = ad.asociado_codigo AND a.is_active = true
      WHERE ad.saldo_credito > 0
    `);
    expect(res.body.cartera.creditos_activos).toBe(total);

    // Reactivar para cleanup
    await pool.query(`UPDATE asociados SET is_active = true WHERE codigo = $1`, [codigoTest]);
  });
});

// ── Distribución de plazos — cálculos con datos reales ───────────────────────

describe('Distribución de plazos — cálculos', () => {
  let ag;
  const codigoPlazos = '88888888';

  beforeAll(async () => {
    ag = agAdmin();
    await ag.post('/api/auth/login').send({ email: adminEmail, password: adminPass });

    await pool.query(`
      INSERT INTO asociados (codigo, apellido, nombre, clase_cuota, is_active)
      VALUES ($1, 'Plazos', 'Test Gerencia', '1', true)
      ON CONFLICT (codigo) DO UPDATE SET is_active = true
    `, [codigoPlazos]);

    // Crédito corto plazo (≤12 meses), tasa 2%
    // Crédito mediano plazo (13–24 meses), tasa 3%
    // Crédito largo plazo (25–48 meses), tasa 1.5%
    await pool.query(`
      INSERT INTO asociado_descuentos
        (asociado_codigo, linea_id, nombre_linea, valor, saldo_credito, num_cuotas, tasa_interes)
      VALUES
        ($1, 8801, 'Corto Test',   50000, 1000000, 6,  2.0),
        ($1, 8802, 'Mediano Test', 50000, 4000000, 18, 3.0),
        ($1, 8803, 'Largo Test',   50000, 9000000, 36, 1.5)
      ON CONFLICT (asociado_codigo, linea_id) DO UPDATE
        SET saldo_credito = EXCLUDED.saldo_credito,
            num_cuotas    = EXCLUDED.num_cuotas,
            tasa_interes  = EXCLUDED.tasa_interes
    `, [codigoPlazos]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM asociado_descuentos WHERE asociado_codigo = $1`, [codigoPlazos]);
    await pool.query(`DELETE FROM asociados WHERE codigo = $1`, [codigoPlazos]);
  });

  test('plazos contiene el rango ≤ 12 meses', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const etiquetas = res.body.cartera.plazos.map(r => r.plazo);
    expect(etiquetas).toContain('≤ 12 meses');
  });

  test('plazos contiene el rango 13–24 meses', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const etiquetas = res.body.cartera.plazos.map(r => r.plazo);
    expect(etiquetas).toContain('13–24 meses');
  });

  test('plazos contiene el rango 25–48 meses', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const etiquetas = res.body.cartera.plazos.map(r => r.plazo);
    expect(etiquetas).toContain('25–48 meses');
  });

  test('saldo del rango ≤ 12 meses incluye el crédito corto de prueba', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const corto = res.body.cartera.plazos.find(r => r.plazo === '≤ 12 meses');
    expect(corto).toBeDefined();
    expect(Number(corto.saldo)).toBeGreaterThanOrEqual(1_000_000);
  });

  test('intereses_mensual del rango corto es saldo × tasa / 100', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const corto = res.body.cartera.plazos.find(r => r.plazo === '≤ 12 meses');
    expect(corto).toBeDefined();
    // 1_000_000 × 2% / 100 = 20_000 de nuestro crédito seed (puede haber más)
    expect(Number(corto.intereses_mensual)).toBeGreaterThanOrEqual(20_000);
  });

  test('suma de creditos de plazos coincide con creditos_activos total de cartera', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const sumPlazos = res.body.cartera.plazos.reduce((s, r) => s + Number(r.creditos), 0);
    expect(sumPlazos).toBe(res.body.cartera.creditos_activos);
  });

  test('suma de saldos de plazos coincide con cartera_total', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const sumSaldos = res.body.cartera.plazos.reduce((s, r) => s + Number(r.saldo), 0);
    expect(sumSaldos).toBe(Number(res.body.cartera.cartera_total));
  });

  test('créditos de asociado inactivo no aparecen en plazos', async () => {
    await pool.query(`UPDATE asociados SET is_active = false WHERE codigo = $1`, [codigoPlazos]);
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const sumPlazos = res.body.cartera.plazos.reduce((s, r) => s + Number(r.creditos), 0);
    expect(sumPlazos).toBe(res.body.cartera.creditos_activos);
    await pool.query(`UPDATE asociados SET is_active = true WHERE codigo = $1`, [codigoPlazos]);
  });
});

// ── Bienestar — estructura y cálculos ────────────────────────────────────────

describe('Bienestar — estructura y cálculos', () => {
  let ag;
  const codigoBien = '77777777';

  beforeAll(async () => {
    ag = agAdmin();
    await ag.post('/api/auth/login').send({ email: adminEmail, password: adminPass });

    await pool.query(`
      INSERT INTO asociados (codigo, apellido, nombre, clase_cuota, is_active)
      VALUES ($1, 'Bienestar', 'Test Gerencia', '1', true)
      ON CONFLICT (codigo) DO UPDATE SET is_active = true
    `, [codigoBien]);

    await pool.query(`
      INSERT INTO asociado_descuentos (asociado_codigo, linea_id, nombre_linea, valor, fecha_pri_descuento)
      VALUES ($1, 17, 'FONDO DE BIENESTAR', 25000, '2024-01-01')
      ON CONFLICT (asociado_codigo, linea_id) DO UPDATE
        SET valor = EXCLUDED.valor,
            fecha_pri_descuento = EXCLUDED.fecha_pri_descuento
    `, [codigoBien]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM asociado_descuentos WHERE asociado_codigo = $1`, [codigoBien]);
    await pool.query(`DELETE FROM asociados WHERE codigo = $1`, [codigoBien]);
  });

  test('respuesta incluye clave bienestar con estructura correcta', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('bienestar');
    const b = res.body.bienestar;
    expect(b).toHaveProperty('asociados');
    expect(b).toHaveProperty('mensual');
    expect(b).toHaveProperty('anual');
    expect(b).toHaveProperty('lineas');
    expect(Array.isArray(b.lineas)).toBe(true);
    expect(Number.isInteger(b.asociados)).toBe(true);
    expect(Number(b.mensual)).toBeGreaterThanOrEqual(0);
    expect(Number(b.anual)).toBeGreaterThanOrEqual(0);
  });

  test('anual es exactamente mensual × 12', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const { mensual, anual } = res.body.bienestar;
    expect(Number(anual)).toBe(Number(mensual) * 12);
  });

  test('mensual incluye el aporte del asociado seed', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    expect(Number(res.body.bienestar.mensual)).toBeGreaterThanOrEqual(25_000);
  });

  test('lineas tiene campos correctos por fila', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    for (const l of res.body.bienestar.lineas) {
      expect(l).toHaveProperty('nombre_linea');
      expect(l).toHaveProperty('asociados');
      expect(l).toHaveProperty('mensual');
      expect(typeof l.nombre_linea).toBe('string');
      expect(Number(l.mensual)).toBeGreaterThan(0);
      expect(Number.isInteger(l.asociados)).toBe(true);
    }
  });

  test('lineas ordenadas por mensual descendente', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const lineas = res.body.bienestar.lineas;
    for (let i = 1; i < lineas.length; i++) {
      expect(Number(lineas[i].mensual)).toBeLessThanOrEqual(Number(lineas[i - 1].mensual));
    }
  });

  test('suma de mensual por línea iguala mensual total', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const { bienestar } = res.body;
    const sumaLineas = bienestar.lineas.reduce((s, l) => s + Number(l.mensual), 0);
    expect(sumaLineas).toBe(Number(bienestar.mensual));
  });

  test('sin fecha_pri_descuento no se cuenta en bienestar', async () => {
    // Quitar la fecha — simula que aún no empieza a pagar
    await pool.query(`
      UPDATE asociado_descuentos SET fecha_pri_descuento = NULL
      WHERE asociado_codigo = $1 AND linea_id = 17
    `, [codigoBien]);

    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);

    const { rows: [{ total }] } = await pool.query(`
      SELECT COALESCE(SUM(ad.valor), 0)::bigint AS total
      FROM asociado_descuentos ad
      JOIN asociados a ON a.codigo = ad.asociado_codigo AND a.is_active = true
      WHERE UPPER(ad.nombre_linea) LIKE '%BIENESTAR%' AND ad.valor > 0
        AND ad.fecha_pri_descuento IS NOT NULL AND ad.fecha_pri_descuento <= CURRENT_DATE
    `);
    expect(Number(res.body.bienestar.mensual)).toBe(Number(total));

    // Restaurar
    await pool.query(`
      UPDATE asociado_descuentos SET fecha_pri_descuento = '2024-01-01'
      WHERE asociado_codigo = $1 AND linea_id = 17
    `, [codigoBien]);
  });

  test('serie tiene exactamente 12 meses', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    expect(res.body.bienestar.serie.length).toBe(12);
  });

  test('serie tiene campos correctos por fila', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    for (const fila of res.body.bienestar.serie) {
      expect(fila).toHaveProperty('mes');
      expect(fila).toHaveProperty('asociados');
      expect(fila).toHaveProperty('recaudo');
      expect(fila.mes).toMatch(/^\d{4}-\d{2}$/);
      expect(Number(fila.recaudo)).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(fila.asociados)).toBe(true);
    }
  });

  test('serie ordenada cronológicamente', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const serie = res.body.bienestar.serie;
    for (let i = 1; i < serie.length; i++) {
      expect(serie[i].mes > serie[i - 1].mes).toBe(true);
    }
  });

  test('último mes de la serie incluye al menos el recaudo actual', async () => {
    // La serie usa fecha <= fin de mes; mensual usa fecha <= hoy.
    // Si hay asociados cuyo primer descuento es futuro dentro del mes,
    // el último mes de la serie puede ser >= mensual.
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const ultimo = res.body.bienestar.serie[res.body.bienestar.serie.length - 1];
    expect(Number(ultimo.recaudo)).toBeGreaterThanOrEqual(Number(res.body.bienestar.mensual));
  });

  test('asociado inactivo no se incluye en bienestar', async () => {
    await pool.query(`UPDATE asociados SET is_active = false WHERE codigo = $1`, [codigoBien]);
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    // el mensual no debe incluir los 25000 del seed inactivo
    // verificamos comparando contra la DB directamente
    const { rows: [{ total }] } = await pool.query(`
      SELECT COALESCE(SUM(ad.valor), 0)::bigint AS total
      FROM asociado_descuentos ad
      JOIN asociados a ON a.codigo = ad.asociado_codigo AND a.is_active = true
      WHERE UPPER(ad.nombre_linea) LIKE '%BIENESTAR%' AND ad.valor > 0
        AND ad.fecha_pri_descuento IS NOT NULL AND ad.fecha_pri_descuento <= CURRENT_DATE
    `);
    expect(Number(res.body.bienestar.mensual)).toBe(Number(total));
    await pool.query(`UPDATE asociados SET is_active = true WHERE codigo = $1`, [codigoBien]);
  });
});

// ── Seguros — estructura y cálculos ──────────────────────────────────────────

describe('Seguros — estructura y cálculos', () => {
  let ag;
  const codigoSeg = '66666666';

  beforeAll(async () => {
    ag = agAdmin();
    await ag.post('/api/auth/login').send({ email: adminEmail, password: adminPass });

    await pool.query(`
      INSERT INTO asociados (codigo, apellido, nombre, clase_cuota, is_active)
      VALUES ($1, 'Seguros', 'Test Gerencia', '1', true)
      ON CONFLICT (codigo) DO UPDATE SET is_active = true
    `, [codigoSeg]);

    await pool.query(`
      INSERT INTO asociado_descuentos (asociado_codigo, linea_id, nombre_linea, valor, fecha_pri_descuento)
      VALUES
        ($1, 5,    'SEGURO DE VIDA',              18000, '2024-01-01'),
        ($1, 1018, 'SEGURO VEHÍCULO',             35000, '2024-03-01'),
        ($1, 1027, 'SOAT',                        12000, '2024-06-01'),
        ($1, 24,   'LOS OLIVOS - SERVICIO EXEQUIAL', 8000, '2024-02-01'),
        ($1, 1040, 'FUNERARIA LOS OLIVOS',         6000, '2024-04-01')
      ON CONFLICT (asociado_codigo, linea_id) DO UPDATE
        SET valor = EXCLUDED.valor,
            fecha_pri_descuento = EXCLUDED.fecha_pri_descuento
    `, [codigoSeg]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM asociado_descuentos WHERE asociado_codigo = $1`, [codigoSeg]);
    await pool.query(`DELETE FROM asociados WHERE codigo = $1`, [codigoSeg]);
  });

  test('respuesta incluye clave seguros con estructura correcta', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('seguros');
    const s = res.body.seguros;
    expect(s).toHaveProperty('asociados');
    expect(s).toHaveProperty('mensual');
    expect(s).toHaveProperty('anual');
    expect(s).toHaveProperty('lineas');
    expect(s).toHaveProperty('serie');
    expect(Array.isArray(s.lineas)).toBe(true);
    expect(Array.isArray(s.serie)).toBe(true);
    expect(Number.isInteger(s.asociados)).toBe(true);
    expect(Number(s.mensual)).toBeGreaterThanOrEqual(0);
  });

  test('anual es exactamente mensual × 12', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const { mensual, anual } = res.body.seguros;
    expect(Number(anual)).toBe(Number(mensual) * 12);
  });

  test('mensual incluye todos los seguros y funerarios del seed', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    // 18000 + 35000 + 12000 + 8000 + 6000 = 79000 del seed
    expect(Number(res.body.seguros.mensual)).toBeGreaterThanOrEqual(79_000);
  });

  test('lineas contiene SEGURO DE VIDA del seed', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const nombres = res.body.seguros.lineas.map(l => l.nombre_linea);
    expect(nombres).toContain('SEGURO DE VIDA');
  });

  test('lineas contiene SOAT del seed', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const nombres = res.body.seguros.lineas.map(l => l.nombre_linea);
    expect(nombres).toContain('SOAT');
  });

  test('lineas contiene servicios exequiales del seed', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const nombres = res.body.seguros.lineas.map(l => l.nombre_linea);
    expect(nombres).toContain('LOS OLIVOS - SERVICIO EXEQUIAL');
    expect(nombres).toContain('FUNERARIA LOS OLIVOS');
  });

  test('lineas ordenadas por mensual descendente', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const lineas = res.body.seguros.lineas;
    for (let i = 1; i < lineas.length; i++) {
      expect(Number(lineas[i].mensual)).toBeLessThanOrEqual(Number(lineas[i - 1].mensual));
    }
  });

  test('suma de mensual por línea iguala mensual total', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const { seguros } = res.body;
    const suma = seguros.lineas.reduce((s, l) => s + Number(l.mensual), 0);
    expect(suma).toBe(Number(seguros.mensual));
  });

  test('serie tiene exactamente 12 meses ordenados', async () => {
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);
    const serie = res.body.seguros.serie;
    expect(serie.length).toBe(12);
    for (let i = 1; i < serie.length; i++) {
      expect(serie[i].mes > serie[i - 1].mes).toBe(true);
    }
  });

  test('sin fecha_pri_descuento no se cuenta en seguros', async () => {
    await pool.query(`
      UPDATE asociado_descuentos SET fecha_pri_descuento = NULL
      WHERE asociado_codigo = $1 AND linea_id = 5
    `, [codigoSeg]);

    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);

    const { rows: [{ total }] } = await pool.query(`
      SELECT COALESCE(SUM(ad.valor), 0)::bigint AS total
      FROM asociado_descuentos ad
      JOIN asociados a ON a.codigo = ad.asociado_codigo AND a.is_active = true
      WHERE (UPPER(ad.nombre_linea) LIKE '%SEGURO%'
             OR UPPER(ad.nombre_linea) LIKE '%PÓLIZA%'
             OR UPPER(ad.nombre_linea) LIKE '%SOAT%'
             OR UPPER(ad.nombre_linea) LIKE '%EXEQUIAL%'
             OR UPPER(ad.nombre_linea) LIKE '%FUNERARI%'
             OR UPPER(ad.nombre_linea) LIKE '%OFRENDA%')
        AND ad.valor > 0
        AND ad.fecha_pri_descuento IS NOT NULL AND ad.fecha_pri_descuento <= CURRENT_DATE
    `);
    expect(Number(res.body.seguros.mensual)).toBe(Number(total));

    await pool.query(`
      UPDATE asociado_descuentos SET fecha_pri_descuento = '2024-01-01'
      WHERE asociado_codigo = $1 AND linea_id = 5
    `, [codigoSeg]);
  });

  test('asociado inactivo no se incluye en seguros', async () => {
    await pool.query(`UPDATE asociados SET is_active = false WHERE codigo = $1`, [codigoSeg]);
    const res = await ag.get('/api/gerencia/resumen');
    expect(res.status).toBe(200);

    const { rows: [{ total }] } = await pool.query(`
      SELECT COALESCE(SUM(ad.valor), 0)::bigint AS total
      FROM asociado_descuentos ad
      JOIN asociados a ON a.codigo = ad.asociado_codigo AND a.is_active = true
      WHERE (UPPER(ad.nombre_linea) LIKE '%SEGURO%'
             OR UPPER(ad.nombre_linea) LIKE '%PÓLIZA%'
             OR UPPER(ad.nombre_linea) LIKE '%SOAT%'
             OR UPPER(ad.nombre_linea) LIKE '%EXEQUIAL%'
             OR UPPER(ad.nombre_linea) LIKE '%FUNERARI%'
             OR UPPER(ad.nombre_linea) LIKE '%OFRENDA%')
        AND ad.valor > 0
        AND ad.fecha_pri_descuento IS NOT NULL AND ad.fecha_pri_descuento <= CURRENT_DATE
    `);
    expect(Number(res.body.seguros.mensual)).toBe(Number(total));

    await pool.query(`UPDATE asociados SET is_active = true WHERE codigo = $1`, [codigoSeg]);
  });
});

// ── GET /cobertura/:sorteoId ──────────────────────────────────────────────────

describe('GET /gerencia/cobertura/:sorteoId', () => {
  let ag;
  beforeAll(async () => {
    ag = agAdmin();
    await ag.post('/api/auth/login').send({ email: adminEmail, password: adminPass });
  });

  test('UUID inexistente devuelve array vacío (no error)', async () => {
    const res = await ag.get('/api/gerencia/cobertura/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  test('Con sorteo real devuelve estructura correcta', async () => {
    // Buscar cualquier sorteo existente
    const { rows } = await pool.query(`SELECT id FROM sorteos LIMIT 1`);
    if (!rows.length) return; // Si no hay sorteos, skip

    const sorteoId = rows[0].id;
    const res = await ag.get(`/api/gerencia/cobertura/${sorteoId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    for (const emp of res.body) {
      expect(emp).toHaveProperty('codigo');
      expect(emp).toHaveProperty('nombre');
      expect(emp).toHaveProperty('asociados_activos');
      expect(emp).toHaveProperty('bonos_asignados');
      expect(Number(emp.asociados_activos)).toBeGreaterThan(0);
      expect(Number(emp.bonos_asignados)).toBeGreaterThanOrEqual(0);
    }
  });

  test('UUID mal formado devuelve 500 o 400 (no crash sin respuesta)', async () => {
    const res = await ag.get('/api/gerencia/cobertura/no-es-un-uuid');
    // PostgreSQL rechazará el UUID inválido — debe llegar respuesta (no timeout)
    expect([400, 422, 500]).toContain(res.status);
  });
});
