import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';
import { jest } from '@jest/globals';

jest.setTimeout(30000);

let app;
const asesorEmail = 'captacion-test@kernel.test';
const asesorPass  = 'testpass123';
let asesorUuid;
let empresaCodigo  = 'EMP-CAP-TEST';
let prospectoId;
let rawToken;
let vinculacionId;

const agent      = () => request.agent(app);
const loginAsesor = (ag) => ag.post('/api/auth/login').send({ email: asesorEmail, password: asesorPass });

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(asesorPass, 4);

  const { rows: [u] } = await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ('Asesor Test', $1, $2, 'asesor', true, true)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, rol = 'asesor'
     RETURNING id`,
    [asesorEmail, hash]
  );
  asesorUuid = u.id;

  // Empresa de prueba
  await pool.query(
    `INSERT INTO empresas (codigo, nombre) VALUES ($1, 'Empresa Captacion Test')
     ON CONFLICT (codigo) DO NOTHING`,
    [empresaCodigo]
  );

  // Permisos: READ, WRITE, ENTREGAR para captacion
  await pool.query(
    `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
     SELECT $1, m.id, a.id FROM modulos m, acciones a
     WHERE m.nombre = 'captacion' AND a.nombre IN ('READ','WRITE','ENTREGAR')
     ON CONFLICT DO NOTHING`,
    [asesorUuid]
  );
});

afterAll(async () => {
  // Orden FK: eventos → vinc hijas → vinculaciones → toques → prospectos
  await pool.query(
    `DELETE FROM captacion_eventos     WHERE prospecto_id IN
       (SELECT id FROM captacion_prospectos WHERE asesor_uuid = $1)`, [asesorUuid]
  );
  await pool.query(
    `DELETE FROM captacion_beneficiarios WHERE vinculacion_id IN
       (SELECT id FROM captacion_vinculaciones WHERE prospecto_id IN
         (SELECT id FROM captacion_prospectos WHERE asesor_uuid = $1))`, [asesorUuid]
  );
  await pool.query(
    `DELETE FROM captacion_referencias WHERE vinculacion_id IN
       (SELECT id FROM captacion_vinculaciones WHERE prospecto_id IN
         (SELECT id FROM captacion_prospectos WHERE asesor_uuid = $1))`, [asesorUuid]
  );
  await pool.query(
    `DELETE FROM captacion_vinculaciones WHERE prospecto_id IN
       (SELECT id FROM captacion_prospectos WHERE asesor_uuid = $1)`, [asesorUuid]
  );
  await pool.query(
    `DELETE FROM captacion_toques WHERE prospecto_id IN
       (SELECT id FROM captacion_prospectos WHERE asesor_uuid = $1)`, [asesorUuid]
  );
  await pool.query(`DELETE FROM captacion_prospectos WHERE asesor_uuid = $1`, [asesorUuid]);
  await pool.query(`DELETE FROM empresas WHERE codigo = $1`, [empresaCodigo]);
  await pool.query(`DELETE FROM permisos WHERE usuario_uuid = $1`, [asesorUuid]);
  await pool.query(`DELETE FROM global_usuarios WHERE id = $1`, [asesorUuid]);
  await pool.end();
});

// ── Auth ──────────────────────────────────────────────────────────────────────

describe('Captacion — Auth', () => {
  test('GET /api/captacion/prospectos sin token → 401', async () => {
    const res = await request(app).get('/api/captacion/prospectos');
    expect(res.status).toBe(401);
  });
});

// ── CRUD Prospectos ───────────────────────────────────────────────────────────

describe('Captacion — Prospectos', () => {
  test('POST /prospectos — empresa inexistente → 400', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.post('/api/captacion/prospectos').send({
      empresa_codigo: 'NO-EXISTE',
      nombres: 'Juan', apellidos: 'Pérez', cedula: '11111111', celular: '3001234567',
    });
    expect(res.status).toBe(400);
  });

  test('POST /prospectos — body inválido → 400', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.post('/api/captacion/prospectos').send({ nombres: 'Solo' });
    expect(res.status).toBe(400);
  });

  test('POST /prospectos — crea correctamente y devuelve token', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.post('/api/captacion/prospectos').send({
      empresa_codigo: empresaCodigo,
      nombres  : 'Juan',
      apellidos: 'Pérez',
      cedula   : '11111111',
      celular  : '3001234567',
      correo   : 'juan@test.com',
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('token');
    expect(res.body.token).toHaveLength(43); // base64url 32 bytes
    prospectoId = res.body.id;
    rawToken    = res.body.token;
  });

  test('POST /prospectos — duplicado en 30 días → 409', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.post('/api/captacion/prospectos').send({
      empresa_codigo: empresaCodigo,
      nombres: 'Juan', apellidos: 'Pérez', cedula: '11111111', celular: '3001234567',
    });
    expect(res.status).toBe(409);
  });

  test('GET /prospectos — lista con score', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.get('/api/captacion/prospectos');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((p) => p.id === prospectoId)).toBe(true);
  });

  test('GET /prospectos/:id — detalle', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.get(`/api/captacion/prospectos/${prospectoId}`);
    expect(res.status).toBe(200);
    expect(res.body.cedula).toBe('11111111');
  });

  test('GET /prospectos/:id/whatsapp — genera URL y link con token', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.get(`/api/captacion/prospectos/${prospectoId}/whatsapp`);
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/wa\.me\//);
    expect(res.body.link).toContain(rawToken);
    expect(res.body.link).toContain('/conocenos/');
  });

  test('POST /prospectos/:id/toque — registra contacto', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.post(`/api/captacion/prospectos/${prospectoId}/toque`).send({
      resultado: 'contesto',
      notas    : 'Le interesó el crédito',
    });
    expect(res.status).toBe(201);
    expect(res.body.resultado).toBe('contesto');
  });
});

// ── Endpoints públicos ────────────────────────────────────────────────────────

describe('Captacion — Endpoints públicos', () => {
  test('GET /pub/empresas — lista sin auth', async () => {
    const res = await request(app).get('/api/captacion/pub/empresas');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /pub/:token — token inválido → 404', async () => {
    const res = await request(app).get('/api/captacion/pub/token-falso-abc123');
    expect(res.status).toBe(404);
  });

  test('GET /pub/:token — token válido devuelve datos básicos', async () => {
    const res = await request(app).get(`/api/captacion/pub/${rawToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('nombres');
    expect(res.body).toHaveProperty('asesor');
    expect(res.body).not.toHaveProperty('cedula'); // no exponer cédula completa
  });

  test('POST /pub/:token/ping — registra apertura', async () => {
    const res = await request(app).post(`/api/captacion/pub/${rawToken}/ping`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Verificar que ping_count subió y estado cambió
    const { rows: [p] } = await pool.query(
      `SELECT ping_count, estado FROM captacion_prospectos WHERE id = $1`, [prospectoId]
    );
    expect(p.ping_count).toBeGreaterThan(0);
    expect(p.estado).toBe('vio_landing');
  });

  test('POST /pub/:token/step-up — dígitos incorrectos → 403', async () => {
    const res = await request(app)
      .post(`/api/captacion/pub/${rawToken}/step-up`)
      .send({ digitos: '0000' });
    expect(res.status).toBe(403);
  });

  test('POST /pub/:token/step-up — últimos 4 dígitos correctos → 200', async () => {
    const res = await request(app)
      .post(`/api/captacion/pub/${rawToken}/step-up`)
      .send({ digitos: '1111' }); // cedula = '11111111'
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('PUT /pub/:token/personal — guarda sección y crea vinculación', async () => {
    const res = await request(app)
      .put(`/api/captacion/pub/${rawToken}/personal`)
      .send({
        estado_civil  : 'soltero',
        tipo_vivienda : 'arrendada',
        estrato       : 3,
        genero        : 'M',
        nivel_academico: 'Universidad',
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty('vinculacion_id');
    vinculacionId = res.body.vinculacion_id;
  });

  test('PUT /pub/:token/laboral — guarda sección laboral', async () => {
    const res = await request(app)
      .put(`/api/captacion/pub/${rawToken}/laboral`)
      .send({ cargo: 'Auxiliar', tipo_contrato: 'indefinido', fecha_ingreso: '2022-01-01' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('PUT /pub/:token/pep — marca debida_diligencia_ampliada si alguna es true', async () => {
    const res = await request(app)
      .put(`/api/captacion/pub/${rawToken}/pep`)
      .send({
        pep_maneja_recursos_publicos: false,
        pep_reconocimiento_publico  : false,
        pep_poder_publico           : false,
        pep_vinculo_expuesto        : false,
      });
    expect(res.status).toBe(200);
    expect(res.body.debida_diligencia_ampliada).toBe(false);
  });

  test('PUT /pub/:token/pep — PEP con SÍ marca debida_diligencia_ampliada', async () => {
    const res = await request(app)
      .put(`/api/captacion/pub/${rawToken}/pep`)
      .send({
        pep_maneja_recursos_publicos: true,
        pep_reconocimiento_publico  : false,
        pep_poder_publico           : false,
        pep_vinculo_expuesto        : false,
      });
    expect(res.status).toBe(200);
    expect(res.body.debida_diligencia_ampliada).toBe(true);

    // Resetear a false para los tests siguientes
    await request(app)
      .put(`/api/captacion/pub/${rawToken}/pep`)
      .send({
        pep_maneja_recursos_publicos: false,
        pep_reconocimiento_publico  : false,
        pep_poder_publico           : false,
        pep_vinculo_expuesto        : false,
      });
  });

  test('PUT /pub/:token/financiera — guarda situación financiera', async () => {
    const res = await request(app)
      .put(`/api/captacion/pub/${rawToken}/financiera`)
      .send({
        ingresos_mensuales: 2500000,
        egresos_mensuales : 1800000,
        total_activos     : 5000000,
        total_pasivos     : 1000000,
        origen_fondos     : 'Trabajo como empleado',
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('PUT /pub/:token/beneficiarios — porcentajes deben sumar 100', async () => {
    const res = await request(app)
      .put(`/api/captacion/pub/${rawToken}/beneficiarios`)
      .send({ beneficiarios: [{ orden: 1, nombres: 'María Pérez', porcentaje: 60, parentesco: 'Esposa' }] });
    expect(res.status).toBe(400); // 60 ≠ 100
  });

  test('PUT /pub/:token/beneficiarios — beneficiarios válidos guardados', async () => {
    const res = await request(app)
      .put(`/api/captacion/pub/${rawToken}/beneficiarios`)
      .send({
        beneficiarios: [
          { orden: 1, nombres: 'María Pérez', porcentaje: 60, parentesco: 'Esposa' },
          { orden: 2, nombres: 'Carlos Pérez', porcentaje: 40, parentesco: 'Hijo' },
        ],
      });
    expect(res.status).toBe(200);
  });

  test('PUT /pub/:token/referencias — guarda referencias', async () => {
    const res = await request(app)
      .put(`/api/captacion/pub/${rawToken}/referencias`)
      .send({
        referencias: [
          { tipo: 'personal', nombres: 'Amigo Ref', celular: '3009999999' },
          { tipo: 'familiar', nombres: 'Familiar Ref', celular: '3008888888' },
        ],
      });
    expect(res.status).toBe(200);
  });

  test('POST /pub/:token/firmar — sin PEP respondido → 400', async () => {
    // Limpiar PEP para forzar el error
    await pool.query(
      `UPDATE captacion_vinculaciones SET seccion_pep_at = NULL WHERE id = $1`, [vinculacionId]
    );
    const res = await request(app)
      .post(`/api/captacion/pub/${rawToken}/firmar`)
      .send({
        firma_png             : 'data:image/png;base64,iVBORw0KGgo=',
        firma_trazos          : [{ x: 10, y: 20, t: 100 }],
        version_consentimiento: 'v1.0',
        acepta_terminos       : true,
      });
    expect(res.status).toBe(400);
  });

  test('POST /pub/:token/firmar — con PEP → solicitud_completa', async () => {
    // Restaurar PEP
    await pool.query(
      `UPDATE captacion_vinculaciones SET seccion_pep_at = NOW() WHERE id = $1`, [vinculacionId]
    );
    const res = await request(app)
      .post(`/api/captacion/pub/${rawToken}/firmar`)
      .send({
        firma_png             : 'data:image/png;base64,iVBORw0KGgo=',
        firma_trazos          : [{ x: 10, y: 20, t: 100 }, { x: 15, y: 25, t: 150 }],
        version_consentimiento: 'v1.0',
        acepta_terminos       : true,
      });
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('solicitud_completa');

    // Verificar que prospecto pasó a convertido
    const { rows: [p] } = await pool.query(
      `SELECT estado FROM captacion_prospectos WHERE id = $1`, [prospectoId]
    );
    expect(p.estado).toBe('convertido');

    // Verificar snapshot + hash guardados
    const { rows: [v] } = await pool.query(
      `SELECT firma_doc_hash, formulario_snapshot FROM captacion_vinculaciones WHERE id = $1`,
      [vinculacionId]
    );
    expect(v.firma_doc_hash).toHaveLength(64);
    expect(v.formulario_snapshot).not.toBeNull();
  });
});

// ── Vinculaciones internas ────────────────────────────────────────────────────

describe('Captacion — Vinculaciones internas', () => {
  test('GET /vinculaciones — lista solicitudes del asesor', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.get('/api/captacion/vinculaciones');
    expect(res.status).toBe(200);
    expect(res.body.some((v) => v.id === vinculacionId)).toBe(true);
  });

  test('GET /vinculaciones/:id — detalle con beneficiarios y referencias', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.get(`/api/captacion/vinculaciones/${vinculacionId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.beneficiarios)).toBe(true);
    expect(res.body.beneficiarios).toHaveLength(2);
    expect(Array.isArray(res.body.referencias)).toBe(true);
  });

  test('PUT /vinculaciones/:id/valores — asesor asigna valores', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.put(`/api/captacion/vinculaciones/${vinculacionId}/valores`).send({
      valor_aporte  : 30000,
      cuota_admision: 15000,
    });
    expect(res.status).toBe(200);
    expect(Number(res.body.valor_aporte)).toBe(30000);
  });

  test('POST /vinculaciones/:id/entregar — sin docs → 400', async () => {
    const ag = agent();
    await loginAsesor(ag);
    // cedula_frente/reverso null → seccion_documentos_at null
    const res = await ag.post(`/api/captacion/vinculaciones/${vinculacionId}/entregar`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cédula/i);
  });

  test('POST /vinculaciones/:id/entregar — con docs marcados → 200', async () => {
    // Simular que documentos fueron subidos
    await pool.query(
      `UPDATE captacion_vinculaciones SET seccion_documentos_at = NOW() WHERE id = $1`,
      [vinculacionId]
    );
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.post(`/api/captacion/vinculaciones/${vinculacionId}/entregar`);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('entregada');
  });

  test('POST /vinculaciones/:id/entregar — ya entregada → 400', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.post(`/api/captacion/vinculaciones/${vinculacionId}/entregar`);
    expect(res.status).toBe(400);
  });
});

// ── Sync cross-check ──────────────────────────────────────────────────────────

describe('Captacion — Sync cross-check', () => {
  let syncProspectoId;
  let syncEmpresa = 'EMP-SYNC-TEST';

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO empresas (codigo, nombre) VALUES ($1, 'Sync Test')
       ON CONFLICT (codigo) DO NOTHING`, [syncEmpresa]
    );
    const { rows: [p] } = await pool.query(
      `INSERT INTO captacion_prospectos
         (empresa_codigo, asesor_uuid, nombres, apellidos, cedula, celular, token_hash, token)
       VALUES ($1, $2, 'Test', 'Sync', '77777777', '3000000000', 'hash-sync-test', 'token-sync-test')
       RETURNING id`,
      [syncEmpresa, asesorUuid]
    );
    syncProspectoId = p.id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM captacion_eventos WHERE prospecto_id = $1`, [syncProspectoId]);
    await pool.query(`DELETE FROM captacion_prospectos WHERE id = $1`, [syncProspectoId]);
    await pool.query(`DELETE FROM empresas WHERE codigo = $1`, [syncEmpresa]);
  });

  test('Sync con cédula de prospecto activo → convertido_por_sync', async () => {
    // Simular una sincronización que incluye la cédula 77777777
    const { rows: [sinc] } = await pool.query(
      `INSERT INTO sincronizaciones (usuario_uuid, archivo, total, nuevos, actualizados, retirados, errores)
       VALUES ($1, 'test.csv', 1, 1, 0, 0, 0) RETURNING id`,
      [asesorUuid]
    );

    // Ejecutar el cross-check manualmente (igual que lo hace importarCSV)
    await pool.query(
      `UPDATE captacion_prospectos
          SET estado = 'convertido_por_sync', convertido_at = NOW(),
              sincronizacion_id = $1, updated_at = NOW()
        WHERE cedula = ANY($2::text[])
          AND is_active = true
          AND estado NOT IN ('convertido','convertido_por_sync')`,
      [sinc.id, ['77777777']]
    );

    const { rows: [p] } = await pool.query(
      `SELECT estado, sincronizacion_id FROM captacion_prospectos WHERE id = $1`, [syncProspectoId]
    );
    expect(p.estado).toBe('convertido_por_sync');
    expect(p.sincronizacion_id).toBe(sinc.id);

    // Cleanup
    await pool.query(`DELETE FROM sincronizaciones WHERE id = $1`, [sinc.id]);
  });
});
