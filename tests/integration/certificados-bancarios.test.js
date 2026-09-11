import { jest } from '@jest/globals';

jest.setTimeout(30000);

// Mock de S3 ANTES de cualquier import que cargue el SDK de AWS
jest.unstable_mockModule('@aws-sdk/client-s3', () => ({
  S3Client:            jest.fn().mockImplementation(() => ({ send: jest.fn().mockResolvedValue({}) })),
  PutObjectCommand:    jest.fn().mockImplementation((p) => p),
  GetObjectCommand:    jest.fn().mockImplementation((p) => p),
  DeleteObjectCommand: jest.fn().mockImplementation((p) => p),
}));

jest.unstable_mockModule('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.test.example.com/mock-certificado-url'),
}));

// Imports dinámicos después del mock
const { createApp } = await import('../../src/createApp.js');
const { default: pool }    = await import('../../src/db/database.js');
const { default: request } = await import('supertest');
const { default: bcrypt }  = await import('bcrypt');

const EMAIL_CTB = 'cert-ctb-test@kernel.test';
const EMAIL_CI  = 'cert-ci-test@kernel.test';
const PASS = 'testpass123';

let app;
let uuidCtb, uuidCi;
let proveedorId, solicitudId;

const agCtb = () => request.agent(app);
const agCi  = () => request.agent(app);
const loginCtb = (ag) => ag.post('/api/auth/login').send({ email: EMAIL_CTB, password: PASS });
const loginCi  = (ag) => ag.post('/api/auth/login').send({ email: EMAIL_CI,  password: PASS });

const DATOS_BANCARIOS = {
  banco:          'Bancolombia',
  tipo_cuenta:    'ahorros',
  numero_cuenta:  '456-789012-00',
  titular_cuenta: 'Empresa Cert Test S.A.S.',
};

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(PASS, 4);

  const { rows: [ctb] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Contable Cert Test', $1, $2, 'contable', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL_CTB, hash]
  );
  uuidCtb = ctb.id;
  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'contable'
     ON CONFLICT DO NOTHING`,
    [uuidCtb]
  );

  const { rows: [ci] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('CI Cert Test', $1, $2, 'control_interno', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true
     RETURNING id`,
    [EMAIL_CI, hash]
  );
  uuidCi = ci.id;
  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'control_interno'
     ON CONFLICT DO NOTHING`,
    [uuidCi]
  );

  // Proveedor + solicitud de datos bancarios (INSERT directo para simplicidad)
  const { rows: [p] } = await pool.query(
    `INSERT INTO tesoreria_proveedores (nombre, tipo_pago)
     VALUES ('Proveedor Cert Test', 'unico') RETURNING id`
  );
  proveedorId = p.id;

  const { rows: [s] } = await pool.query(
    `INSERT INTO tesoreria_proveedores_datos_bancarios
       (proveedor_id, banco, tipo_cuenta, numero_cuenta, titular_cuenta, solicitado_por)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [proveedorId, DATOS_BANCARIOS.banco, DATOS_BANCARIOS.tipo_cuenta,
     DATOS_BANCARIOS.numero_cuenta, DATOS_BANCARIOS.titular_cuenta, uuidCtb]
  );
  solicitudId = s.id;

  await pool.query(
    `UPDATE tesoreria_proveedores SET datos_bancarios_estado = 'pendiente_ci' WHERE id = $1`,
    [proveedorId]
  );
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM archivos WHERE entidad_tipo = 'certificado_bancario' AND entidad_id = $1`,
    [solicitudId]
  );
  await pool.query(
    `DELETE FROM tesoreria_proveedores_datos_bancarios WHERE proveedor_id = $1`,
    [proveedorId]
  );
  await pool.query(`DELETE FROM tesoreria_proveedores WHERE id = $1`, [proveedorId]);
  await pool.query(`DELETE FROM permisos WHERE usuario_uuid IN ($1, $2)`, [uuidCtb, uuidCi]);
  await pool.query(`DELETE FROM global_usuarios WHERE id IN ($1, $2)`, [uuidCtb, uuidCi]);
  await pool.end();
});

// ── Auth ───────────────────────────────────────────────────────────────────────
describe('Auth', () => {
  test('POST certificado sin token → 401', async () => {
    const res = await request(app)
      .post(`/api/contable/proveedores/${proveedorId}/datos-bancarios/${solicitudId}/certificado`)
      .send({ nombre: 'cert.pdf', mime: 'application/pdf', size: 12345 });
    expect(res.status).toBe(401);
  });

  test('PATCH confirmar certificado sin token → 401', async () => {
    const res = await request(app)
      .patch(`/api/contable/proveedores/${proveedorId}/datos-bancarios/${solicitudId}/certificado`)
      .send({ key: `kernel/certificado_bancarios/${solicitudId}/test.pdf`, nombre: 'cert.pdf' });
    expect(res.status).toBe(401);
  });

  test('GET certificado CI sin token → 401', async () => {
    const res = await request(app)
      .get(`/api/control_interno/datos-bancarios/${solicitudId}/certificado`);
    expect(res.status).toBe(401);
  });

  test('GET certificado contable (por proveedor) sin token → 401', async () => {
    const res = await request(app)
      .get(`/api/contable/proveedores/${proveedorId}/certificado`);
    expect(res.status).toBe(401);
  });
});

// ── Permisos cruzados ──────────────────────────────────────────────────────────
describe('Permisos cruzados', () => {
  test('CI no puede solicitar upload de certificado (sin permiso contable) → 403', async () => {
    const ag = agCi(); await loginCi(ag);
    const res = await ag
      .post(`/api/contable/proveedores/${proveedorId}/datos-bancarios/${solicitudId}/certificado`)
      .send({ nombre: 'cert.pdf', mime: 'application/pdf', size: 12345 });
    expect(res.status).toBe(403);
  });

  test('Contable no puede ver lista de solicitudes CI → 403', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag.get('/api/control_interno/datos-bancarios');
    expect(res.status).toBe(403);
  });
});

// ── GET sin adjunto ────────────────────────────────────────────────────────────
describe('GET certificado — solicitud sin adjunto', () => {
  test('CI: solicitud sin certificado → 404', async () => {
    const ag = agCi(); await loginCi(ag);
    const res = await ag.get(`/api/control_interno/datos-bancarios/${solicitudId}/certificado`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/sin certificado/i);
  });

  test('Contable: proveedor sin certificados → 404', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag.get(`/api/contable/proveedores/${proveedorId}/certificado`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/sin certificado/i);
  });
});

// ── Validaciones POST solicitar upload ─────────────────────────────────────────
describe('POST solicitar upload de certificado — validaciones', () => {
  test('body vacío → 400', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag
      .post(`/api/contable/proveedores/${proveedorId}/datos-bancarios/${solicitudId}/certificado`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/faltan/i);
  });

  test('mime no permitido (text/plain) → 400', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag
      .post(`/api/contable/proveedores/${proveedorId}/datos-bancarios/${solicitudId}/certificado`)
      .send({ nombre: 'doc.txt', mime: 'text/plain', size: 1024 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tipo/i);
  });

  test('size excesivo (> 15 MB) → 400', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag
      .post(`/api/contable/proveedores/${proveedorId}/datos-bancarios/${solicitudId}/certificado`)
      .send({ nombre: 'cert.pdf', mime: 'application/pdf', size: 16 * 1024 * 1024 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/l[íi]mite/i);
  });

  test('solicitud inexistente → 404', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag
      .post(`/api/contable/proveedores/${proveedorId}/datos-bancarios/00000000-0000-0000-0000-000000000000/certificado`)
      .send({ nombre: 'cert.pdf', mime: 'application/pdf', size: 25000 });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/solicitud/i);
  });
});

// ── Validaciones PATCH confirmar upload ───────────────────────────────────────
describe('PATCH confirmar upload de certificado — validaciones', () => {
  test('body vacío → 400', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag
      .patch(`/api/contable/proveedores/${proveedorId}/datos-bancarios/${solicitudId}/certificado`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/faltan/i);
  });

  test('key con prefijo incorrecto → 400', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag
      .patch(`/api/contable/proveedores/${proveedorId}/datos-bancarios/${solicitudId}/certificado`)
      .send({
        key:    'kernel/facturas/wrong-prefix/cert.pdf',
        nombre: 'cert.pdf',
        mime:   'application/pdf',
        size:   25000,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/key/i);
  });
});

// ── Flujo completo: solicitar → confirmar → ver ────────────────────────────────
describe('Flujo completo de certificado bancario', () => {
  let uploadKey;

  test('POST solicitar upload → 200 con uploadUrl y key correcta', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag
      .post(`/api/contable/proveedores/${proveedorId}/datos-bancarios/${solicitudId}/certificado`)
      .send({ nombre: 'certificado-bancario.pdf', mime: 'application/pdf', size: 25000 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('uploadUrl');
    expect(res.body).toHaveProperty('key');
    expect(res.body.key).toMatch(
      new RegExp(`^kernel/certificado_bancarios/${solicitudId}/`)
    );
    expect(res.body.uploadUrl).toBe('https://s3.test.example.com/mock-certificado-url');
    uploadKey = res.body.key;
  });

  test('PATCH confirmar upload con key válida → 200 { ok: true }', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag
      .patch(`/api/contable/proveedores/${proveedorId}/datos-bancarios/${solicitudId}/certificado`)
      .send({
        key:    uploadKey,
        nombre: 'certificado-bancario.pdf',
        mime:   'application/pdf',
        size:   25000,
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('GET CI /datos-bancarios/:id/certificado → 200 con url (S3 mock)', async () => {
    const ag = agCi(); await loginCi(ag);
    const res = await ag.get(`/api/control_interno/datos-bancarios/${solicitudId}/certificado`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('url');
    expect(res.body).toHaveProperty('nombre');
    expect(res.body.url).toBe('https://s3.test.example.com/mock-certificado-url');
    expect(res.body.nombre).toBe('certificado-bancario.pdf');
  });

  test('GET contable /proveedores/:id/certificado → 200 con url (S3 mock)', async () => {
    const ag = agCtb(); await loginCtb(ag);
    const res = await ag.get(`/api/contable/proveedores/${proveedorId}/certificado`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('url');
    expect(res.body).toHaveProperty('nombre');
    expect(res.body.url).toBe('https://s3.test.example.com/mock-certificado-url');
  });

  test('Archivo queda registrado en la tabla archivos con entidad_tipo correcto', async () => {
    const { rows } = await pool.query(
      `SELECT * FROM archivos WHERE entidad_tipo = 'certificado_bancario' AND entidad_id = $1`,
      [solicitudId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].nombre).toBe('certificado-bancario.pdf');
    expect(rows[0].mime_type).toBe('application/pdf');
    expect(rows[0].subido_por).toBe(uuidCtb);
  });
});
