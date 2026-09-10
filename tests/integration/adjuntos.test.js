import { jest } from '@jest/globals';

jest.setTimeout(30000);

// Mocks ANTES de cualquier import que cargue el SDK de AWS
jest.unstable_mockModule('@aws-sdk/client-s3', () => ({
  S3Client:            jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
  PutObjectCommand:    jest.fn().mockImplementation((p) => p),
  GetObjectCommand:    jest.fn().mockImplementation((p) => p),
  DeleteObjectCommand: jest.fn().mockImplementation((p) => p),
}));

jest.unstable_mockModule('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.test.example.com/mock-presigned-url'),
}));

// Imports dinámicos después de configurar los mocks
const { createApp } = await import('../../src/createApp.js');
const { default: pool }     = await import('../../src/db/database.js');
const { default: request }  = await import('supertest');
const { default: bcrypt }   = await import('bcrypt');
const { getSignedUrl }      = await import('@aws-sdk/s3-request-presigner');

// ── Usuarios ──────────────────────────────────────────────────────────────────
const EMAIL_CTB  = 'adjuntos-ctb-test@kernel.test';
const EMAIL_OTRO = 'adjuntos-otro-test@kernel.test';
const PASS = 'testpass123';

let app;
let uuidCtb, uuidOtro;
let proveedorId, facturaId, facturaNoEditableId;

// ── Setup ─────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(PASS, 4);

  // Limpieza de datos de corridas previas que no completaron afterAll
  await pool.query(`DELETE FROM archivos WHERE s3_key LIKE 'kernel/facturas/%' AND nombre IN ('doc.pdf', 'factura-sept-2026.pdf')`);
  await pool.query(`DELETE FROM tesoreria_facturas WHERE proveedor_id IN (SELECT id FROM tesoreria_proveedores WHERE nombre = 'Proveedor Adjuntos Test')`);

  // Usuario con permiso contable
  const { rows: [ctb] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Contable Adjuntos Test', $1, $2, 'contable', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL_CTB, hash]
  );
  uuidCtb = ctb.id;
  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a
     WHERE m.nombre = 'contable' AND a.nombre IN ('READ', 'WRITE')
     ON CONFLICT DO NOTHING`,
    [uuidCtb]
  );

  // Usuario sin permisos
  const { rows: [otro] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Otro Adjuntos Test', $1, $2, 'juridico', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL_OTRO, hash]
  );
  uuidOtro = otro.id;

  // Proveedor
  const { rows: [p] } = await pool.query(
    `INSERT INTO tesoreria_proveedores (nombre, tipo_pago) VALUES ('Proveedor Adjuntos Test', 'unico') RETURNING id`
  );
  proveedorId = p.id;

  // Factura en estado editable (pendiente_aprobacion)
  const { rows: [f] } = await pool.query(
    `INSERT INTO tesoreria_facturas (proveedor_id, monto, fecha_recibida, fecha_vencimiento, estado, registrado_por)
     VALUES ($1, 500000, '2026-09-01', '2026-09-30', 'pendiente_aprobacion', $2)
     RETURNING id`,
    [proveedorId, uuidCtb]
  );
  facturaId = f.id;

  // Factura en estado NO editable (verificada) con adjunto en tabla archivos
  const { rows: [f2] } = await pool.query(
    `INSERT INTO tesoreria_facturas (proveedor_id, monto, fecha_recibida, fecha_vencimiento, estado, registrado_por)
     VALUES ($1, 200000, '2026-09-01', '2026-09-30', 'verificada', $2)
     RETURNING id`,
    [proveedorId, uuidCtb]
  );
  facturaNoEditableId = f2.id;
  await pool.query(
    `INSERT INTO archivos (entidad_tipo, entidad_id, s3_key, nombre, mime_type, size_bytes, subido_por)
     VALUES ('factura', $1, 'kernel/facturas/test-uuid/doc.pdf', 'doc.pdf', 'application/pdf', 102400, $2)`,
    [facturaNoEditableId, uuidCtb]
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM archivos WHERE entidad_tipo = 'factura' AND entidad_id IN
    (SELECT id FROM tesoreria_facturas WHERE proveedor_id = $1)`, [proveedorId]);
  await pool.query('DELETE FROM tesoreria_facturas  WHERE proveedor_id = $1', [proveedorId]);
  await pool.query('DELETE FROM tesoreria_proveedores WHERE nombre = $1',     ['Proveedor Adjuntos Test']);
  await pool.query('DELETE FROM permisos WHERE usuario_uuid = $1',            [uuidCtb]);
  await pool.query('DELETE FROM global_usuarios WHERE email = ANY($1)',        [[EMAIL_CTB, EMAIL_OTRO]]);
  await pool.end();
});

// Helper: sesión autenticada
const loginAs = async (email) => {
  const ag = request.agent(app);
  await ag.post('/api/auth/login').send({ email, password: PASS });
  return ag;
};

// ── Auth (sin token) ──────────────────────────────────────────────────────────
describe('Auth — 401 sin token', () => {
  const endpoints = [
    { method: 'post',   path: () => `/api/contable/facturas/${facturaId}/adjunto` },
    { method: 'patch',  path: () => `/api/contable/facturas/${facturaId}/adjunto` },
    { method: 'get',    path: () => `/api/contable/facturas/${facturaId}/adjunto` },
    { method: 'delete', path: () => `/api/contable/facturas/${facturaId}/adjunto` },
  ];
  test.each(endpoints)('$method $path retorna 401', async ({ method, path }) => {
    const res = await request(app)[method](path());
    expect(res.status).toBe(401);
  });
});

// ── Permisos (usuario sin permiso contable) ───────────────────────────────────
describe('Permisos — 403 sin permiso contable', () => {
  let agOtro;
  beforeAll(async () => { agOtro = await loginAs(EMAIL_OTRO); });

  test('POST solicitar upload retorna 403', async () => {
    const res = await agOtro.post(`/api/contable/facturas/${facturaId}/adjunto`)
      .send({ nombre: 'test.pdf', mime: 'application/pdf', size: 1024 });
    expect(res.status).toBe(403);
  });
  test('GET descargar retorna 403', async () => {
    const res = await agOtro.get(`/api/contable/facturas/${facturaId}/adjunto`);
    expect(res.status).toBe(403);
  });
});

// ── POST /facturas/:id/adjunto — solicitar upload ─────────────────────────────
describe('POST /adjunto — solicitar presigned URL', () => {
  let agCtb;
  beforeAll(async () => { agCtb = await loginAs(EMAIL_CTB); });

  test('Factura inexistente retorna 404', async () => {
    const res = await agCtb.post('/api/contable/facturas/00000000-0000-0000-0000-000000000000/adjunto')
      .send({ nombre: 'test.pdf', mime: 'application/pdf', size: 1024 });
    expect(res.status).toBe(404);
  });

  test('MIME no permitido retorna 400', async () => {
    const res = await agCtb.post(`/api/contable/facturas/${facturaId}/adjunto`)
      .send({ nombre: 'virus.exe', mime: 'application/x-msdownload', size: 1024 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no permitido/i);
  });

  test('Archivo mayor a 15 MB retorna 400', async () => {
    const res = await agCtb.post(`/api/contable/facturas/${facturaId}/adjunto`)
      .send({ nombre: 'grande.pdf', mime: 'application/pdf', size: 16 * 1024 * 1024 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/15 MB/i);
  });

  test('Body incompleto retorna 400', async () => {
    const res = await agCtb.post(`/api/contable/facturas/${facturaId}/adjunto`)
      .send({ nombre: 'test.pdf' }); // falta mime y size
    expect(res.status).toBe(400);
  });

  test('Solicitud válida retorna uploadUrl y key', async () => {
    getSignedUrl.mockResolvedValueOnce('https://s3.test/upload-url');
    const res = await agCtb.post(`/api/contable/facturas/${facturaId}/adjunto`)
      .send({ nombre: 'factura-sept.pdf', mime: 'application/pdf', size: 204800 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('uploadUrl');
    expect(res.body).toHaveProperty('key');
    expect(res.body.key).toMatch(new RegExp(`^kernel/facturas/${facturaId}/`));
    expect(res.body.key).toMatch(/\.pdf$/);
  });

  test('Soporta imagen PNG', async () => {
    const res = await agCtb.post(`/api/contable/facturas/${facturaId}/adjunto`)
      .send({ nombre: 'soporte.png', mime: 'image/png', size: 512000 });
    expect(res.status).toBe(200);
    expect(res.body.key).toMatch(/\.png$/);
  });
});

// ── PATCH /facturas/:id/adjunto — confirmar upload ────────────────────────────
describe('PATCH /adjunto — confirmar upload y guardar en DB', () => {
  let agCtb;
  beforeAll(async () => { agCtb = await loginAs(EMAIL_CTB); });

  test('Key que no pertenece a la factura retorna 400', async () => {
    const res = await agCtb.patch(`/api/contable/facturas/${facturaId}/adjunto`)
      .send({ key: 'kernel/facturas/otro-uuid/doc.pdf', nombre: 'doc.pdf', mime: 'application/pdf', size: 1024 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/key inválida/i);
  });

  test('Body incompleto retorna 400', async () => {
    const res = await agCtb.patch(`/api/contable/facturas/${facturaId}/adjunto`)
      .send({ key: `kernel/facturas/${facturaId}/uuid.pdf` }); // falta nombre
    expect(res.status).toBe(400);
  });

  test('Confirma upload y guarda key en la base de datos', async () => {
    const key    = `kernel/facturas/${facturaId}/abc123.pdf`;
    const nombre = 'factura-sept-2026.pdf';
    const mime   = 'application/pdf';
    const size   = 204800;

    const res = await agCtb.patch(`/api/contable/facturas/${facturaId}/adjunto`)
      .send({ key, nombre, mime, size });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verificar que se guardó en la tabla archivos
    const { rows } = await pool.query(
      `SELECT s3_key, nombre, mime_type, size_bytes FROM archivos
       WHERE entidad_tipo = 'factura' AND entidad_id = $1 AND s3_key = $2`,
      [facturaId, key]
    );
    expect(rows[0].s3_key).toBe(key);
    expect(rows[0].nombre).toBe(nombre);
    expect(rows[0].mime_type).toBe(mime);
    expect(rows[0].size_bytes).toBe(size);
  });
});

// ── GET /facturas/:id/adjunto — descargar ─────────────────────────────────────
describe('GET /adjunto — obtener presigned URL de descarga', () => {
  let agCtb;
  beforeAll(async () => { agCtb = await loginAs(EMAIL_CTB); });

  test('Factura sin adjunto retorna 404', async () => {
    // Crear factura sin adjunto para este test
    const { rows: [f] } = await pool.query(
      `INSERT INTO tesoreria_facturas (proveedor_id, monto, fecha_recibida, fecha_vencimiento, estado, registrado_por)
       VALUES ($1, 100000, '2026-09-01', '2026-09-30', 'pendiente_aprobacion', $2) RETURNING id`,
      [proveedorId, uuidCtb]
    );
    const res = await agCtb.get(`/api/contable/facturas/${f.id}/adjunto`);
    expect(res.status).toBe(404);
    await pool.query('DELETE FROM tesoreria_facturas WHERE id=$1', [f.id]);
  });

  test('Factura con adjunto retorna url y metadata', async () => {
    getSignedUrl.mockResolvedValueOnce('https://s3.test/download-url');
    // facturaId ya tiene adjunto del PATCH anterior
    const res = await agCtb.get(`/api/contable/facturas/${facturaId}/adjunto`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('url');
    expect(res.body).toHaveProperty('nombre');
    expect(res.body).toHaveProperty('mime');
    expect(res.body.url).toBe('https://s3.test/download-url');
  });
});

// ── DELETE /facturas/:id/adjunto — eliminar ───────────────────────────────────
describe('DELETE /adjunto — eliminar adjunto', () => {
  let agCtb;
  beforeAll(async () => { agCtb = await loginAs(EMAIL_CTB); });

  test('Factura sin adjunto retorna 404', async () => {
    const { rows: [f] } = await pool.query(
      `INSERT INTO tesoreria_facturas (proveedor_id, monto, fecha_recibida, fecha_vencimiento, estado, registrado_por)
       VALUES ($1, 100000, '2026-09-01', '2026-09-30', 'pendiente_aprobacion', $2) RETURNING id`,
      [proveedorId, uuidCtb]
    );
    const res = await agCtb.delete(`/api/contable/facturas/${f.id}/adjunto`);
    expect(res.status).toBe(404);
    await pool.query('DELETE FROM tesoreria_facturas WHERE id=$1', [f.id]);
  });

  test('Factura en estado no editable (verificada) retorna 409', async () => {
    const res = await agCtb.delete(`/api/contable/facturas/${facturaNoEditableId}/adjunto`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/no se puede eliminar/i);
  });

  test('Elimina adjunto y limpia columnas en DB', async () => {
    // facturaId tiene adjunto (del PATCH anterior)
    const res = await agCtb.delete(`/api/contable/facturas/${facturaId}/adjunto`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verificar que el archivo fue eliminado de la tabla archivos
    const { rows } = await pool.query(
      `SELECT id FROM archivos WHERE entidad_tipo = 'factura' AND entidad_id = $1`,
      [facturaId]
    );
    expect(rows.length).toBe(0);
  });
});
