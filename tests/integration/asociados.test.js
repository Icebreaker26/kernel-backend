import request  from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool     from '../../src/db/database.js';
import bcrypt   from 'bcrypt';

let app;
const adminEmail  = 'asoc-admin@kernel.test';
const adminPass   = 'testpass123';
let adminUuid;
const testCodigo  = '9999999999';

const agent      = () => request.agent(app);
const loginAdmin = (ag) => ag.post('/api/auth/login').send({ email: adminEmail, password: adminPass });

const CSV_VALIDO = `codigo,apellido,nombre,direccion,movil,clase_cuota,empresa_dsto,nombre_empresa,ciudad
${testCodigo},Torres,Test,Calle 1,3001234567,1,EMP01,Empresa Test,Pereira`;

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(adminPass, 4);

  const { rows: [admin] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Asoc Admin', $1, $2, 'admin', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [adminEmail, hash]
  );
  adminUuid = admin.id;
  // admin rol bypasses checkPermission — no necesita entradas en permisos
});

afterAll(async () => {
  await pool.query('DELETE FROM asociados        WHERE codigo = $1',       [testCodigo]);
  await pool.query('DELETE FROM empresas         WHERE codigo = $1',       ['EMP01']);
  await pool.query('DELETE FROM sincronizaciones WHERE usuario_uuid = $1', [adminUuid]);
  await pool.query('DELETE FROM global_usuarios  WHERE id = $1',           [adminUuid]);
  await pool.end();
});

// ── CSV import ────────────────────────────────────────────────────────────────

describe('Asociados — importar CSV', () => {
  test('POST /api/asociados/importar sin archivo → 400', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.post('/api/asociados/importar');
    expect(res.status).toBe(400);
  });

  test('POST /api/asociados/importar CSV válido → 200 con contadores', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(CSV_VALIDO), 'test.csv');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('nuevos');
    expect(res.body).toHaveProperty('actualizados');
    expect(res.body).toHaveProperty('retirados');
    expect(res.body.nuevos + res.body.actualizados).toBeGreaterThan(0);
  });

  test('POST /api/asociados/importar segunda vez → actualizados (sin tocar portal_activo)', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(CSV_VALIDO), 'test2.csv');
    expect(res.status).toBe(200);
    expect(res.body.actualizados).toBeGreaterThan(0);

    // Verificar que el reimport no resetea portal_activo ni password_hash
    const { rows } = await pool.query(
      'SELECT portal_activo, password_hash FROM asociados WHERE codigo = $1',
      [testCodigo]
    );
    expect(rows[0].portal_activo).toBe(false);
    expect(rows[0].password_hash).toBeNull();
  });
});

// ── Listado admin ─────────────────────────────────────────────────────────────

describe('Asociados — listado admin', () => {
  test('GET /api/asociados sin token → 401', async () => {
    const res = await request(app).get('/api/asociados');
    expect(res.status).toBe(401);
  });

  test('GET /api/asociados autenticado → 200 array con portal_activo y primer_login', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/asociados');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const asoc = res.body.find((a) => a.codigo === testCodigo);
    expect(asoc).toBeDefined();
    expect(asoc).toHaveProperty('portal_activo', false);
    expect(asoc).toHaveProperty('primer_login',  false);
  });
});

// ── Portal opt-in ─────────────────────────────────────────────────────────────

describe('Asociados — portal opt-in', () => {
  let passwordGenerada;

  test('POST /api/asociados/login sin portal activo → 401', async () => {
    const res = await request(app)
      .post('/api/asociados/login')
      .send({ codigo: testCodigo, password: 'cualquier' });
    expect(res.status).toBe(401);
  });

  test('POST /api/asociados/:codigo/activar-portal → 200 + password', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.post(`/api/asociados/${testCodigo}/activar-portal`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('password');
    expect(typeof res.body.password).toBe('string');
    expect(res.body.password.length).toBeGreaterThan(0);
    passwordGenerada = res.body.password;

    // Verificar estado en DB
    const { rows } = await pool.query(
      'SELECT portal_activo, primer_login FROM asociados WHERE codigo = $1',
      [testCodigo]
    );
    expect(rows[0].portal_activo).toBe(true);
    expect(rows[0].primer_login).toBe(true);
  });

  test('POST /api/asociados/login con password generada → 200 + primer_login=true', async () => {
    const res = await request(app)
      .post('/api/asociados/login')
      .send({ codigo: testCodigo, password: passwordGenerada });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('codigo', testCodigo);
    expect(res.body).toHaveProperty('primer_login', true);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  test('GET /api/asociados/me autenticado → 200 + primer_login=true', async () => {
    const ag = agent();
    await ag.post('/api/asociados/login').send({ codigo: testCodigo, password: passwordGenerada });
    const res = await ag.get('/api/asociados/me');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('codigo', testCodigo);
    expect(res.body).toHaveProperty('primer_login', true);
  });

  test('PUT /api/asociados/password — contraseña actual incorrecta → 401', async () => {
    const ag = agent();
    await ag.post('/api/asociados/login').send({ codigo: testCodigo, password: passwordGenerada });
    const res = await ag.put('/api/asociados/password').send({
      password_actual: 'esto_no_es_la_clave',
      password_nueva:  'nuevaclave123',
    });
    expect(res.status).toBe(401);
  });

  test('PUT /api/asociados/password correcto → 200 + primer_login=false en DB', async () => {
    const ag = agent();
    await ag.post('/api/asociados/login').send({ codigo: testCodigo, password: passwordGenerada });
    const res = await ag.put('/api/asociados/password').send({
      password_actual: passwordGenerada,
      password_nueva:  'nuevaclave456',
    });
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      'SELECT primer_login FROM asociados WHERE codigo = $1',
      [testCodigo]
    );
    expect(rows[0].primer_login).toBe(false);
  });

  test('POST /api/asociados/login con nueva contraseña → 200 + primer_login=false', async () => {
    const res = await request(app)
      .post('/api/asociados/login')
      .send({ codigo: testCodigo, password: 'nuevaclave456' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('primer_login', false);
  });

  test('POST /api/asociados/:codigo/activar-portal de nuevo → genera nueva password', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.post(`/api/asociados/${testCodigo}/activar-portal`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('password');
    expect(res.body.password).not.toBe(passwordGenerada); // diferente cada vez
  });

  test('POST /api/asociados/:codigo/desactivar-portal → 200 + acceso revocado', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.post(`/api/asociados/${testCodigo}/desactivar-portal`);
    expect(res.status).toBe(200);

    const { rows } = await pool.query(
      'SELECT portal_activo, password_hash FROM asociados WHERE codigo = $1',
      [testCodigo]
    );
    expect(rows[0].portal_activo).toBe(false);
    expect(rows[0].password_hash).toBeNull();
  });

  test('POST /api/asociados/login tras desactivar → 401', async () => {
    const res = await request(app)
      .post('/api/asociados/login')
      .send({ codigo: testCodigo, password: 'nuevaclave456' });
    expect(res.status).toBe(401);
  });
});

// ── Auth portal ───────────────────────────────────────────────────────────────

describe('Asociados — portal auth', () => {
  test('GET /api/asociados/me sin token → 401', async () => {
    const res = await request(app).get('/api/asociados/me');
    expect(res.status).toBe(401);
  });
});

// ── Auditoría ─────────────────────────────────────────────────────────────────

describe('Asociados — auditoría', () => {
  test('GET /api/asociados/sincronizaciones → 200 array', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/asociados/sincronizaciones');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });
});

// ── Detalle de sincronización ─────────────────────────────────────────────────

describe('Asociados — detalle de sincronización', () => {
  let sincId;

  beforeAll(async () => {
    const { rows } = await pool.query(
      `SELECT id FROM sincronizaciones WHERE usuario_uuid = $1 ORDER BY created_at DESC LIMIT 1`,
      [adminUuid]
    );
    sincId = rows[0]?.id;
  });

  test('GET /api/asociados/sincronizaciones/:id → 200 con estructura de detalle', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get(`/api/asociados/sincronizaciones/${sincId}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('nuevos');
    expect(res.body).toHaveProperty('retirados');
    expect(res.body).toHaveProperty('boletos_liberados');
    expect(Array.isArray(res.body.nuevos)).toBe(true);
    expect(Array.isArray(res.body.retirados)).toBe(true);
    expect(Array.isArray(res.body.boletos_liberados)).toBe(true);
  });

  test('GET /api/asociados/sincronizaciones/:id inexistente → 404', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/asociados/sincronizaciones/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  test('GET /api/asociados/sincronizaciones/:id sin token → 401', async () => {
    const res = await request(app).get(`/api/asociados/sincronizaciones/${sincId}`);
    expect(res.status).toBe(401);
  });
});

// ── Liberación de boletos en sync ─────────────────────────────────────────────

describe('Asociados — liberación de boletos en sync CSV', () => {
  let sorteoId;
  const codigoRetirado = '888888999';

  const csvConRetirado = [
    'codigo,apellido,nombre,direccion,movil,clase_cuota,empresa_dsto,nombre_empresa,ciudad',
    `${testCodigo},Torres,Test,Calle 1,3001234567,1,EMP01,Empresa Test,Pereira`,
    `${codigoRetirado},Gomez,Prueba,Calle 2,3009999999,2,EMP01,Empresa Test,Bogota`,
  ].join('\n');

  const csvSinRetirado = [
    'codigo,apellido,nombre,direccion,movil,clase_cuota,empresa_dsto,nombre_empresa,ciudad',
    `${testCodigo},Torres,Test,Calle 1,3001234567,1,EMP01,Empresa Test,Pereira`,
  ].join('\n');

  beforeAll(async () => {
    // Importar el asociado que luego se retirará
    await pool.query(
      `INSERT INTO asociados (codigo, apellido, nombre, direccion, movil, clase_cuota, empresa_dsto, nombre_empresa, ciudad)
       VALUES ($1,'Gomez','Prueba','Calle 2','3009999999','2','EMP01','Empresa Test','Bogota')
       ON CONFLICT (codigo) DO UPDATE SET is_active = true, fecha_retiro = NULL`,
      [codigoRetirado]
    );

    // Crear sorteo y boleto asignado a ese asociado
    const { rows: [s] } = await pool.query(
      `INSERT INTO sorteos (nombre, estado) VALUES ('Sorteo Sync Test', 'activo') RETURNING id`
    );
    sorteoId = s.id;

    await pool.query(
      `INSERT INTO boletos (numero, sorteo_id, asociado_codigo, estado, fecha_asignacion)
       VALUES (999, $1, $2, 'asignado', NOW())
       ON CONFLICT (numero, sorteo_id) DO UPDATE SET estado = 'asignado', asociado_codigo = $2`,
      [sorteoId, codigoRetirado]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM sorteo_logs    WHERE sorteo_id = $1',      [sorteoId]);
    await pool.query('DELETE FROM boletos        WHERE sorteo_id = $1',      [sorteoId]);
    await pool.query('DELETE FROM sorteos        WHERE id = $1',             [sorteoId]);
    await pool.query('DELETE FROM asociados      WHERE codigo = $1',         [codigoRetirado]);
    await pool.query('DELETE FROM sincronizaciones WHERE usuario_uuid = $1', [adminUuid]);
  });

  test('sync que incluye el asociado → boleto sigue asignado', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(csvConRetirado), 'con_retirado.csv');
    expect(res.status).toBe(200);
    expect(res.body.boletos_liberados).toBe(0);

    const { rows: [b] } = await pool.query(
      'SELECT estado FROM boletos WHERE numero = 999 AND sorteo_id = $1', [sorteoId]
    );
    expect(b.estado).toBe('asignado');
  });

  test('sync sin el asociado → boleto queda libre', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(csvSinRetirado), 'sin_retirado.csv');
    expect(res.status).toBe(200);
    expect(res.body.retirados).toBeGreaterThan(0);
    expect(res.body.boletos_liberados).toBeGreaterThan(0);

    const { rows: [b] } = await pool.query(
      'SELECT estado, asociado_codigo FROM boletos WHERE numero = 999 AND sorteo_id = $1', [sorteoId]
    );
    expect(b.estado).toBe('libre');
    expect(b.asociado_codigo).toBeNull();
  });

  test('log LIBERACION_POR_RETIRO_CSV registrado en sorteo_logs', async () => {
    const { rows } = await pool.query(
      `SELECT * FROM sorteo_logs WHERE sorteo_id = $1 AND accion = 'LIBERACION_POR_RETIRO_CSV'`,
      [sorteoId]
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].asociado_codigo).toBe(codigoRetirado);
    expect(rows[0].numero).toBe(999);
  });

  test('detalle del sync refleja retirado y boleto liberado', async () => {
    const ag = agent();
    await loginAdmin(ag);

    const { rows: [sinc] } = await pool.query(
      `SELECT id FROM sincronizaciones WHERE usuario_uuid = $1 ORDER BY created_at DESC LIMIT 1`,
      [adminUuid]
    );
    const res = await ag.get(`/api/asociados/sincronizaciones/${sinc.id}`);
    expect(res.status).toBe(200);

    const retiradoCodigos = res.body.retirados.map((r) => r.codigo);
    expect(retiradoCodigos).toContain(codigoRetirado);

    const boletosLiberados = res.body.boletos_liberados.map((b) => b.numero);
    expect(boletosLiberados).toContain(999);
  });

  test('sync idempotente → boletos ya libres no se cuentan de nuevo', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(csvSinRetirado), 'idem.csv');
    expect(res.status).toBe(200);
    expect(res.body.boletos_liberados).toBe(0);
  });
});

// ── Historial de aportes ──────────────────────────────────────────────────────

describe('Asociados — historial de aportes', () => {
  beforeAll(async () => {
    // Asegura que el asociado de test existe con valores de aporte
    await pool.query(
      `UPDATE asociados SET valor_aporte = 50000, saldo_aporte = 0 WHERE codigo = $1`,
      [testCodigo]
    );
    // Forzar un cambio para que el trigger dispare
    await pool.query(
      `UPDATE asociados SET valor_aporte = 60000 WHERE codigo = $1`,
      [testCodigo]
    );
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM asociado_historial_aporte WHERE asociado_codigo = $1`,
      [testCodigo]
    );
  });

  test('GET /api/asociados/:codigo/historial-aporte sin token → 401', async () => {
    const res = await request(app).get(`/api/asociados/${testCodigo}/historial-aporte`);
    expect(res.status).toBe(401);
  });

  test('GET /api/asociados/:codigo/historial-aporte → 200 array', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get(`/api/asociados/${testCodigo}/historial-aporte`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('El trigger registra el cambio de valor_aporte', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const { body } = await ag.get(`/api/asociados/${testCodigo}/historial-aporte`);
    const cambioAporte = body.find((h) => h.campo === 'valor_aporte');
    expect(cambioAporte).toBeDefined();
    expect(cambioAporte).toHaveProperty('valor_anterior');
    expect(cambioAporte).toHaveProperty('valor_nuevo');
    expect(cambioAporte).toHaveProperty('changed_at');
    expect(Number(cambioAporte.valor_anterior)).toBe(50000);
    expect(Number(cambioAporte.valor_nuevo)).toBe(60000);
  });

  test('El trigger no registra si el valor no cambia', async () => {
    // Misma operación UPDATE sin cambio de valor
    const { rowCount: antes } = await pool.query(
      `SELECT * FROM asociado_historial_aporte WHERE asociado_codigo = $1`, [testCodigo]
    );
    await pool.query(
      `UPDATE asociados SET valor_aporte = 60000 WHERE codigo = $1`, [testCodigo]
    );
    const { rows: despues } = await pool.query(
      `SELECT * FROM asociado_historial_aporte WHERE asociado_codigo = $1`, [testCodigo]
    );
    // No debe haber crecido
    expect(despues.length).toBe(antes);
  });

  test('Cada entrada del historial tiene estructura correcta', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const { body } = await ag.get(`/api/asociados/${testCodigo}/historial-aporte`);
    if (body.length > 0) {
      const entry = body[0];
      expect(entry).toHaveProperty('campo');
      expect(entry).toHaveProperty('valor_anterior');
      expect(entry).toHaveProperty('valor_nuevo');
      expect(entry).toHaveProperty('changed_at');
    }
  });
});

// ── Reconciliación línea 15 ───────────────────────────────────────────────────

describe('Asociados — reconciliación línea 15 (bonos)', () => {
  let sorteoId;

  // Códigos aislados para no interferir con los demás tests
  const COD_OK    = '7771111111'; // activo + boleto + cuota correcta → sin discrepancia
  const COD_RET   = '7772222222'; // NO en línea 1 (retirado) + en línea 15 → COBRO_A_RETIRADO
  const COD_SB    = '7773333333'; // activo + sin boleto + en línea 15 → COBRO_SIN_BOLETO
  const COD_MAL   = '7774444444'; // activo + boleto + cuota incorrecta → MONTO_INCORRECTO
  const COD_SC    = '7775555555'; // activo + boleto + ausente en línea 15 → SIN_COBRO_EXTERNO

  // CSV con línea 1 + línea 15. testCodigo incluido para no retirar el asociado global.
  // periodo_descto='1-Mensual' → factor=1 → cuota_kernel = precio_boleto = 3000
  const buildCSV = () => [
    'linea,codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad,direccion,movil,cuota,periodo_descto',
    `1,${testCodigo},Torres,Test,1,EMP01,Empresa Test,Pereira,Calle 1,3001234567,,`,
    `1,${COD_OK},Activo,Ok,1,EMP_REC,Empresa Recon,Bogota,Calle A,3010000001,,`,
    `1,${COD_SB},SinBoleto,Test,1,EMP_REC,Empresa Recon,Bogota,Calle C,3010000003,,`,
    `1,${COD_MAL},MontoMal,Test,1,EMP_REC,Empresa Recon,Bogota,Calle D,3010000004,,`,
    `1,${COD_SC},SinCobro,Test,1,EMP_REC,Empresa Recon,Bogota,Calle E,3010000005,,`,
    `15,${COD_OK},Activo,Ok,1,EMP_REC,Empresa Recon,Bogota,Calle A,3010000001,3.000,1-Mensual`,  // mensual correcto
    `15,${COD_RET},Retirado,Test,1,EMP_REC,Empresa Recon,Bogota,Calle B,3010000002,3.000,1-Mensual`, // retirado
    `15,${COD_SB},SinBoleto,Test,1,EMP_REC,Empresa Recon,Bogota,Calle C,3010000003,3.000,1-Mensual`, // sin boleto
    `15,${COD_MAL},MontoMal,Test,1,EMP_REC,Empresa Recon,Bogota,Calle D,3010000004,2.000,1-Mensual`, // monto mal
    // COD_SC ausente de línea 15 → SIN_COBRO_EXTERNO
  ].join('\n');

  beforeAll(async () => {
    // Sorteo activo con precio_boleto = 3000 y línea CSV 15 configurada
    const { rows: [s] } = await pool.query(
      `INSERT INTO sorteos (nombre, estado, precio_boleto, linea_reconciliacion)
       VALUES ('Sorteo Recon Test', 'activo', 3000, '15')
       RETURNING id`
    );
    sorteoId = s.id;

    // Asociados activos en DB
    for (const [codigo, apellido, nombre] of [
      [COD_OK,  'Activo',    'Ok'],
      [COD_SB,  'SinBoleto', 'Test'],
      [COD_MAL, 'MontoMal',  'Test'],
      [COD_SC,  'SinCobro',  'Test'],
    ]) {
      await pool.query(
        `INSERT INTO asociados (codigo, apellido, nombre, clase_cuota, empresa_dsto, nombre_empresa, ciudad)
         VALUES ($1, $2, $3, '1', 'EMP_REC', 'Empresa Recon', 'Bogota')
         ON CONFLICT (codigo) DO UPDATE SET is_active = true`,
        [codigo, apellido, nombre]
      );
    }

    // Boletos asignados: COD_OK (901), COD_MAL (902), COD_SC (903)
    for (const [numero, codigo] of [[901, COD_OK], [902, COD_MAL], [903, COD_SC]]) {
      await pool.query(
        `INSERT INTO boletos (numero, sorteo_id, asociado_codigo, estado, fecha_asignacion)
         VALUES ($1, $2, $3, 'asignado', NOW())
         ON CONFLICT (numero, sorteo_id) DO UPDATE SET estado = 'asignado', asociado_codigo = $3`,
        [numero, sorteoId, codigo]
      );
    }
  });

  afterAll(async () => {
    await pool.query('DELETE FROM sorteo_logs WHERE sorteo_id = $1',      [sorteoId]);
    await pool.query('DELETE FROM boletos     WHERE sorteo_id = $1',      [sorteoId]);
    await pool.query('DELETE FROM sorteos     WHERE id = $1',             [sorteoId]);
    await pool.query('DELETE FROM asociados   WHERE codigo = ANY($1)',    [[COD_OK, COD_SB, COD_MAL, COD_SC]]);
    await pool.query('DELETE FROM empresas    WHERE codigo = $1',         ['EMP_REC']);
    await pool.query('DELETE FROM sincronizaciones WHERE usuario_uuid = $1', [adminUuid]);
  });

  test('CSV con línea 15 → discrepancias es array', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(buildCSV()), 'recon.csv');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.discrepancias)).toBe(true);
  });

  test('COBRO_A_RETIRADO — asociado en línea 15 pero no en línea 1', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const { body } = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(buildCSV()), 'recon.csv');
    const caso = body.discrepancias.find((d) => d.tipo === 'COBRO_A_RETIRADO' && d.codigo === COD_RET);
    expect(caso).toBeDefined();
    expect(caso.cuota_externa).toBeGreaterThan(0);
    expect(caso.cuota_kernel).toBe(0);
  });

  test('COBRO_SIN_BOLETO — asociado activo en línea 15 pero sin boleto en Kernel', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const { body } = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(buildCSV()), 'recon.csv');
    const caso = body.discrepancias.find((d) => d.tipo === 'COBRO_SIN_BOLETO' && d.codigo === COD_SB);
    expect(caso).toBeDefined();
    expect(caso.cuota_externa).toBeGreaterThan(0);
    expect(caso.cuota_kernel).toBe(0);
  });

  test('MONTO_INCORRECTO — cuota externa ≠ cuota Kernel', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const { body } = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(buildCSV()), 'recon.csv');
    const caso = body.discrepancias.find((d) => d.tipo === 'MONTO_INCORRECTO' && d.codigo === COD_MAL);
    expect(caso).toBeDefined();
    expect(caso.cuota_externa).toBe(2000);
    expect(caso.cuota_kernel).toBe(3000);
    expect(caso.diferencia).toBe(-1000);
  });

  test('SIN_COBRO_EXTERNO — activo con boleto en Kernel pero ausente en línea 15', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const { body } = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(buildCSV()), 'recon.csv');
    const caso = body.discrepancias.find((d) => d.tipo === 'SIN_COBRO_EXTERNO' && d.codigo === COD_SC);
    expect(caso).toBeDefined();
    expect(caso.cuota_externa).toBe(0);
    expect(caso.cuota_kernel).toBe(3000);
  });

  test('Asociado con monto correcto NO aparece en discrepancias', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const { body } = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(buildCSV()), 'recon.csv');
    const aparece = body.discrepancias.some((d) => d.codigo === COD_OK);
    expect(aparece).toBe(false);
  });

  test('Total discrepancias = 4 (retirado + sin boleto + monto mal + sin cobro)', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const { body } = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(buildCSV()), 'recon.csv');
    expect(body.discrepancias.length).toBe(4);
  });

  // Este test va ÚLTIMO: retira los 4 asociados y libera sus boletos
  // El sorteo del beforeAll tiene linea_reconciliacion='15' pero el CSV no trae filas de esa línea
  // → discrepancias es [] (array vacío, no null) porque sí hay sorteos configurados pero sin filas que auditar
  test('CSV sin filas de línea 15 → discrepancias es array vacío', async () => {
    const csvSinL15 = [
      'codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad',
      `${testCodigo},Torres,Test,1,EMP01,Empresa Test,Pereira`,
    ].join('\n');
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(csvSinL15), 'sin_l15.csv');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.discrepancias)).toBe(true);
    expect(res.body.discrepancias.length).toBe(0);
  });
});

// ── sync_id en respuesta de importación ─────────────────────────────────────

describe('Asociados — sync_id en importación', () => {
  test('POST /api/asociados/importar incluye sync_id UUID', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(CSV_VALIDO), 'syncid.csv');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sync_id');
    expect(typeof res.body.sync_id).toBe('string');
    expect(res.body.sync_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });
});

// ── aceptar-terminos portal ──────────────────────────────────────────────────

describe('Asociados — aceptar-terminos (portal)', () => {
  let passwordPortal;

  beforeAll(async () => {
    const ag = agent();
    await loginAdmin(ag);
    const { body } = await ag.post(`/api/asociados/${testCodigo}/activar-portal`);
    passwordPortal = body.password;
  });

  afterAll(async () => {
    const ag = agent();
    await loginAdmin(ag);
    await ag.post(`/api/asociados/${testCodigo}/desactivar-portal`);
    await pool.query(
      'UPDATE asociados SET acepto_terminos_portal_at = NULL WHERE codigo = $1',
      [testCodigo]
    );
  });

  test('POST /api/asociados/aceptar-terminos sin sesión de portal → 401', async () => {
    const res = await request(app).post('/api/asociados/aceptar-terminos');
    expect(res.status).toBe(401);
  });

  test('POST /api/asociados/aceptar-terminos con sesión → 200 + graba timestamp', async () => {
    const ag = agent();
    await ag.post('/api/asociados/login').send({ codigo: testCodigo, password: passwordPortal });
    const res = await ag.post('/api/asociados/aceptar-terminos');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);

    const { rows: [row] } = await pool.query(
      'SELECT acepto_terminos_portal_at FROM asociados WHERE codigo = $1',
      [testCodigo]
    );
    expect(row.acepto_terminos_portal_at).not.toBeNull();
  });

  test('POST /api/asociados/aceptar-terminos idempotente → 200', async () => {
    const ag = agent();
    await ag.post('/api/asociados/login').send({ codigo: testCodigo, password: passwordPortal });
    const res = await ag.post('/api/asociados/aceptar-terminos');
    expect(res.status).toBe(200);
  });
});

// ── subsanar discrepancia en sincronización ──────────────────────────────────

describe('Asociados — subsanar discrepancia', () => {
  let sincId;
  const codigoDisc = '7779999888';

  beforeAll(async () => {
    const detalle = {
      nuevos: [], retirados: [], boletos_liberados: [], errores: [],
      discrepancias: [
        {
          tipo: 'COBRO_SIN_BOLETO',
          codigo: codigoDisc,
          nombre: 'Test Subsanar',
          empresa: 'EMP01',
          cuota_externa: 3000,
          cuota_kernel: 0,
          diferencia: 3000,
          bonos_sugeridos: 1,
        },
      ],
    };
    const { rows: [s] } = await pool.query(
      `INSERT INTO sincronizaciones
         (usuario_uuid, archivo, total, nuevos, actualizados, retirados, errores, boletos_liberados, detalle)
       VALUES ($1, 'test-subsanar.csv', 1, 0, 0, 0, 0, 0, $2)
       RETURNING id`,
      [adminUuid, JSON.stringify(detalle)]
    );
    sincId = s.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM sincronizaciones WHERE id = $1', [sincId]);
  });

  test('PATCH sin token → 401', async () => {
    const res = await request(app)
      .patch(`/api/asociados/sincronizaciones/${sincId}/subsanar/${codigoDisc}`);
    expect(res.status).toBe(401);
  });

  test('PATCH sincronización inexistente → 404', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .patch(`/api/asociados/sincronizaciones/00000000-0000-0000-0000-000000000000/subsanar/${codigoDisc}`)
      .send({ numeros: [42], sorteo_id: '00000000-0000-0000-0000-000000000001', sorteo_nombre: 'X' });
    expect(res.status).toBe(404);
  });

  test('PATCH código inexistente en discrepancias → 404', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .patch(`/api/asociados/sincronizaciones/${sincId}/subsanar/CODIGO_NO_EXISTE`)
      .send({ numeros: [42] });
    expect(res.status).toBe(404);
  });

  test('PATCH válido → 200 + subsanada=true en JSONB + numeros_asignados', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .patch(`/api/asociados/sincronizaciones/${sincId}/subsanar/${codigoDisc}`)
      .send({
        numeros: [42, 43],
        sorteo_id: '00000000-0000-0000-0000-000000000001',
        sorteo_nombre: 'Sorteo Test',
      });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);

    const { rows: [row] } = await pool.query(
      'SELECT detalle FROM sincronizaciones WHERE id = $1',
      [sincId]
    );
    const disc = row.detalle.discrepancias.find((d) => d.codigo === codigoDisc);
    expect(disc.subsanada).toBe(true);
    expect(disc.subsanada_at).toBeDefined();
    expect(disc.numeros_asignados).toEqual([42, 43]);
    expect(disc.sorteo_nombre).toBe('Sorteo Test');
  });
});

// ── Pago en efectivo por bono ─────────────────────────────────────────────────

describe('Asociados — pago en efectivo por bono', () => {
  let sincId;
  const codigoPago = '7778887776';

  const makeDetalle = (boletos_count = 2) => ({
    discrepancias: [
      {
        tipo: 'SIN_COBRO_EXTERNO',
        codigo: codigoPago,
        nombre: 'Test Pago',
        empresa: 'EMP01',
        cuota_kernel: 6000,
        cuota_externa: 0,
        boletos_count,
        sorteo_id: '00000000-0000-0000-0000-000000000099',
      },
      {
        tipo: 'MONTO_INCORRECTO',
        codigo: codigoPago,
        nombre: 'Test Pago',
        empresa: 'EMP01',
        cuota_kernel: 3000,
        cuota_externa: 2000,
        diferencia: 1000,
        boletos_count: 1,
        sorteo_id: '00000000-0000-0000-0000-000000000099',
      },
    ],
  });

  beforeEach(async () => {
    const { rows: [s] } = await pool.query(
      `INSERT INTO sincronizaciones
         (usuario_uuid, archivo, total, nuevos, actualizados, retirados, errores, boletos_liberados, detalle)
       VALUES ($1, 'test-pago.csv', 1, 0, 0, 0, 0, 0, $2)
       RETURNING id`,
      [adminUuid, JSON.stringify(makeDetalle())]
    );
    sincId = s.id;
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM sorteo_logs WHERE empleado_uuid = $1 AND accion = 'PAGO_EFECTIVO'`, [adminUuid]);
    await pool.query(`DELETE FROM cobros_efectivo WHERE registrado_por_uuid = $1`, [adminUuid]);
    await pool.query(`DELETE FROM admin_logs WHERE usuario_uuid = $1 AND accion = 'PAGO_EFECTIVO_DISCREPANCIA'`, [adminUuid]);
    await pool.query('DELETE FROM sincronizaciones WHERE id = $1', [sincId]);
  });

  test('POST sin token → 401', async () => {
    const res = await request(app)
      .post(`/api/asociados/sincronizaciones/${sincId}/subsanar/${codigoPago}/pago`);
    expect(res.status).toBe(401);
  });

  test('POST body inválido → 400', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post(`/api/asociados/sincronizaciones/${sincId}/subsanar/${codigoPago}/pago`)
      .send({});
    expect(res.status).toBe(400);
  });

  test('POST sincronización inexistente → 404', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post(`/api/asociados/sincronizaciones/00000000-0000-0000-0000-000000000000/subsanar/${codigoPago}/pago`)
      .send({ tipo_discrepancia: 'SIN_COBRO_EXTERNO', numero_bono: 101, monto: 3000, tipo_pago: 'banco', comprobante: 'REC-001' });
    expect(res.status).toBe(404);
  });

  test('POST código no existe en discrepancias → 404', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post(`/api/asociados/sincronizaciones/${sincId}/subsanar/CODIGO_INEXISTENTE/pago`)
      .send({ tipo_discrepancia: 'SIN_COBRO_EXTERNO', numero_bono: 101, monto: 3000, tipo_pago: 'banco', comprobante: 'REC-001' });
    expect(res.status).toBe(404);
  });

  test('POST primer pago SIN_COBRO_EXTERNO → 200, subsanada=false (boletos_count=2)', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post(`/api/asociados/sincronizaciones/${sincId}/subsanar/${codigoPago}/pago`)
      .send({ tipo_discrepancia: 'SIN_COBRO_EXTERNO', numero_bono: 101, monto: 3000, tipo_pago: 'banco', comprobante: 'REC-001', comentario: 'Pago Juan' });
    expect(res.status).toBe(200);
    expect(res.body.subsanada).toBe(false);
    expect(res.body.pagos_count).toBe(1);
    expect(res.body.boletos_count).toBe(2);
  });

  test('POST segundo pago → subsanada=true (completa los 2 boletos)', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const base = { tipo_discrepancia: 'SIN_COBRO_EXTERNO', tipo_pago: 'caja', monto: 3000 };
    await ag.post(`/api/asociados/sincronizaciones/${sincId}/subsanar/${codigoPago}/pago`)
      .send({ ...base, numero_bono: 101, comprobante: 'REC-001' });
    const res = await ag.post(`/api/asociados/sincronizaciones/${sincId}/subsanar/${codigoPago}/pago`)
      .send({ ...base, numero_bono: 102, comprobante: 'REC-002' });
    expect(res.status).toBe(200);
    expect(res.body.subsanada).toBe(true);
    expect(res.body.pagos_count).toBe(2);

    const { rows: [row] } = await pool.query('SELECT detalle FROM sincronizaciones WHERE id = $1', [sincId]);
    const disc = row.detalle.discrepancias.find((d) => d.codigo === codigoPago && d.tipo === 'SIN_COBRO_EXTERNO');
    expect(disc.subsanada).toBe(true);
    expect(disc.subsanada_at).toBeDefined();
    expect(disc.pagos_efectivo).toHaveLength(2);
    expect(disc.pagos_efectivo[0]).toMatchObject({ numero_bono: 101, comprobante: 'REC-001' });
    expect(disc.pagos_efectivo[1]).toMatchObject({ numero_bono: 102, comprobante: 'REC-002' });
  });

  test('POST bono duplicado → 409', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const body = { tipo_discrepancia: 'SIN_COBRO_EXTERNO', numero_bono: 101, monto: 3000, tipo_pago: 'banco', comprobante: 'REC-001' };
    await ag.post(`/api/asociados/sincronizaciones/${sincId}/subsanar/${codigoPago}/pago`).send(body);
    const res = await ag.post(`/api/asociados/sincronizaciones/${sincId}/subsanar/${codigoPago}/pago`).send(body);
    expect(res.status).toBe(409);
  });

  test('POST pago MONTO_INCORRECTO (boletos_count=1) → subsanada=true al primer pago', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post(`/api/asociados/sincronizaciones/${sincId}/subsanar/${codigoPago}/pago`)
      .send({ tipo_discrepancia: 'MONTO_INCORRECTO', numero_bono: 201, monto: 1000, tipo_pago: 'caja', comprobante: 'CAJ-001', comentario: 'Diferencia pagada en caja' });
    expect(res.status).toBe(200);
    expect(res.body.subsanada).toBe(true);
    expect(res.body.pagos_count).toBe(1);
  });

  test('Cada pago persiste comprobante, tipo_pago, comentario y registrado_por en JSONB', async () => {
    const ag = agent();
    await loginAdmin(ag);
    await ag.post(`/api/asociados/sincronizaciones/${sincId}/subsanar/${codigoPago}/pago`)
      .send({ tipo_discrepancia: 'SIN_COBRO_EXTERNO', numero_bono: 101, monto: 3000, tipo_pago: 'banco', comprobante: 'REC-XYZ', comentario: 'Contexto de prueba' });

    const { rows: [row] } = await pool.query('SELECT detalle FROM sincronizaciones WHERE id = $1', [sincId]);
    const pago = row.detalle.discrepancias.find((d) => d.tipo === 'SIN_COBRO_EXTERNO').pagos_efectivo[0];
    expect(pago.comprobante).toBe('REC-XYZ');
    expect(pago.tipo_pago).toBe('banco');
    expect(pago.comentario).toBe('Contexto de prueba');
    expect(pago.registrado_at).toBeDefined();
    expect(pago.registrado_por_uuid).toBe(adminUuid);
    expect(pago.registrado_por_nombre).toBeDefined();
  });

  test('Registrar pago inserta entrada en admin_logs', async () => {
    const ag = agent();
    await loginAdmin(ag);
    await ag.post(`/api/asociados/sincronizaciones/${sincId}/subsanar/${codigoPago}/pago`)
      .send({ tipo_discrepancia: 'SIN_COBRO_EXTERNO', numero_bono: 101, monto: 3000, tipo_pago: 'caja', comprobante: 'LOG-001', comentario: 'Test log' });

    const { rows } = await pool.query(
      `SELECT accion, objetivo_tipo, objetivo_id, detalle
       FROM admin_logs
       WHERE usuario_uuid = $1 AND accion = 'PAGO_EFECTIVO_DISCREPANCIA'
       ORDER BY created_at DESC LIMIT 1`,
      [adminUuid]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].accion).toBe('PAGO_EFECTIVO_DISCREPANCIA');
    expect(rows[0].objetivo_tipo).toBe('asociado');
    expect(rows[0].objetivo_id).toBe(codigoPago);
    const detalle = JSON.parse(rows[0].detalle);
    expect(detalle.numero_bono).toBe(101);
    expect(detalle.tipo_pago).toBe('caja');
    expect(detalle.comprobante).toBe('LOG-001');
    expect(detalle.sync_id).toBe(sincId);
  });
});

// ── Dry-run (preview sin escritura) ──────────────────────────────────────────

describe('Asociados — importar preview (dry-run)', () => {
  test('POST /api/asociados/importar/preview sin token → 401', async () => {
    const res = await request(app)
      .post('/api/asociados/importar/preview')
      .attach('archivo', Buffer.from(CSV_VALIDO), 'dry.csv');
    expect(res.status).toBe(401);
  });

  test('POST /api/asociados/importar/preview sin archivo → 400', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.post('/api/asociados/importar/preview');
    expect(res.status).toBe(400);
  });

  test('POST /api/asociados/importar/preview CSV válido → 200 con estructura de impacto', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/asociados/importar/preview')
      .attach('archivo', Buffer.from(CSV_VALIDO), 'dry.csv');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total_csv');
    expect(res.body).toHaveProperty('validos');
    expect(res.body).toHaveProperty('errores_formato');
    expect(res.body).toHaveProperty('impacto');
    expect(res.body.impacto).toHaveProperty('nuevos');
    expect(res.body.impacto).toHaveProperty('actualizados');
    expect(res.body.impacto).toHaveProperty('retirados');
    expect(res.body.impacto).toHaveProperty('activos_actuales');
    expect(Array.isArray(res.body.advertencias)).toBe(true);
  });

  test('POST /api/asociados/importar/preview no escribe en sincronizaciones', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const { rows: [{ c: antes }] } = await pool.query(
      'SELECT COUNT(*) AS c FROM sincronizaciones WHERE usuario_uuid = $1',
      [adminUuid]
    );
    await ag
      .post('/api/asociados/importar/preview')
      .attach('archivo', Buffer.from(CSV_VALIDO), 'dry.csv');
    const { rows: [{ c: despues }] } = await pool.query(
      'SELECT COUNT(*) AS c FROM sincronizaciones WHERE usuario_uuid = $1',
      [adminUuid]
    );
    expect(Number(despues)).toBe(Number(antes));
  });

  test('POST /api/asociados/importar/preview devuelve activos_actuales correcto', async () => {
    const { rows: [{ count: activosDB }] } = await pool.query(
      'SELECT COUNT(*) AS count FROM asociados WHERE is_active = true'
    );
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag
      .post('/api/asociados/importar/preview')
      .attach('archivo', Buffer.from(CSV_VALIDO), 'dry.csv');
    expect(res.status).toBe(200);
    expect(res.body.impacto.activos_actuales).toBe(Number(activosDB));
  });
});

// ── Snapshot activos_antes ────────────────────────────────────────────────────

describe('Asociados — snapshot activos_antes en detalle de sync', () => {
  afterAll(async () => {
    await pool.query('DELETE FROM sincronizaciones WHERE usuario_uuid = $1', [adminUuid]);
  });

  test('POST /api/asociados/importar guarda activos_antes correcto en detalle', async () => {
    const { rows: [{ count: activosAntes }] } = await pool.query(
      'SELECT COUNT(*) AS count FROM asociados WHERE is_active = true'
    );

    const ag = agent();
    await loginAdmin(ag);
    await ag
      .post('/api/asociados/importar')
      .attach('archivo', Buffer.from(CSV_VALIDO), 'snap.csv');

    const { rows: [sinc] } = await pool.query(
      `SELECT detalle FROM sincronizaciones WHERE usuario_uuid = $1 ORDER BY created_at DESC LIMIT 1`,
      [adminUuid]
    );
    expect(sinc).toBeDefined();
    expect(sinc.detalle).toHaveProperty('activos_antes');
    expect(typeof sinc.detalle.activos_antes).toBe('number');
    expect(sinc.detalle.activos_antes).toBe(Number(activosAntes));
  });
});

// ── Revert encadenado ────────────────────────────────────────────────────────

describe('Asociados — revert encadenado (A luego B)', () => {
  let sincIdA, sincIdB;

  const CSV_A = `codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad
REV_A01,García,Pedro,1,EMP01,Empresa Test,Pereira`;

  const CSV_B = `codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad
REV_B01,López,Ana,1,EMP01,Empresa Test,Pereira`;

  beforeAll(async () => {
    await pool.query('DELETE FROM sincronizaciones WHERE usuario_uuid = $1', [adminUuid]);
    await pool.query("DELETE FROM asociados WHERE codigo IN ('REV_A01','REV_B01')");

    const ag = agent();
    await loginAdmin(ag);
    const rA = await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(CSV_A), 'a.csv');
    sincIdA = rA.body.sync_id;

    const rB = await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(CSV_B), 'b.csv');
    sincIdB = rB.body.sync_id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM sincronizaciones WHERE usuario_uuid = $1', [adminUuid]);
    await pool.query("DELETE FROM asociados WHERE codigo IN ('REV_A01','REV_B01')");
  });

  test('Revertir A (no el más reciente) → 409', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.post(`/api/asociados/sincronizaciones/${sincIdA}/revertir`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/más reciente/i);
  });

  test('Revertir B (el más reciente no-revertido) → 200', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.post(`/api/asociados/sincronizaciones/${sincIdB}/revertir`);
    expect(res.status).toBe(200);
  });

  test('Revertir B por segunda vez → 409 (ya revertido)', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.post(`/api/asociados/sincronizaciones/${sincIdB}/revertir`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/ya fue revertida/i);
  });

  test('Revertir A después de revertir B → 200 (revert encadenado)', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.post(`/api/asociados/sincronizaciones/${sincIdA}/revertir`);
    expect(res.status).toBe(200);
  });
});

// ── Descuentos portal (líneas adicionales del CSV) ───────────────────────────

describe('Asociados — descuentos portal (GET /descuentos)', () => {
  const codigoDesc = '9999888888';
  let passwordDesc;

  const CSV_CON_LINEAS = [
    'linea,codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad,direccion,movil,cuota,periodo_descto',
    `1,${codigoDesc},Desc,Test,1,EMP01,Empresa Test,Pereira,Calle X,3001234567,,`,
    `4,${codigoDesc},Desc,Test,1,EMP01,Empresa Test,Pereira,Calle X,3001234567,15.000,`,
    `5,${codigoDesc},Desc,Test,1,EMP01,Empresa Test,Pereira,Calle X,3001234567,8.000,`,
  ].join('\n');

  const CSV_ACTUALIZADO = [
    'linea,codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad,direccion,movil,cuota,periodo_descto',
    `1,${codigoDesc},Desc,Test,1,EMP01,Empresa Test,Pereira,Calle X,3001234567,,`,
    `4,${codigoDesc},Desc,Test,1,EMP01,Empresa Test,Pereira,Calle X,3001234567,20.000,`,
    `5,${codigoDesc},Desc,Test,1,EMP01,Empresa Test,Pereira,Calle X,3001234567,10.000,`,
  ].join('\n');

  beforeAll(async () => {
    const ag = agent();
    await loginAdmin(ag);
    await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(CSV_CON_LINEAS), 'desc.csv');
    const { body } = await ag.post(`/api/asociados/${codigoDesc}/activar-portal`);
    passwordDesc = body.password;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM asociado_descuentos  WHERE asociado_codigo = $1', [codigoDesc]);
    await pool.query('DELETE FROM sincronizaciones      WHERE usuario_uuid = $1',   [adminUuid]);
    await pool.query('DELETE FROM asociados             WHERE codigo = $1',          [codigoDesc]);
  });

  test('GET /api/asociados/descuentos sin token → 401', async () => {
    const res = await request(app).get('/api/asociados/descuentos');
    expect(res.status).toBe(401);
  });

  test('GET /api/asociados/descuentos autenticado → 200 array con líneas 4 y 5', async () => {
    const ag = agent();
    await ag.post('/api/asociados/login').send({ codigo: codigoDesc, password: passwordDesc });
    const res = await ag.get('/api/asociados/descuentos');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2);

    const linea4 = res.body.find((d) => d.linea_id === 4);
    expect(linea4).toBeDefined();
    expect(linea4.nombre_linea).toBe('SEGURO FAMILIAR');
    expect(Number(linea4.valor)).toBe(15000);

    const linea5 = res.body.find((d) => d.linea_id === 5);
    expect(linea5).toBeDefined();
    expect(linea5.nombre_linea).toBe('SEGURO DE VIDA');
    expect(Number(linea5.valor)).toBe(8000);
  });

  test('Re-sync con valores distintos → filas activas reflejan los nuevos montos', async () => {
    const ag = agent();
    await loginAdmin(ag);
    await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(CSV_ACTUALIZADO), 'desc2.csv');

    // Borrado lógico: filas con valor anterior quedan is_active=false; filtrar por activas
    const { rows } = await pool.query(
      `SELECT linea_id, valor FROM asociado_descuentos
       WHERE asociado_codigo = $1 AND is_active = true
       ORDER BY linea_id`,
      [codigoDesc]
    );
    const l4 = rows.find((r) => r.linea_id === 4);
    const l5 = rows.find((r) => r.linea_id === 5);
    expect(Number(l4.valor)).toBe(20000);
    expect(Number(l5.valor)).toBe(10000);
  });

  test('CSV sin lineas relevantes → datos anteriores permanecen', async () => {
    const csvSoloL1 = [
      'linea,codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad,direccion,movil,cuota,periodo_descto',
      `1,${codigoDesc},Desc,Test,1,EMP01,Empresa Test,Pereira,Calle X,3001234567,,`,
    ].join('\n');
    const ag = agent();
    await loginAdmin(ag);
    await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(csvSoloL1), 'desc3.csv');

    const { rows } = await pool.query(
      'SELECT COUNT(*) AS c FROM asociado_descuentos WHERE asociado_codigo = $1',
      [codigoDesc]
    );
    expect(Number(rows[0].c)).toBeGreaterThan(0);
  });
});

// ── Perfil admin incluye descuentos ──────────────────────────────────────────

describe('Asociados — perfil admin incluye campo descuentos', () => {
  const codigoPerfil = '9999777777';

  const CSV_PERFIL = [
    'linea,codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad,direccion,movil,cuota,periodo_descto',
    `1,${codigoPerfil},Perfil,Test,1,EMP01,Empresa Test,Pereira,Calle Y,3009999999,,`,
    `5,${codigoPerfil},Perfil,Test,1,EMP01,Empresa Test,Pereira,Calle Y,3009999999,12.000,`,
    `1004,${codigoPerfil},Perfil,Test,1,EMP01,Empresa Test,Pereira,Calle Y,3009999999,350.000,`,
  ].join('\n');

  beforeAll(async () => {
    const ag = agent();
    await loginAdmin(ag);
    await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(CSV_PERFIL), 'perfil.csv');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM asociado_descuentos WHERE asociado_codigo = $1', [codigoPerfil]);
    await pool.query('DELETE FROM sincronizaciones      WHERE usuario_uuid = $1',  [adminUuid]);
    await pool.query('DELETE FROM asociados             WHERE codigo = $1',         [codigoPerfil]);
  });

  test('GET /api/asociados/:codigo/perfil sin token → 401', async () => {
    const res = await request(app).get(`/api/asociados/${codigoPerfil}/perfil`);
    expect(res.status).toBe(401);
  });

  test('GET /api/asociados/:codigo/perfil → 200 incluye descuentos array', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get(`/api/asociados/${codigoPerfil}/perfil`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('descuentos');
    expect(Array.isArray(res.body.descuentos)).toBe(true);
    expect(res.body.descuentos.length).toBeGreaterThanOrEqual(2);

    const linea5 = res.body.descuentos.find((d) => d.linea_id === 5);
    expect(linea5).toBeDefined();
    expect(linea5.nombre_linea).toBe('SEGURO DE VIDA');
    expect(Number(linea5.valor)).toBe(12000);

    const linea1004 = res.body.descuentos.find((d) => d.linea_id === 1004);
    expect(linea1004).toBeDefined();
    expect(linea1004.nombre_linea).toBe('CRÉDITO DE VINCULACIÓN');
    expect(Number(linea1004.valor)).toBe(350000);
  });

  test('Cada descuento tiene linea_id, nombre_linea y valor', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const { body } = await ag.get(`/api/asociados/${codigoPerfil}/perfil`);
    body.descuentos.forEach((d) => {
      expect(d).toHaveProperty('linea_id');
      expect(d).toHaveProperty('nombre_linea');
      expect(d).toHaveProperty('valor');
    });
  });
});

// ── registro-portal (autogestión) ────────────────────────────────────────────

describe('Asociados — registro-portal (autogestión)', () => {
  const codigoReg  = '8888111111';
  const emailReg   = 'registro-portal-test@kernel.test';
  const emailReg2  = 'registro-portal-test2@kernel.test';
  const fechaNac   = '1990-06-15';

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO asociados (codigo, apellido, nombre, movil, clase_cuota, fecha_nacimiento)
       VALUES ($1, 'RegTest', 'Portal', '3001111111', '1', $2)
       ON CONFLICT (codigo) DO UPDATE
         SET fecha_nacimiento = EXCLUDED.fecha_nacimiento,
             portal_activo = false, email = NULL, password_hash = NULL,
             solicitud_portal_at = NULL, portal_activado_at = NULL, is_active = true`,
      [codigoReg, fechaNac]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM asociados WHERE codigo = $1', [codigoReg]);
  });

  const reset = () =>
    pool.query(
      `UPDATE asociados SET portal_activo = false, email = NULL, password_hash = NULL,
          solicitud_portal_at = NULL, portal_activado_at = NULL WHERE codigo = $1`,
      [codigoReg]
    );

  describe('Validación Zod', () => {
    test('Body vacío → 400', async () => {
      const res = await request(app).post('/api/asociados/registro-portal').send({});
      expect(res.status).toBe(400);
    });

    test('Email inválido → 400', async () => {
      const res = await request(app).post('/api/asociados/registro-portal').send({
        codigo: codigoReg, fecha_nacimiento: fechaNac, email: 'no-es-un-email',
      });
      expect(res.status).toBe(400);
    });

    test('Fecha con formato incorrecto → 400', async () => {
      const res = await request(app).post('/api/asociados/registro-portal').send({
        codigo: codigoReg, fecha_nacimiento: '15/06/1990', email: emailReg,
      });
      expect(res.status).toBe(400);
    });
  });

  describe('Verificación de identidad', () => {
    test('CC inexistente → 401 (mismo mensaje que fecha incorrecta)', async () => {
      const res = await request(app).post('/api/asociados/registro-portal').send({
        codigo: 'CC_NO_EXISTE', fecha_nacimiento: fechaNac, email: emailReg,
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/no coinciden/i);
    });

    test('CC válida pero fecha incorrecta → 401', async () => {
      const res = await request(app).post('/api/asociados/registro-portal').send({
        codigo: codigoReg, fecha_nacimiento: '1990-06-16', email: emailReg,
      });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/no coinciden/i);
    });

    test('Mensaje de error idéntico para CC inválida y fecha incorrecta (no revela cuál falló)', async () => {
      const r1 = await request(app).post('/api/asociados/registro-portal').send({
        codigo: 'CC_FALSA', fecha_nacimiento: fechaNac, email: emailReg,
      });
      const r2 = await request(app).post('/api/asociados/registro-portal').send({
        codigo: codigoReg, fecha_nacimiento: '2000-01-01', email: emailReg,
      });
      expect(r1.body.error).toBe(r2.body.error);
    });
  });

  describe('Flujo completo', () => {
    test('CC + fecha correctos + email válido → 200 + portal activado en DB', async () => {
      const res = await request(app).post('/api/asociados/registro-portal').send({
        codigo: codigoReg, fecha_nacimiento: fechaNac, email: emailReg,
      });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('ok', true);
      expect(res.body.mensaje).toMatch(/correo/i);

      const { rows: [row] } = await pool.query(
        'SELECT portal_activo, primer_login, email FROM asociados WHERE codigo = $1',
        [codigoReg]
      );
      expect(row.portal_activo).toBe(true);
      expect(row.primer_login).toBe(true);
      expect(row.email).toBe(emailReg);
    });

    test('Asociado activado puede iniciar sesión con las credenciales generadas', async () => {
      // Obtenemos la contraseña reseteándola vía el endpoint admin
      const ag = agent();
      await loginAdmin(ag);
      const { body } = await ag.post(`/api/asociados/${codigoReg}/activar-portal`);
      const password = body.password;

      const res = await request(app)
        .post('/api/asociados/login')
        .send({ codigo: codigoReg, password });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('codigo', codigoReg);
      expect(res.body).toHaveProperty('primer_login', true);
    });
  });

  describe('Casos borde', () => {
    test('Doble registro (portal ya activo) → 409', async () => {
      const res = await request(app).post('/api/asociados/registro-portal').send({
        codigo: codigoReg, fecha_nacimiento: fechaNac, email: emailReg2,
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/ya tiene acceso/i);
    });

    test('Email ya en uso por otro asociado → 409', async () => {
      await reset();
      // Registrar el email en otro asociado de test existente
      await pool.query(
        `UPDATE asociados SET email = $1 WHERE codigo = $2`,
        [emailReg, testCodigo]
      );

      const res = await request(app).post('/api/asociados/registro-portal').send({
        codigo: codigoReg, fecha_nacimiento: fechaNac, email: emailReg,
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/correo ya está registrado/i);

      // Limpiar
      await pool.query(`UPDATE asociados SET email = NULL WHERE codigo = $1`, [testCodigo]);
    });

    test('Asociado inactivo (retirado) → 401', async () => {
      await reset();
      await pool.query(`UPDATE asociados SET is_active = false WHERE codigo = $1`, [codigoReg]);

      const res = await request(app).post('/api/asociados/registro-portal').send({
        codigo: codigoReg, fecha_nacimiento: fechaNac, email: emailReg,
      });
      expect(res.status).toBe(401);

      await pool.query(`UPDATE asociados SET is_active = true WHERE codigo = $1`, [codigoReg]);
    });
  });
});

// ── guardarEmail (PUT /asociados/email) ──────────────────────────────────────

describe('Asociados — guardarEmail (portal autenticado)', () => {
  const codigoEmail = '7777000001';
  const emailA      = 'guardar-email-a@kernel.test';
  const emailB      = 'guardar-email-b@kernel.test';
  let portalAgent;

  beforeAll(async () => {
    const hash = await bcrypt.hash('pass1234', 4);
    await pool.query(
      `INSERT INTO asociados (codigo, apellido, nombre, portal_activo, primer_login, password_hash)
       VALUES ($1, 'Email', 'Test', true, false, $2)
       ON CONFLICT (codigo) DO UPDATE SET portal_activo = true, primer_login = false, password_hash = $2, email = NULL`,
      [codigoEmail, hash]
    );
    // Otro asociado con emailB ya registrado (para probar duplicado)
    await pool.query(
      `INSERT INTO asociados (codigo, apellido, nombre, portal_activo, primer_login, password_hash, email)
       VALUES ($1, 'OtroEmail', 'Test', true, false, $2, $3)
       ON CONFLICT (codigo) DO UPDATE SET email = $3`,
      ['7777000002', hash, emailB]
    );

    portalAgent = request.agent(app);
    await portalAgent.post('/api/asociados/login').send({ codigo: codigoEmail, password: 'pass1234' });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM asociados WHERE codigo IN ($1, $2)', [codigoEmail, '7777000002']);
  });

  test('Sin token de asociado → 401', async () => {
    const res = await request(app).put('/api/asociados/email').send({ email: emailA, emailConfirm: emailA });
    expect(res.status).toBe(401);
  });

  test('Email inválido → 400', async () => {
    const res = await portalAgent.put('/api/asociados/email').send({ email: 'no-es-email', emailConfirm: 'no-es-email' });
    expect(res.status).toBe(400);
  });

  test('Confirmación no coincide → 400', async () => {
    const res = await portalAgent.put('/api/asociados/email').send({ email: emailA, emailConfirm: 'otro@ejemplo.com' });
    expect(res.status).toBe(400);
  });

  test('Email ya registrado en otro asociado → 409', async () => {
    const res = await portalAgent.put('/api/asociados/email').send({ email: emailB, emailConfirm: emailB });
    expect(res.status).toBe(409);
  });

  test('Email válido → 200 y guardado en DB', async () => {
    const res = await portalAgent.put('/api/asociados/email').send({ email: emailA, emailConfirm: emailA });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);

    const { rows: [row] } = await pool.query('SELECT email FROM asociados WHERE codigo = $1', [codigoEmail]);
    expect(row.email).toBe(emailA);
  });

  test('GET /me incluye el campo email', async () => {
    const res = await portalAgent.get('/api/asociados/me');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('email', emailA);
  });
});

// ── Lock de concurrencia ──────────────────────────────────────────────────────

describe('Asociados — lock de concurrencia', () => {
  test('Segundo sync rechazado con 409 si hay uno en curso', async () => {
    const lockClient = await pool.connect();
    try {
      // Simular sync en curso: adquirir el advisory lock en transacción aparte
      await lockClient.query('BEGIN');
      await lockClient.query('SELECT pg_advisory_xact_lock(1750000001)');

      const ag = agent();
      await loginAdmin(ag);
      const res = await ag
        .post('/api/asociados/importar')
        .attach('archivo', Buffer.from(CSV_VALIDO), 'lock.csv');

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/sincronización en curso/i);
    } finally {
      await lockClient.query('ROLLBACK'); // libera el advisory lock
      lockClient.release();
    }
  });
});

// ── Campos extendidos: crédito y fecha_pri_descuento ─────────────────────────

describe('Asociados — campos extendidos: crédito y fecha_pri_descuento', () => {
  const codigoExt = '9998880001';
  let passwordExt;

  // CSV con todas las columnas relevantes: crédito + fecha_pri_descuento
  const CSV_EXT = [
    'linea,codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad,direccion,movil,cuota,periodo_descto,valor_obligacion,saldo,plazo,fecha_vencimiento,fecha_pri_decuento,tasa_interes',
    // fila principal
    `1,${codigoExt},Ext,Campos,1,EMP01,Empresa Test,Pereira,Calle Z,3001234567,,,,,,,01/01/2022,`,
    // línea de crédito 1004 con todos los campos
    `1004,${codigoExt},Ext,Campos,1,EMP01,Empresa Test,Pereira,Calle Z,3001234567,350.000,,5000000,2000000,36,31/12/2026,01/01/2024,15`,
    // línea no-crédito (seguro) con fecha_pri_descuento pero sin campos de crédito
    `4,${codigoExt},Ext,Campos,1,EMP01,Empresa Test,Pereira,Calle Z,3001234567,15.000,,,,,,01/03/2022,`,
  ].join('\n');

  const CSV_REIMPORT = [
    'linea,codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad,direccion,movil,cuota,periodo_descto,valor_obligacion,saldo,plazo,fecha_vencimiento,fecha_pri_decuento,tasa_interes',
    `1,${codigoExt},Ext,Campos,1,EMP01,Empresa Test,Pereira,Calle Z,3001234567,,,,,,,01/01/2022,`,
    // mismo crédito pero saldo actualizado y fecha_pri_descuento distinta
    `1004,${codigoExt},Ext,Campos,1,EMP01,Empresa Test,Pereira,Calle Z,3001234567,350.000,,5000000,1500000,36,31/12/2026,01/06/2024,15`,
    // linea 4 se mantiene para no borrarla con el DELETE-before-insert del upsert
    `4,${codigoExt},Ext,Campos,1,EMP01,Empresa Test,Pereira,Calle Z,3001234567,15.000,,,,,,01/03/2022,`,
  ].join('\n');

  beforeAll(async () => {
    const ag = agent();
    await loginAdmin(ag);
    await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(CSV_EXT), 'ext.csv');
    const { body } = await ag.post(`/api/asociados/${codigoExt}/activar-portal`);
    passwordExt = body.password;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM asociado_descuentos WHERE asociado_codigo = $1', [codigoExt]);
    await pool.query('DELETE FROM sincronizaciones    WHERE usuario_uuid = $1',    [adminUuid]);
    await pool.query('DELETE FROM asociados           WHERE codigo = $1',          [codigoExt]);
  });

  // ── DB directa ──────────────────────────────────────────────────────────────

  describe('DB — almacenamiento en import', () => {
    test('Línea de crédito guarda fecha_pri_descuento', async () => {
      const { rows } = await pool.query(
        `SELECT fecha_pri_descuento FROM asociado_descuentos
         WHERE asociado_codigo = $1 AND linea_id = 1004`,
        [codigoExt]
      );
      expect(rows.length).toBe(1);
      expect(rows[0].fecha_pri_descuento).not.toBeNull();
      expect(String(rows[0].fecha_pri_descuento)).toContain('2024-01-01');
    });

    test('Línea no-crédito guarda fecha_pri_descuento', async () => {
      const { rows } = await pool.query(
        `SELECT fecha_pri_descuento FROM asociado_descuentos
         WHERE asociado_codigo = $1 AND linea_id = 4`,
        [codigoExt]
      );
      expect(rows.length).toBe(1);
      expect(rows[0].fecha_pri_descuento).not.toBeNull();
      expect(String(rows[0].fecha_pri_descuento)).toContain('2022-03-01');
    });

    test('Línea de crédito guarda valor_obligacion, saldo_credito, num_cuotas, fecha_vencimiento, tasa_interes', async () => {
      const { rows } = await pool.query(
        `SELECT valor_obligacion, saldo_credito, num_cuotas, fecha_vencimiento, tasa_interes
         FROM asociado_descuentos WHERE asociado_codigo = $1 AND linea_id = 1004`,
        [codigoExt]
      );
      expect(rows.length).toBe(1);
      const r = rows[0];
      expect(Number(r.valor_obligacion)).toBe(5000000);
      expect(Number(r.saldo_credito)).toBe(2000000);
      expect(r.num_cuotas).toBe(36);
      expect(r.fecha_vencimiento).not.toBeNull();
      expect(Number(r.tasa_interes)).toBe(15);
    });

    test('Línea no-crédito tiene campos de crédito en NULL', async () => {
      const { rows } = await pool.query(
        `SELECT valor_obligacion, saldo_credito, num_cuotas, fecha_vencimiento, tasa_interes
         FROM asociado_descuentos WHERE asociado_codigo = $1 AND linea_id = 4`,
        [codigoExt]
      );
      const r = rows[0];
      expect(r.valor_obligacion).toBeNull();
      expect(r.saldo_credito).toBeNull();
      expect(r.num_cuotas).toBeNull();
      expect(r.fecha_vencimiento).toBeNull();
      expect(r.tasa_interes).toBeNull();
    });

    test('Reimport upsert actualiza saldo_credito y fecha_pri_descuento', async () => {
      const ag = agent();
      await loginAdmin(ag);
      const importRes = await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(CSV_REIMPORT), 'ext2.csv');
      expect(importRes.status).toBe(200);

      // Borrado lógico: la fila anterior queda is_active=false; la nueva es_activa y tiene ultima_vez_en_csv más reciente
      const { rows } = await pool.query(
        `SELECT saldo_credito, fecha_pri_descuento FROM asociado_descuentos
         WHERE asociado_codigo = $1 AND linea_id = 1004
         ORDER BY ultima_vez_en_csv DESC LIMIT 1`,
        [codigoExt]
      );
      expect(Number(rows[0].saldo_credito)).toBe(1500000);
      expect(String(rows[0].fecha_pri_descuento)).toContain('2024-06-01');
    });
  });

  // ── Portal /descuentos ───────────────────────────────────────────────────────

  describe('Portal GET /descuentos — campos extendidos', () => {
    let agPortal;
    beforeAll(async () => {
      agPortal = agent();
      await agPortal.post('/api/asociados/login').send({ codigo: codigoExt, password: passwordExt });
    });

    test('Respuesta incluye fecha_pri_descuento en línea de crédito', async () => {
      const res = await agPortal.get('/api/asociados/descuentos');
      expect(res.status).toBe(200);
      const linea = res.body.find((d) => d.linea_id === 1004);
      expect(linea).toBeDefined();
      expect(linea.fecha_pri_descuento).not.toBeNull();
    });

    test('Respuesta incluye fecha_pri_descuento en línea no-crédito', async () => {
      const res = await agPortal.get('/api/asociados/descuentos');
      const linea = res.body.find((d) => d.linea_id === 4);
      expect(linea).toBeDefined();
      expect(linea.fecha_pri_descuento).not.toBeNull();
    });

    test('Respuesta incluye campos de crédito en línea 1004', async () => {
      const res = await agPortal.get('/api/asociados/descuentos');
      const linea = res.body.find((d) => d.linea_id === 1004);
      expect(linea).toBeDefined();
      expect(Number(linea.valor_obligacion)).toBe(5000000);
      expect(Number(linea.num_cuotas)).toBe(36);
      expect(Number(linea.tasa_interes)).toBe(15);
    });

    test('Línea no-crédito tiene valor_obligacion null en respuesta', async () => {
      const res = await agPortal.get('/api/asociados/descuentos');
      const linea = res.body.find((d) => d.linea_id === 4);
      expect(linea.valor_obligacion).toBeNull();
      expect(linea.saldo_credito).toBeNull();
    });
  });

  // ── Admin /:codigo/perfil descuentos ────────────────────────────────────────

  describe('Admin GET /:codigo/perfil — descuentos con campos extendidos', () => {
    test('Incluye fecha_pri_descuento en línea de crédito', async () => {
      const ag = agent();
      await loginAdmin(ag);
      const res = await ag.get(`/api/asociados/${codigoExt}/perfil`);
      expect(res.status).toBe(200);
      const linea = res.body.descuentos.find((d) => d.linea_id === 1004);
      expect(linea).toBeDefined();
      expect(linea.fecha_pri_descuento).not.toBeNull();
    });

    test('Incluye fecha_pri_descuento en línea no-crédito', async () => {
      const ag = agent();
      await loginAdmin(ag);
      const res = await ag.get(`/api/asociados/${codigoExt}/perfil`);
      const linea = res.body.descuentos.find((d) => d.linea_id === 4);
      expect(linea).toBeDefined();
      expect(linea.fecha_pri_descuento).not.toBeNull();
    });

    test('Incluye campos de crédito en línea 1004', async () => {
      const ag = agent();
      await loginAdmin(ag);
      const res = await ag.get(`/api/asociados/${codigoExt}/perfil`);
      const linea = res.body.descuentos.find((d) => d.linea_id === 1004);
      expect(Number(linea.valor_obligacion)).toBe(5000000);
      expect(Number(linea.num_cuotas)).toBe(36);
      expect(Number(linea.tasa_interes)).toBe(15);
      expect(linea.fecha_vencimiento).not.toBeNull();
    });

    test('Cada descuento incluye los campos: linea_id, nombre_linea, valor, numero, fecha_pri_descuento', async () => {
      const ag = agent();
      await loginAdmin(ag);
      const { body } = await ag.get(`/api/asociados/${codigoExt}/perfil`);
      body.descuentos.forEach((d) => {
        expect(d).toHaveProperty('linea_id');
        expect(d).toHaveProperty('nombre_linea');
        expect(d).toHaveProperty('valor');
        expect(d).toHaveProperty('numero');
        expect(d).toHaveProperty('fecha_pri_descuento');
      });
    });
  });
});

// ── Múltiples créditos por misma línea (numero como clave) ───────────────────

describe('Asociados — múltiples créditos por misma línea (numero)', () => {
  const codigoMulti = '9997770001';

  const CSV_DOS_CREDITOS = [
    'linea,codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad,direccion,movil,cuota,periodo_descto,valor_obligacion,saldo,plazo,fecha_vencimiento,fecha_pri_decuento,tasa_interes,numero',
    `1,${codigoMulti},Multi,Test,1,EMP01,Empresa Test,Pereira,Calle M,3001234567,,,,,,,,,`,
    `1006,${codigoMulti},Multi,Test,1,EMP01,Empresa Test,Pereira,Calle M,3001234567,200.000,,10000000,8000000,60,31/12/2027,01/01/2023,18,CRED-001`,
    `1006,${codigoMulti},Multi,Test,1,EMP01,Empresa Test,Pereira,Calle M,3001234567,150.000,,5000000,3000000,36,30/06/2026,01/06/2024,16,CRED-002`,
  ].join('\n');

  const CSV_REIMPORT_MULTI = [
    'linea,codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad,direccion,movil,cuota,periodo_descto,valor_obligacion,saldo,plazo,fecha_vencimiento,fecha_pri_decuento,tasa_interes,numero',
    `1,${codigoMulti},Multi,Test,1,EMP01,Empresa Test,Pereira,Calle M,3001234567,,,,,,,,,`,
    `1006,${codigoMulti},Multi,Test,1,EMP01,Empresa Test,Pereira,Calle M,3001234567,200.000,,10000000,6000000,60,31/12/2027,01/01/2023,18,CRED-001`,
    `1006,${codigoMulti},Multi,Test,1,EMP01,Empresa Test,Pereira,Calle M,3001234567,150.000,,5000000,3000000,36,30/06/2026,01/06/2024,16,CRED-002`,
  ].join('\n');

  const CSV_NUMERO_DUPLICADO = [
    'linea,codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad,direccion,movil,cuota,periodo_descto,valor_obligacion,saldo,plazo,fecha_vencimiento,fecha_pri_decuento,tasa_interes,numero',
    `1,${codigoMulti},Multi,Test,1,EMP01,Empresa Test,Pereira,Calle M,3001234567,,,,,,,,,`,
    `1006,${codigoMulti},Multi,Test,1,EMP01,Empresa Test,Pereira,Calle M,3001234567,200.000,,10000000,8000000,60,31/12/2027,01/01/2023,18,CRED-DUP`,
    `1006,${codigoMulti},Multi,Test,1,EMP01,Empresa Test,Pereira,Calle M,3001234567,200.000,,10000000,8000000,60,31/12/2027,01/01/2023,18,CRED-DUP`,
  ].join('\n');

  let passwordMulti;

  beforeAll(async () => {
    const ag = agent();
    await loginAdmin(ag);
    await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(CSV_DOS_CREDITOS), 'multi.csv');
    const { body } = await ag.post(`/api/asociados/${codigoMulti}/activar-portal`);
    passwordMulti = body.password;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM asociado_descuentos WHERE asociado_codigo = $1', [codigoMulti]);
    await pool.query('DELETE FROM sincronizaciones    WHERE usuario_uuid = $1',    [adminUuid]);
    await pool.query('DELETE FROM asociados           WHERE codigo = $1',          [codigoMulti]);
  });

  test('CSV con dos créditos 1006 distintos → 2 filas en DB', async () => {
    const { rows } = await pool.query(
      `SELECT numero, saldo_credito FROM asociado_descuentos
       WHERE asociado_codigo = $1 AND linea_id = 1006
       ORDER BY numero`,
      [codigoMulti]
    );
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.numero === 'CRED-001')).toBeDefined();
    expect(rows.find((r) => r.numero === 'CRED-002')).toBeDefined();
    expect(Number(rows.find((r) => r.numero === 'CRED-001').saldo_credito)).toBe(8000000);
    expect(Number(rows.find((r) => r.numero === 'CRED-002').saldo_credito)).toBe(3000000);
  });

  test('GET /api/asociados/descuentos (portal) — devuelve ambos créditos con campo numero', async () => {
    const ag = agent();
    await ag.post('/api/asociados/login').send({ codigo: codigoMulti, password: passwordMulti });
    const res = await ag.get('/api/asociados/descuentos');
    expect(res.status).toBe(200);
    const creditos = res.body.filter((d) => d.linea_id === 1006);
    expect(creditos.length).toBe(2);
    expect(creditos.map((d) => d.numero).sort()).toEqual(['CRED-001', 'CRED-002']);
  });

  test('GET /api/asociados/:codigo/perfil — devuelve ambos créditos con campo numero', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get(`/api/asociados/${codigoMulti}/perfil`);
    expect(res.status).toBe(200);
    const creditos = res.body.descuentos.filter((d) => d.linea_id === 1006);
    expect(creditos.length).toBe(2);
    expect(creditos.map((d) => d.numero).sort()).toEqual(['CRED-001', 'CRED-002']);
  });

  test('Reimport actualiza ambos créditos por separado (DELETE + INSERT por codigo)', async () => {
    const ag = agent();
    await loginAdmin(ag);
    await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(CSV_REIMPORT_MULTI), 'multi2.csv');

    const { rows } = await pool.query(
      `SELECT numero, saldo_credito FROM asociado_descuentos
       WHERE asociado_codigo = $1 AND linea_id = 1006
       ORDER BY numero`,
      [codigoMulti]
    );
    expect(rows.length).toBe(2);
    expect(Number(rows.find((r) => r.numero === 'CRED-001').saldo_credito)).toBe(6000000);
    expect(Number(rows.find((r) => r.numero === 'CRED-002').saldo_credito)).toBe(3000000);
  });

  test('CSV con numero duplicado dentro del mismo lote → solo se guarda una fila', async () => {
    const ag = agent();
    await loginAdmin(ag);
    await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(CSV_NUMERO_DUPLICADO), 'dup.csv');

    const { rows } = await pool.query(
      `SELECT COUNT(*) AS c FROM asociado_descuentos
       WHERE asociado_codigo = $1 AND linea_id = 1006 AND numero = 'CRED-DUP'`,
      [codigoMulti]
    );
    expect(Number(rows[0].c)).toBe(1);
  });
});

// ── GET /:codigo/discrepancias ────────────────────────────────────────────────

describe('Asociados — GET /:codigo/discrepancias', () => {
  const COD_MAL2 = '8881111111'; // MONTO_INCORRECTO
  const COD_SC2  = '8882222222'; // SIN_COBRO_EXTERNO
  const COD_OK2  = '8883333333'; // sin discrepancia
  let sorteoDiscId;
  let initialSyncId; // ID del sync generado en beforeAll — usado por tests que subsanan discrepancias

  const buildCSV = () => [
    'linea,codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad,direccion,movil,cuota,periodo_descto',
    `1,${testCodigo},Torres,Test,1,EMP01,Empresa Test,Pereira,Calle 1,3001234567,,`,
    `1,${COD_MAL2},MontoMal2,Disc,1,EMP_D,Empresa Disc,Bogota,Calle A,3000000001,,`,
    `1,${COD_SC2},SinCobro2,Disc,1,EMP_D,Empresa Disc,Bogota,Calle B,3000000002,,`,
    `1,${COD_OK2},SinDisc,Ok,1,EMP_D,Empresa Disc,Bogota,Calle C,3000000003,,`,
    `15,${COD_MAL2},MontoMal2,Disc,1,EMP_D,Empresa Disc,Bogota,Calle A,3000000001,2.000,1-Mensual`, // cuota incorrecta
    `15,${COD_OK2},SinDisc,Ok,1,EMP_D,Empresa Disc,Bogota,Calle C,3000000003,3.000,1-Mensual`,      // cuota correcta
    // COD_SC2 ausente en línea 15 → SIN_COBRO_EXTERNO
  ].join('\n');

  beforeAll(async () => {
    // Limpiar stale data de ejecuciones anteriores
    await pool.query(`DELETE FROM cobros_efectivo WHERE asociado_codigo = ANY($1)`, [[COD_MAL2, COD_SC2, COD_OK2]]);
    // Eliminar sorteos con linea='15' de corridas anteriores para garantizar sorteo_id correcto en el sync
    await pool.query(`DELETE FROM boletos WHERE sorteo_id IN (SELECT id FROM sorteos WHERE linea_reconciliacion = '15')`);
    await pool.query(`DELETE FROM sorteo_logs WHERE sorteo_id IN (SELECT id FROM sorteos WHERE linea_reconciliacion = '15')`);
    await pool.query(`DELETE FROM sorteos WHERE linea_reconciliacion = '15'`);

    const { rows: [s] } = await pool.query(
      `INSERT INTO sorteos (nombre, estado, precio_boleto, linea_reconciliacion)
       VALUES ('Sorteo Disc Test', 'activo', 3000, '15')
       RETURNING id`
    );
    sorteoDiscId = s.id;

    for (const [codigo, apellido] of [[COD_MAL2, 'MontoMal2'], [COD_SC2, 'SinCobro2'], [COD_OK2, 'SinDisc']]) {
      await pool.query(
        `INSERT INTO asociados (codigo, apellido, nombre, clase_cuota, empresa_dsto, nombre_empresa, ciudad)
         VALUES ($1, $2, 'Disc', '1', 'EMP_D', 'Empresa Disc', 'Bogota')
         ON CONFLICT (codigo) DO UPDATE SET is_active = true`,
        [codigo, apellido]
      );
    }

    // Boletos: COD_MAL2 (951) con cuota incorrecta, COD_SC2 (952) sin cobro externo
    for (const [numero, codigo] of [[951, COD_MAL2], [952, COD_SC2]]) {
      await pool.query(
        `INSERT INTO boletos (numero, sorteo_id, asociado_codigo, estado, fecha_asignacion)
         VALUES ($1, $2, $3, 'asignado', NOW())
         ON CONFLICT (numero, sorteo_id) DO UPDATE SET estado = 'asignado', asociado_codigo = $3`,
        [numero, sorteoDiscId, codigo]
      );
    }

    // Importar para generar las discrepancias en sincronizaciones.detalle
    const ag = request.agent(app);
    await loginAdmin(ag);
    await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(buildCSV()), 'disc.csv');
    const { rows: [s2] } = await pool.query(
      `SELECT id FROM sincronizaciones WHERE usuario_uuid = $1 ORDER BY created_at DESC LIMIT 1`,
      [adminUuid]
    );
    initialSyncId = s2.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM cobros_efectivo WHERE asociado_codigo = ANY($1)', [[COD_MAL2, COD_SC2, COD_OK2]]);
    await pool.query('DELETE FROM sorteo_logs    WHERE sorteo_id = $1',      [sorteoDiscId]);
    await pool.query('DELETE FROM boletos        WHERE sorteo_id = $1',      [sorteoDiscId]);
    await pool.query('DELETE FROM sorteos        WHERE id = $1',             [sorteoDiscId]);
    await pool.query('DELETE FROM asociados      WHERE codigo = ANY($1)',    [[COD_MAL2, COD_SC2, COD_OK2]]);
    await pool.query('DELETE FROM empresas       WHERE codigo = $1',         ['EMP_D']);
    await pool.query('DELETE FROM sincronizaciones WHERE usuario_uuid = $1', [adminUuid]);
  });

  test('GET sin token → 401', async () => {
    const res = await request(app).get(`/api/asociados/${COD_MAL2}/discrepancias`);
    expect(res.status).toBe(401);
  });

  test('Asociado con MONTO_INCORRECTO → devuelve la discrepancia', async () => {
    const ag = request.agent(app);
    await loginAdmin(ag);
    const res = await ag.get(`/api/asociados/${COD_MAL2}/discrepancias`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const d = res.body[0];
    expect(d.tipo).toBe('MONTO_INCORRECTO');
    expect(d.codigo).toBe(COD_MAL2);
    expect(d).toHaveProperty('cuota_externa');
    expect(d).toHaveProperty('cuota_kernel');
    expect(d).toHaveProperty('diferencia');
    expect(d).toHaveProperty('sync_id');
    expect(d).toHaveProperty('sync_fecha');
  });

  test('Asociado con SIN_COBRO_EXTERNO → devuelve la discrepancia', async () => {
    const ag = request.agent(app);
    await loginAdmin(ag);
    const res = await ag.get(`/api/asociados/${COD_SC2}/discrepancias`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    const d = res.body[0];
    expect(d.tipo).toBe('SIN_COBRO_EXTERNO');
    expect(d.codigo).toBe(COD_SC2);
    expect(d).toHaveProperty('cuota_kernel');
    expect(d).toHaveProperty('boletos_count');
  });

  test('Asociado sin discrepancias → array vacío', async () => {
    const ag = request.agent(app);
    await loginAdmin(ag);
    const res = await ag.get(`/api/asociados/${COD_OK2}/discrepancias`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  test('No devuelve COBRO_A_RETIRADO ni COBRO_SIN_BOLETO', async () => {
    const ag = request.agent(app);
    await loginAdmin(ag);
    // COD_MAL2 solo tiene MONTO_INCORRECTO
    const res = await ag.get(`/api/asociados/${COD_MAL2}/discrepancias`);
    expect(res.status).toBe(200);
    const tipos = res.body.map((d) => d.tipo);
    expect(tipos).not.toContain('COBRO_A_RETIRADO');
    expect(tipos).not.toContain('COBRO_SIN_BOLETO');
  });

  test('Asociado inexistente → array vacío (sin error)', async () => {
    const ag = request.agent(app);
    await loginAdmin(ag);
    const res = await ag.get('/api/asociados/0000000000/discrepancias');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('Registrar pago crea entrada en sorteo_logs con accion PAGO_EFECTIVO', async () => {
    const ag = request.agent(app);
    await loginAdmin(ag);
    const pagoRes = await ag
      .post(`/api/asociados/sincronizaciones/${initialSyncId}/subsanar/${COD_SC2}/pago`)
      .send({ tipo_discrepancia: 'SIN_COBRO_EXTERNO', numero_bono: 952, monto: 3000, tipo_pago: 'banco', comprobante: 'LOG-SC2-001', comentario: 'Test log sorteo' });
    expect(pagoRes.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT accion, numero, asociado_codigo, detalle
       FROM sorteo_logs
       WHERE sorteo_id = $1 AND accion = 'PAGO_EFECTIVO'
       ORDER BY created_at DESC LIMIT 1`,
      [sorteoDiscId]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].numero).toBe(952);
    expect(rows[0].asociado_codigo).toBe(COD_SC2);
    expect(rows[0].detalle).toContain('LOG-SC2-001');
    // Limpiar
    await pool.query(`DELETE FROM sorteo_logs WHERE sorteo_id = $1 AND accion = 'PAGO_EFECTIVO'`, [sorteoDiscId]);
    await pool.query(`DELETE FROM cobros_efectivo WHERE asociado_codigo = $1`, [COD_SC2]);
    await pool.query(`DELETE FROM admin_logs WHERE objetivo_id = $1 AND accion = 'PAGO_EFECTIVO_DISCREPANCIA'`, [COD_SC2]);
  });

  test('cobros_efectivo: discrepancia persiste visible como SUBSANADO — no desaparece del audit', async () => {
    // El pago en efectivo ya no suprime la discrepancia; la persona sigue apareciendo
    // en el audit como SIN_COBRO_EXTERNO con pagos_efectivo, mostrando SUBSANADO en la UI.
    // Esto evita que queden invisible cuando desaparecen del CSV por haber pagado en caja.
    const periodoActual = (() => {
      const d = new Date(); d.setMonth(d.getMonth() - 1);
      return d.toISOString().slice(0, 7);
    })();
    // Consultar el mismo sorteoIdLinea que usaría el sync para línea '15'
    const { rows: [sorteoLinea] } = await pool.query(
      `SELECT id FROM sorteos WHERE linea_reconciliacion = '15' AND estado = 'activo' AND precio_boleto > 0 ORDER BY created_at LIMIT 1`
    );
    const sorteoIdLinea = sorteoLinea?.id ?? sorteoDiscId;
    // Insertar pago manual para COD_SC2
    await pool.query(
      `INSERT INTO cobros_efectivo
         (asociado_codigo, sorteo_id, numero_bono, monto, tipo_pago, comprobante, tipo_discrepancia, periodo, registrado_por_uuid)
       VALUES ($1, $2, 952, 3000, 'banco', 'TEST-SUP-001', 'SIN_COBRO_EXTERNO', $3, $4)`,
      [COD_SC2, sorteoIdLinea, periodoActual, adminUuid]
    );
    // Verificar que el cobros_efectivo se insertó correctamente
    const { rows: cobrosCheck } = await pool.query(
      `SELECT asociado_codigo, sorteo_id FROM cobros_efectivo WHERE periodo = $1 AND asociado_codigo = $2`,
      [periodoActual, COD_SC2]
    );
    // Correr un nuevo sync — COD_SC2 sigue sin aparecer en línea 15 del CSV
    const ag = request.agent(app);
    await loginAdmin(ag);
    await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(buildCSV()), 'sup.csv');
    // La discrepancia SIN_COBRO_EXTERNO DEBE aparecer (visible en audit como SUBSANADO)
    const res = await ag.get(`/api/asociados/${COD_SC2}/discrepancias`);
    expect(cobrosCheck.length).toBeGreaterThan(0);
    expect(cobrosCheck[0].asociado_codigo).toBe(COD_SC2);
    expect(cobrosCheck[0].sorteo_id).toBe(sorteoIdLinea);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Aparece como SIN_COBRO_EXTERNO (visible en audit), no suprimido
    expect(res.body.some((d) => d.tipo === 'SIN_COBRO_EXTERNO')).toBe(true);
    // Limpiar
    await pool.query(`DELETE FROM cobros_efectivo WHERE asociado_codigo = $1 AND periodo = $2`, [COD_SC2, periodoActual]);
  });

  test('sorteo tipo_pago=unico: cobros_efectivo aparece como SUBSANADO aunque desaparezca del CSV', async () => {
    // Igual que recurrente: la discrepancia se genera pero visible como SUBSANADO en audit
    await pool.query(`UPDATE sorteos SET tipo_pago = 'unico' WHERE id = $1`, [sorteoDiscId]);
    const periodoAnterior = (() => {
      const d = new Date(); d.setMonth(d.getMonth() - 1);
      return d.toISOString().slice(0, 7);
    })();
    await pool.query(
      `INSERT INTO cobros_efectivo
         (asociado_codigo, sorteo_id, numero_bono, monto, tipo_pago, comprobante, tipo_discrepancia, periodo, registrado_por_uuid)
       VALUES ($1, $2, 952, 3000, 'banco', 'TEST-UNICO-001', 'SIN_COBRO_EXTERNO', $3, $4)`,
      [COD_SC2, sorteoDiscId, periodoAnterior, adminUuid]
    );
    const ag = request.agent(app);
    await loginAdmin(ag);
    await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(buildCSV()), 'unico.csv');
    const res = await ag.get(`/api/asociados/${COD_SC2}/discrepancias`);
    expect(res.status).toBe(200);
    // Aparece como SIN_COBRO_EXTERNO (visible en audit como SUBSANADO via pagos_efectivo)
    expect(res.body.some((d) => d.tipo === 'SIN_COBRO_EXTERNO')).toBe(true);
    // Limpiar
    await pool.query(`DELETE FROM cobros_efectivo WHERE asociado_codigo = $1 AND comprobante = 'TEST-UNICO-001'`, [COD_SC2]);
    await pool.query(`UPDATE sorteos SET tipo_pago = 'recurrente' WHERE id = $1`, [sorteoDiscId]);
  });

  test('Solo muestra discrepancias del sync más reciente — sync posterior limpio oculta las anteriores', async () => {
    // Importar un CSV sin línea 15 después del sync que generó discrepancias.
    // El sync más reciente queda sin discrepancias para COD_MAL2 → perfil devuelve [].
    const ag = request.agent(app);
    await loginAdmin(ag);
    const csvLimpio = [
      'linea,codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad,direccion,movil,cuota,periodo_descto',
      `1,${testCodigo},Torres,Test,1,EMP01,Empresa Test,Pereira,Calle 1,3001234567,,`,
      `1,${COD_MAL2},MontoMal2,Disc,1,EMP_D,Empresa Disc,Bogota,Calle A,3000000001,,`,
      `1,${COD_SC2},SinCobro2,Disc,1,EMP_D,Empresa Disc,Bogota,Calle B,3000000002,,`,
      `1,${COD_OK2},SinDisc,Ok,1,EMP_D,Empresa Disc,Bogota,Calle C,3000000003,,`,
      // Sin línea 15 → reconciliación genera discrepancias = []
    ].join('\n');
    await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(csvLimpio), 'limpio.csv');

    const res = await ag.get(`/api/asociados/${COD_MAL2}/discrepancias`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ── Fase 1: Historial de descuentos generado por sync ────────────────────────

describe('Asociados — Fase 1: historial descuentos generado por sync CSV', () => {
  // Usa créditos (con numero) para que el key codigo:numero sea determinístico
  const codigoHist = '9996660001';

  // V1: crédito CRED-H01 (valor=200000, saldo=8000000) + seguro línea 4 (no tiene numero)
  const CSV_HIST_V1 = [
    'linea,codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad,direccion,movil,cuota,periodo_descto,valor_obligacion,saldo,plazo,fecha_vencimiento,fecha_pri_decuento,tasa_interes,numero',
    `1,${codigoHist},Hist,Test,1,EMP01,Empresa Test,Pereira,Calle H,3001234567,,,,,,,,,`,
    `1006,${codigoHist},Hist,Test,1,EMP01,Empresa Test,Pereira,Calle H,3001234567,200.000,,10000000,8000000,60,31/12/2027,01/01/2023,18,CRED-H01`,
  ].join('\n');

  // V2: mismo crédito CRED-H01 sin cambios → no debe generar historial
  const CSV_HIST_V2 = [
    'linea,codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad,direccion,movil,cuota,periodo_descto,valor_obligacion,saldo,plazo,fecha_vencimiento,fecha_pri_decuento,tasa_interes,numero',
    `1,${codigoHist},Hist,Test,1,EMP01,Empresa Test,Pereira,Calle H,3001234567,,,,,,,,,`,
    `1006,${codigoHist},Hist,Test,1,EMP01,Empresa Test,Pereira,Calle H,3001234567,200.000,,10000000,8000000,60,31/12/2027,01/01/2023,18,CRED-H01`,
  ].join('\n');

  // V3: saldo_credito cambia 8000000 → 6000000
  const CSV_HIST_V3 = [
    'linea,codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad,direccion,movil,cuota,periodo_descto,valor_obligacion,saldo,plazo,fecha_vencimiento,fecha_pri_decuento,tasa_interes,numero',
    `1,${codigoHist},Hist,Test,1,EMP01,Empresa Test,Pereira,Calle H,3001234567,,,,,,,,,`,
    `1006,${codigoHist},Hist,Test,1,EMP01,Empresa Test,Pereira,Calle H,3001234567,200.000,,10000000,6000000,60,31/12/2027,01/01/2023,18,CRED-H01`,
  ].join('\n');

  // V4: CRED-H01 desaparece del CSV pero hay otra línea de descuento (línea 4)
  // para que el bloque descuentos se ejecute y aplique el borrado lógico
  const CSV_HIST_V4 = [
    'linea,codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad,direccion,movil,cuota,periodo_descto,valor_obligacion,saldo,plazo,fecha_vencimiento,fecha_pri_decuento,tasa_interes,numero',
    `1,${codigoHist},Hist,Test,1,EMP01,Empresa Test,Pereira,Calle H,3001234567,,,,,,,,,`,
    `4,${codigoHist},Hist,Test,1,EMP01,Empresa Test,Pereira,Calle H,3001234567,15.000,,,,,,,,`,
  ].join('\n');

  let syncId1, syncId2, syncId3, syncId4;

  beforeAll(async () => {
    await pool.query('DELETE FROM asociado_descuentos_historial WHERE asociado_codigo = $1', [codigoHist]);
    await pool.query('DELETE FROM asociado_descuentos            WHERE asociado_codigo = $1', [codigoHist]);
    await pool.query('DELETE FROM asociados                      WHERE codigo = $1',           [codigoHist]);

    const ag = agent();
    await loginAdmin(ag);

    const r1 = await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(CSV_HIST_V1), 'histv1.csv');
    syncId1 = r1.body.sync_id;

    const r2 = await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(CSV_HIST_V2), 'histv2.csv');
    syncId2 = r2.body.sync_id;

    const r3 = await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(CSV_HIST_V3), 'histv3.csv');
    syncId3 = r3.body.sync_id;

    const r4 = await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(CSV_HIST_V4), 'histv4.csv');
    syncId4 = r4.body.sync_id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM asociado_descuentos_historial WHERE asociado_codigo = $1', [codigoHist]);
    await pool.query('DELETE FROM asociado_descuentos            WHERE asociado_codigo = $1', [codigoHist]);
    await pool.query('DELETE FROM sincronizaciones               WHERE usuario_uuid = $1',    [adminUuid]);
    await pool.query('DELETE FROM asociados                      WHERE codigo = $1',           [codigoHist]);
  });

  test('Primera sync — registra aparición de CRED-H01 con valor_anterior=null', async () => {
    const { rows } = await pool.query(
      `SELECT campo, valor_anterior, valor_nuevo, sync_id
       FROM asociado_descuentos_historial
       WHERE asociado_codigo = $1 AND linea_id = 1006 AND numero = 'CRED-H01' AND sync_id = $2
       ORDER BY campo`,
      [codigoHist, syncId1]
    );
    expect(rows.length).toBeGreaterThan(0);
    const entradaValor = rows.find((r) => r.campo === 'valor');
    expect(entradaValor).toBeDefined();
    expect(entradaValor.valor_anterior).toBeNull();
    expect(Number(entradaValor.valor_nuevo)).toBe(200000);
  });

  test('Primera sync — registra saldo_credito inicial con valor_anterior=null', async () => {
    const { rows } = await pool.query(
      `SELECT campo, valor_anterior, valor_nuevo
       FROM asociado_descuentos_historial
       WHERE asociado_codigo = $1 AND linea_id = 1006 AND numero = 'CRED-H01' AND sync_id = $2`,
      [codigoHist, syncId1]
    );
    const entradaSaldo = rows.find((r) => r.campo === 'saldo_credito');
    expect(entradaSaldo).toBeDefined();
    expect(entradaSaldo.valor_anterior).toBeNull();
    expect(Number(entradaSaldo.valor_nuevo)).toBe(8000000);
  });

  test('Primera sync — sync_id en historial coincide con el sync retornado', async () => {
    const { rows } = await pool.query(
      `SELECT sync_id FROM asociado_descuentos_historial
       WHERE asociado_codigo = $1 AND sync_id = $2
       LIMIT 1`,
      [codigoHist, syncId1]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].sync_id).toBe(syncId1);
  });

  test('Segunda sync sin cambios — no genera entradas de historial para CRED-H01', async () => {
    const { rows } = await pool.query(
      `SELECT id FROM asociado_descuentos_historial
       WHERE asociado_codigo = $1 AND linea_id = 1006 AND numero = 'CRED-H01' AND sync_id = $2`,
      [codigoHist, syncId2]
    );
    expect(rows.length).toBe(0);
  });

  test('Tercera sync — registra cambio de saldo_credito 8000000→6000000', async () => {
    const { rows } = await pool.query(
      `SELECT campo, valor_anterior, valor_nuevo
       FROM asociado_descuentos_historial
       WHERE asociado_codigo = $1 AND linea_id = 1006 AND numero = 'CRED-H01' AND sync_id = $2`,
      [codigoHist, syncId3]
    );
    expect(rows.length).toBeGreaterThan(0);
    const entradaSaldo = rows.find((r) => r.campo === 'saldo_credito');
    expect(entradaSaldo).toBeDefined();
    expect(Number(entradaSaldo.valor_anterior)).toBe(8000000);
    expect(Number(entradaSaldo.valor_nuevo)).toBe(6000000);
  });

  test('Tercera sync — campos sin cambio no generan entradas (valor sigue en 200000)', async () => {
    const { rows } = await pool.query(
      `SELECT campo FROM asociado_descuentos_historial
       WHERE asociado_codigo = $1 AND linea_id = 1006 AND numero = 'CRED-H01' AND sync_id = $2`,
      [codigoHist, syncId3]
    );
    const camposRegistrados = rows.map((r) => r.campo);
    expect(camposRegistrados).not.toContain('valor'); // valor no cambió
    expect(camposRegistrados).not.toContain('tasa_interes'); // tampoco
  });

  test('Cuarta sync — CRED-H01 desaparece → historial registra is_active 1→0', async () => {
    const { rows } = await pool.query(
      `SELECT campo, valor_anterior, valor_nuevo
       FROM asociado_descuentos_historial
       WHERE asociado_codigo = $1 AND linea_id = 1006 AND sync_id = $2`,
      [codigoHist, syncId4]
    );
    const entradaActiva = rows.find((r) => r.campo === 'is_active');
    expect(entradaActiva).toBeDefined();
    expect(Number(entradaActiva.valor_anterior)).toBe(1);
    expect(Number(entradaActiva.valor_nuevo)).toBe(0);
  });

  test('Borrado lógico — is_active=false en asociado_descuentos tras desaparición', async () => {
    const { rows } = await pool.query(
      `SELECT is_active FROM asociado_descuentos
       WHERE asociado_codigo = $1 AND linea_id = 1006 AND numero = 'CRED-H01'`,
      [codigoHist]
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // Al menos una fila debe estar inactiva (la desaparecida)
    expect(rows.some((r) => r.is_active === false)).toBe(true);
  });

  test('Historial enlaza a distintos sync_id a lo largo de las 4 sincronizaciones', async () => {
    const { rows } = await pool.query(
      `SELECT DISTINCT sync_id FROM asociado_descuentos_historial
       WHERE asociado_codigo = $1`,
      [codigoHist]
    );
    const ids = rows.map((r) => r.sync_id);
    // sync1 y sync3 generaron entradas; sync2 no (sin cambios); sync4 generó is_active
    expect(ids).toContain(syncId1);
    expect(ids).toContain(syncId3);
    expect(ids).toContain(syncId4);
    expect(ids).not.toContain(syncId2);
  });
});

// ── Fase 2: GET /:codigo/historial-descuentos ─────────────────────────────────

describe('Asociados — Fase 2: GET /:codigo/historial-descuentos', () => {
  const codigoHist2 = '9996660002';

  const CSV_HIST2 = [
    'linea,codigo,apellido,nombre,clase_cuota,empresa_dsto,nombre_empresa,ciudad,direccion,movil,cuota,periodo_descto,valor_obligacion,saldo,plazo,fecha_vencimiento,fecha_pri_decuento,tasa_interes,numero',
    `1,${codigoHist2},Hist2,Test,1,EMP01,Empresa Test,Pereira,Calle H2,3001234568,,,,,,,,,`,
    `1006,${codigoHist2},Hist2,Test,1,EMP01,Empresa Test,Pereira,Calle H2,3001234568,150.000,,5000000,3000000,36,30/06/2026,01/06/2024,16,CRED-H02`,
  ].join('\n');

  beforeAll(async () => {
    await pool.query('DELETE FROM asociado_descuentos_historial WHERE asociado_codigo = $1', [codigoHist2]);
    await pool.query('DELETE FROM asociado_descuentos            WHERE asociado_codigo = $1', [codigoHist2]);
    await pool.query('DELETE FROM asociados                      WHERE codigo = $1',           [codigoHist2]);

    const ag = agent();
    await loginAdmin(ag);
    await ag.post('/api/asociados/importar').attach('archivo', Buffer.from(CSV_HIST2), 'hist2_ep.csv');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM asociado_descuentos_historial WHERE asociado_codigo = $1', [codigoHist2]);
    await pool.query('DELETE FROM asociado_descuentos            WHERE asociado_codigo = $1', [codigoHist2]);
    await pool.query('DELETE FROM sincronizaciones               WHERE usuario_uuid = $1',    [adminUuid]);
    await pool.query('DELETE FROM asociados                      WHERE codigo = $1',           [codigoHist2]);
  });

  test('GET sin token → 401', async () => {
    const res = await request(app).get(`/api/asociados/${codigoHist2}/historial-descuentos`);
    expect(res.status).toBe(401);
  });

  test('GET autenticado → 200 array con entradas', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get(`/api/asociados/${codigoHist2}/historial-descuentos`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test('Cada entrada tiene la estructura correcta', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const { body } = await ag.get(`/api/asociados/${codigoHist2}/historial-descuentos`);
    expect(body.length).toBeGreaterThan(0);
    const entry = body[0];
    expect(entry).toHaveProperty('linea_id');
    expect(entry).toHaveProperty('nombre_linea');
    expect(entry).toHaveProperty('numero');
    expect(entry).toHaveProperty('campo');
    expect(entry).toHaveProperty('valor_anterior');
    expect(entry).toHaveProperty('valor_nuevo');
    expect(entry).toHaveProperty('changed_at');
    expect(entry).toHaveProperty('sync_id');
  });

  test('Línea 1006/CRED-H02 aparece con nombre_linea y valor_anterior=null', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const { body } = await ag.get(`/api/asociados/${codigoHist2}/historial-descuentos`);
    const entrada = body.find((h) => h.linea_id === 1006 && h.numero === 'CRED-H02' && h.campo === 'valor');
    expect(entrada).toBeDefined();
    expect(entrada.nombre_linea).toBeTruthy();
    expect(entrada.valor_anterior).toBeNull();
    expect(Number(entrada.valor_nuevo)).toBe(150000);
  });

  test('sync_id es UUID válido', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const { body } = await ag.get(`/api/asociados/${codigoHist2}/historial-descuentos`);
    const entry = body[0];
    expect(entry.sync_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  test('Resultados ordenados por changed_at DESC', async () => {
    const ag = agent();
    await loginAdmin(ag);
    const { body } = await ag.get(`/api/asociados/${codigoHist2}/historial-descuentos`);
    if (body.length > 1) {
      for (let i = 0; i < body.length - 1; i++) {
        expect(new Date(body[i].changed_at).getTime()).toBeGreaterThanOrEqual(
          new Date(body[i + 1].changed_at).getTime()
        );
      }
    }
  });

  test('Asociado sin historial → 200 array vacío', async () => {
    await pool.query(
      `INSERT INTO asociados (codigo, apellido, nombre, clase_cuota)
       VALUES ('0000000099', 'Sin', 'Historial', '1')
       ON CONFLICT (codigo) DO NOTHING`
    );
    const ag = agent();
    await loginAdmin(ag);
    const res = await ag.get('/api/asociados/0000000099/historial-descuentos');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
    await pool.query(`DELETE FROM asociados WHERE codigo = '0000000099'`);
  });
});
