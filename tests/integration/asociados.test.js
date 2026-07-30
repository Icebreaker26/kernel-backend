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
    // Sorteo activo con precio_boleto = 3000
    const { rows: [s] } = await pool.query(
      `INSERT INTO sorteos (nombre, estado, precio_boleto)
       VALUES ('Sorteo Recon Test', 'activo', 3000)
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
  test('CSV sin línea 15 → discrepancias es null', async () => {
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
    expect(res.body.discrepancias).toBeNull();
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
