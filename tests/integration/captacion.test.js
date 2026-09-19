import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { jest } from '@jest/globals';
import { limpiarProspectosSinIdentificar } from '../../src/modules/captacion/services/captacionService.js';
import { emailsDePrueba, simulacionDePrueba } from '../../src/services/emailService.js';

jest.setTimeout(30000);

let app;
const asesorEmail = 'captacion-test@kernel.test';
const asesorPass  = 'testpass123';
let asesorUuid;
let empresaCodigo  = 'EMP-CAP-TEST';
let prospectoId;
let rawToken;
let vinculacionId;
let stepupToken;

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
    `DELETE FROM archivos WHERE entidad_tipo IN ('captacion_cedula_frente','captacion_cedula_reverso','captacion_formato') AND entidad_id = $1`, [vinculacionId]
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
      empresa_codigo: 'NO-EXISTE', acepta_habeas_data: true,
      nombres: 'Juan', apellidos: 'Pérez', cedula: '11111111', celular: '3001234567',
    });
    expect(res.status).toBe(400);
  });

  test('POST /prospectos — sin habeas_data → 400', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.post('/api/captacion/prospectos').send({
      empresa_codigo: empresaCodigo,
      nombres: 'Juan', apellidos: 'Pérez', cedula: '11111111', celular: '3001234567',
      // acepta_habeas_data omitido
    });
    expect(res.status).toBe(400);
  });

  test('POST /prospectos — body inválido → 400', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.post('/api/captacion/prospectos').send({ nombres: 'Solo' });
    expect(res.status).toBe(400);
  });

  test('POST /prospectos — crea correctamente con habeas_data e interés', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.post('/api/captacion/prospectos').send({
      empresa_codigo    : empresaCodigo,
      nombres           : 'Juan',
      apellidos         : 'Pérez',
      cedula            : '11111111',
      celular           : '3001234567',
      correo            : 'juan@test.com',
      acepta_habeas_data: true,
      interes_principal : 'credito',
    });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('token');
    expect(res.body.token).toHaveLength(43); // base64url 32 bytes
    expect(res.body.interes_principal).toBe('credito');
    prospectoId = res.body.id;
    rawToken    = res.body.token;
  });

  test('POST /prospectos — duplicado en 30 días → 409', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.post('/api/captacion/prospectos').send({
      empresa_codigo: empresaCodigo, acepta_habeas_data: true,
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

  test('GET /pub/:token — link expirado → 410 con datos accionables', async () => {
    // Crear prospecto con token ya expirado
    const { rows: [exp] } = await pool.query(
      `INSERT INTO captacion_prospectos
         (empresa_codigo, asesor_uuid, nombres, apellidos, cedula, celular,
          token_hash, token, acepta_habeas_data, habeas_data_at,
          token_expira_at)
       VALUES ($1,$2,'Vencido','Test','99999999','3000000000',
               'hash-exp-test','token-exp-test', true, NOW(),
               NOW() - INTERVAL '1 day')
       RETURNING id`,
      [empresaCodigo, asesorUuid]
    );
    const res = await request(app).get('/api/captacion/pub/token-exp-test');
    expect(res.status).toBe(410);
    expect(res.body).toHaveProperty('nombres', 'Vencido');
    expect(res.body).toHaveProperty('asesor_nombre');
    expect(res.body.error).toMatch(/expirado/i);
    // Cleanup
    await pool.query(`DELETE FROM captacion_eventos WHERE prospecto_id = $1`, [exp.id]);
    await pool.query(`DELETE FROM captacion_prospectos WHERE id = $1`, [exp.id]);
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

  describe('verificación por código (OTP) al correo', () => {
    const otpUrl    = () => `/api/captacion/pub/${rawToken}/otp`;
    const stepupUrl = () => `/api/captacion/pub/${rawToken}/step-up`;
    const codigoEnviado = () => emailsDePrueba.at(-1).text.match(/es: (\d{6})/)[1];
    // Salta la espera mínima entre envíos sin dormir el test
    const sinEspera = () => pool.query(
      `UPDATE captacion_otp SET created_at = created_at - INTERVAL '2 minutes' WHERE prospecto_id = $1`, [prospectoId]);

    test('sin correo registrado → 400 CORREO_REQUERIDO', async () => {
      await pool.query('UPDATE captacion_prospectos SET correo = NULL WHERE id = $1', [prospectoId]);
      try {
        const res = await request(app).post(otpUrl());
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('CORREO_REQUERIDO');
      } finally {
        await pool.query(`UPDATE captacion_prospectos SET correo = 'juan@test.com' WHERE id = $1`, [prospectoId]);
      }
    });

    test('correo en la lista de supresión (rebotó antes) → 400 CORREO_INVALIDO y no se gasta el cupo', async () => {
      await pool.query(`INSERT INTO email_supresiones (email, motivo) VALUES ('juan@test.com', 'rebote') ON CONFLICT (lower(email)) DO UPDATE SET is_active = true`);
      try {
        const antes = (await pool.query('SELECT COUNT(*)::int AS n FROM captacion_otp WHERE prospecto_id = $1', [prospectoId])).rows[0].n;
        const res = await request(app).post(otpUrl());
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('CORREO_INVALIDO');
        expect((await pool.query('SELECT COUNT(*)::int AS n FROM captacion_otp WHERE prospecto_id = $1', [prospectoId])).rows[0].n).toBe(antes);
      } finally {
        await pool.query(`DELETE FROM email_supresiones WHERE lower(email) = 'juan@test.com'`);
      }
    });

    test('pedir el código envía un correo de 6 dígitos y no expone el correo completo ni el código', async () => {
      const antes = emailsDePrueba.length;
      const res = await request(app).post(otpUrl());
      expect(res.status).toBe(200);
      expect(res.body.correo).toBe('ju**@test.com');
      expect(JSON.stringify(res.body)).not.toMatch(/\d{6}/);
      expect(emailsDePrueba.length).toBe(antes + 1);
      expect(emailsDePrueba.at(-1).to).toBe('juan@test.com');
      expect(codigoEnviado()).toMatch(/^\d{6}$/);
      // Solo se guarda el hash
      const { rows: [o] } = await pool.query('SELECT codigo_hash FROM captacion_otp WHERE prospecto_id = $1', [prospectoId]);
      expect(o.codigo_hash).toHaveLength(64);
      expect(o.codigo_hash).not.toBe(codigoEnviado());
    });

    test('con el correo caído → 502, el código anterior sigue vigente y no se gasta la espera', async () => {
      const filas = () => pool.query('SELECT COUNT(*)::int AS n FROM captacion_otp WHERE prospecto_id = $1', [prospectoId]).then((r) => r.rows[0].n);
      const antes = await filas();
      await sinEspera();
      simulacionDePrueba.fallar = true;
      try {
        const res = await request(app).post(otpUrl());
        expect(res.status).toBe(502);
        expect(res.body.code).toBe('CORREO_NO_ENVIADO');
      } finally {
        simulacionDePrueba.fallar = false;
      }
      expect(await filas()).toBe(antes);
      const { rows: [vigente] } = await pool.query('SELECT usado_at FROM captacion_otp WHERE prospecto_id = $1 ORDER BY created_at DESC LIMIT 1', [prospectoId]);
      expect(vigente.usado_at).toBeNull();
      const { rows: ev } = await pool.query(`SELECT 1 FROM captacion_eventos WHERE prospecto_id = $1 AND tipo = 'otp_envio_fallido'`, [prospectoId]);
      expect(ev.length).toBe(1);
      // Al volver el servicio, se puede pedir de inmediato
      expect((await request(app).post(otpUrl())).status).toBe(200);
    });

    test('pedir otro código enseguida → 429', async () => {
      const res = await request(app).post(otpUrl());
      expect(res.status).toBe(429);
    });

    test('el formato anterior (últimos 4 dígitos de la cédula) ya no sirve → 400', async () => {
      expect((await request(app).post(stepupUrl()).send({ digitos: '1111' })).status).toBe(400);
    });

    test('tras 5 intentos fallidos el código se invalida, aunque después se escriba el correcto', async () => {
      await sinEspera();
      expect((await request(app).post(otpUrl())).status).toBe(200);
      const bueno = codigoEnviado();
      const malo = bueno === '000000' ? '111111' : '000000';
      for (let i = 0; i < 4; i += 1) {
        const r = await request(app).post(stepupUrl()).send({ codigo: malo });
        expect(r.status).toBe(403);
        expect(r.body.code).toBe('OTP_INCORRECTO');
      }
      const quinto = await request(app).post(stepupUrl()).send({ codigo: malo });
      expect(quinto.status).toBe(403);
      expect(quinto.body.code).toBe('OTP_NO_VIGENTE');
      const tarde = await request(app).post(stepupUrl()).send({ codigo: bueno });
      expect(tarde.status).toBe(403);
    });

    test('código vencido → 403', async () => {
      await sinEspera();
      expect((await request(app).post(otpUrl())).status).toBe(200);
      const codigo = codigoEnviado();
      await pool.query(`UPDATE captacion_otp SET expira_at = NOW() - INTERVAL '1 second' WHERE prospecto_id = $1 AND usado_at IS NULL`, [prospectoId]);
      expect((await request(app).post(stepupUrl()).send({ codigo })).status).toBe(403);
    });

    test('código correcto → devuelve stepup_token y el código no se puede reutilizar', async () => {
      await sinEspera();
      expect((await request(app).post(otpUrl())).status).toBe(200);
      const codigo = codigoEnviado();
      const mal = await request(app).post(stepupUrl()).send({ codigo: codigo === '000000' ? '111111' : '000000' });
      expect(mal.status).toBe(403);

      const res = await request(app).post(stepupUrl()).send({ codigo });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(typeof res.body.stepup_token).toBe('string');
      stepupToken = res.body.stepup_token; // guardar para usar en firma

      expect((await request(app).post(stepupUrl()).send({ codigo })).status).toBe(403);
      const { rows } = await pool.query(
        `SELECT payload FROM captacion_eventos WHERE prospecto_id = $1 AND tipo = 'stepup_ok'`, [prospectoId]);
      expect(rows[0].payload).toMatchObject({ canal: 'correo', destino: 'ju**@test.com' });
    });
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

  test('PUT /pub/:token/personal — celular y correo se guardan en el prospecto y dejan de pedirse', async () => {
    // Estado inicial: el prospecto de prueba tiene celular pero no correo
    await pool.query(`UPDATE captacion_prospectos SET correo = NULL WHERE id = $1`, [prospectoId]);
    const antes = await request(app).get(`/api/captacion/pub/${rawToken}`);
    expect(antes.body.requiere_celular).toBe(false);
    expect(antes.body.requiere_correo).toBe(true);
    expect(antes.body).not.toHaveProperty('celular');
    expect(antes.body).not.toHaveProperty('correo');

    const res = await request(app)
      .put(`/api/captacion/pub/${rawToken}/personal`)
      .send({ celular: '3109998877', correo: 'asociado@ejemplo.com' });
    expect(res.status).toBe(200);

    const { rows: [p] } = await pool.query(`SELECT celular, correo FROM captacion_prospectos WHERE id = $1`, [prospectoId]);
    expect(p).toEqual({ celular: '3109998877', correo: 'asociado@ejemplo.com' });

    const despues = await request(app).get(`/api/captacion/pub/${rawToken}`);
    expect(despues.body.requiere_correo).toBe(false);
    // Volver al correo con el que se verificó el código: cambiarlo invalida la verificación (se prueba aparte)
    await pool.query(`UPDATE captacion_prospectos SET correo = 'juan@test.com' WHERE id = $1`, [prospectoId]);
  });

  test('PUT /pub/:token/personal — correo o celular inválidos → 400 y no se modifica nada', async () => {
    const { rows: [antes] } = await pool.query(`SELECT celular, correo FROM captacion_prospectos WHERE id = $1`, [prospectoId]);
    expect((await request(app).put(`/api/captacion/pub/${rawToken}/personal`).send({ correo: 'no-es-un-correo' })).status).toBe(400);
    expect((await request(app).put(`/api/captacion/pub/${rawToken}/personal`).send({ celular: '123' })).status).toBe(400);
    const { rows: [despues] } = await pool.query(`SELECT celular, correo FROM captacion_prospectos WHERE id = $1`, [prospectoId]);
    expect(despues).toEqual(antes);
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

  describe('aportes y beneficios', () => {
    const url = () => `/api/captacion/pub/${rawToken}/aportes`;
    const valido = { valor_aporte: 76000, periodicidad: 'quincenal', seguro_vida: true, bono_sorteo: false };

    test('GET /pub/:token — publica las tarifas vigentes', async () => {
      const res = await request(app).get(`/api/captacion/pub/${rawToken}`);
      expect(res.body.tarifas).toEqual({
        aporte_minimo: 74000, aporte_paso: 1000, fondo_bienestar: 5300,
        seguro_vida: 5000, bono_sorteo: 3000, cuota_admision: 35000,
      });
    });

    test('rechaza aporte menor al mínimo, no múltiplo de $1.000, periodicidad inválida o faltantes → 400', async () => {
      expect((await request(app).put(url()).send({ ...valido, valor_aporte: 73000 })).status).toBe(400);
      expect((await request(app).put(url()).send({ ...valido, valor_aporte: 74500 })).status).toBe(400);
      expect((await request(app).put(url()).send({ ...valido, valor_aporte: '76000' })).status).toBe(400);
      expect((await request(app).put(url()).send({ ...valido, periodicidad: 'semanal' })).status).toBe(400);
      expect((await request(app).put(url()).send({ valor_aporte: 76000 })).status).toBe(400);
    });

    test('guarda la elección; fondo, seguro, bono y cuota los fija el servidor (el cliente no puede alterarlos)', async () => {
      const res = await request(app).put(url()).send({
        ...valido,
        // Intento de manipular precios: deben ignorarse
        valor_fondo_bienestar: 0, valor_seguro_vida: 1, valor_bono_sorteo: 1, cuota_admision: 0,
      });
      expect(res.status).toBe(200);
      expect(res.body.total_mensual).toBe(76000 + 5300 + 5000);

      const { rows: [v] } = await pool.query(
        `SELECT valor_aporte, periodicidad_descuento, valor_fondo_bienestar,
                seguro_vida_activo, valor_seguro_vida, bono_sorteo_activo, valor_bono_sorteo,
                cuota_admision, seccion_aportes_at, seccion_aportes_autor
           FROM captacion_vinculaciones WHERE id = $1`, [vinculacionId]);
      expect(Number(v.valor_aporte)).toBe(76000);
      expect(v.periodicidad_descuento).toBe('quincenal');
      expect(Number(v.valor_fondo_bienestar)).toBe(5300);
      expect(v.seguro_vida_activo).toBe(true);
      expect(Number(v.valor_seguro_vida)).toBe(5000);
      expect(v.bono_sorteo_activo).toBe(false);
      expect(Number(v.valor_bono_sorteo)).toBe(0);
      expect(Number(v.cuota_admision)).toBe(35000);
      expect(v.seccion_aportes_at).not.toBeNull();
      expect(v.seccion_aportes_autor).toBe('prospecto');
    });

    test('el bono suma su tarifa cuando se elige, y volver a guardar reemplaza la elección', async () => {
      const res = await request(app).put(url()).send({ valor_aporte: 74000, periodicidad: 'mensual', seguro_vida: false, bono_sorteo: true });
      expect(res.status).toBe(200);
      expect(res.body.total_mensual).toBe(74000 + 5300 + 3000);
      const { rows: [v] } = await pool.query(
        `SELECT valor_aporte, periodicidad_descuento, valor_bono_sorteo, valor_seguro_vida FROM captacion_vinculaciones WHERE id = $1`, [vinculacionId]);
      expect(Number(v.valor_aporte)).toBe(74000);
      expect(v.periodicidad_descuento).toBe('mensual');
      expect(Number(v.valor_bono_sorteo)).toBe(3000);
      expect(Number(v.valor_seguro_vida)).toBe(0);
    });
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

  test('POST /pub/:token/firmar — sin step-up token → 403', async () => {
    const res = await request(app)
      .post(`/api/captacion/pub/${rawToken}/firmar`)
      .send({
        firma_png: 'data:image/png;base64,iVBORw0KGgo=',
        firma_trazos: [{ x: 10, y: 20, t: 100 }],
        version_consentimiento: 'v1.0', acepta_terminos: true, acepta_firma_electronica: true, version_firma_electronica: 'fe-v1.0',
      });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('STEPUP_REQUIRED');
  });

  test('POST /pub/:token/firmar — sin PEP respondido → 400', async () => {
    await pool.query(
      `UPDATE captacion_vinculaciones SET seccion_pep_at = NULL WHERE id = $1`, [vinculacionId]
    );
    const res = await request(app)
      .post(`/api/captacion/pub/${rawToken}/firmar`)
      .set('x-stepup-token', stepupToken)
      .send({
        firma_png             : 'data:image/png;base64,iVBORw0KGgo=',
        firma_trazos          : [{ x: 10, y: 20, t: 100 }],
        version_consentimiento: 'v1.0',
        acepta_terminos       : true,
        acepta_firma_electronica: true,
        version_firma_electronica: 'fe-v1.0',
      });
    expect(res.status).toBe(400);
  });

  test('POST /pub/:token/firmar — sin elegir aporte → 400', async () => {
    await pool.query(
      `UPDATE captacion_vinculaciones SET seccion_pep_at = NOW(), seccion_aportes_at = NULL WHERE id = $1`, [vinculacionId]
    );
    try {
      const res = await request(app)
        .post(`/api/captacion/pub/${rawToken}/firmar`)
        .set('x-stepup-token', stepupToken)
        .send({
          firma_png: 'data:image/png;base64,iVBORw0KGgo=',
          firma_trazos: [{ x: 10, y: 20, t: 100 }],
          version_consentimiento: 'v1.0', acepta_terminos: true, acepta_firma_electronica: true, version_firma_electronica: 'fe-v1.0',
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/aporte/i);
    } finally {
      await pool.query(`UPDATE captacion_vinculaciones SET seccion_aportes_at = NOW() WHERE id = $1`, [vinculacionId]);
    }
  });

  test('POST /pub/:token/firmar — sin consentimiento a firmar electrónicamente o con texto viejo → 400', async () => {
    const base = {
      firma_png: 'data:image/png;base64,iVBORw0KGgo=',
      firma_trazos: [{ x: 10, y: 20, t: 100 }],
      version_consentimiento: 'v1.0', acepta_terminos: true,
    };
    const firmar = (extra) => request(app).post(`/api/captacion/pub/${rawToken}/firmar`).set('x-stepup-token', stepupToken).send({ ...base, ...extra });
    expect((await firmar({})).status).toBe(400);
    expect((await firmar({ acepta_firma_electronica: false, version_firma_electronica: 'fe-v1.0' })).status).toBe(400);
    const vieja = await firmar({ acepta_firma_electronica: true, version_firma_electronica: 'fe-v0.1' });
    expect(vieja.status).toBe(400);
    expect(vieja.body.error).toMatch(/consentimiento/i);
    const { rows: [v] } = await pool.query('SELECT seccion_firma_at FROM captacion_vinculaciones WHERE id = $1', [vinculacionId]);
    expect(v.seccion_firma_at).toBeNull();
  });

  test('POST /pub/:token/firmar — si el correo cambió tras verificarlo, hay que verificar de nuevo → 403', async () => {
    await pool.query(`UPDATE captacion_prospectos SET correo = 'otro@test.com' WHERE id = $1`, [prospectoId]);
    try {
      const res = await request(app)
        .post(`/api/captacion/pub/${rawToken}/firmar`)
        .set('x-stepup-token', stepupToken)
        .send({});
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('STEPUP_EXPIRED');
    } finally {
      await pool.query(`UPDATE captacion_prospectos SET correo = 'juan@test.com' WHERE id = $1`, [prospectoId]);
    }
  });

  test('POST /pub/:token/firmar — con PEP y step-up → solicitud_completa', async () => {
    // Restaurar PEP
    await pool.query(
      `UPDATE captacion_vinculaciones SET seccion_pep_at = NOW() WHERE id = $1`, [vinculacionId]
    );
    const res = await request(app)
      .post(`/api/captacion/pub/${rawToken}/firmar`)
      .set('x-stepup-token', stepupToken)
      .send({
        firma_png             : 'data:image/png;base64,iVBORw0KGgo=',
        firma_trazos          : [{ x: 10, y: 20, t: 100 }, { x: 15, y: 25, t: 150 }],
        version_consentimiento: 'v1.0',
        acepta_terminos       : true,
        acepta_firma_electronica: true,
        version_firma_electronica: 'fe-v1.0',
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

  test('firma electrónica: queda constancia del consentimiento y se sella el PDF con su hash', async () => {
    const { rows: [v] } = await pool.query(
      `SELECT firma_electronica_at, firma_electronica_version, firma_pdf_archivo_id, firma_pdf_hash, firma_doc_hash
         FROM captacion_vinculaciones WHERE id = $1`, [vinculacionId]);
    expect(v.firma_electronica_at).toBeTruthy();
    expect(v.firma_electronica_version).toBe('fe-v1.0');
    expect(v.firma_pdf_archivo_id).toBeTruthy();
    expect(v.firma_pdf_hash).toHaveLength(64);
    const { rows: [ver] } = await pool.query('SELECT firma_verificacion FROM captacion_vinculaciones WHERE id = $1', [vinculacionId]);
    expect(ver.firma_verificacion).toMatchObject({ canal: 'correo', destino: 'ju**@test.com' });

    const ev = await pool.query(
      `SELECT tipo, payload FROM captacion_eventos WHERE vinculacion_id = $1 AND tipo IN ('firma','formato_sellado')`, [vinculacionId]);
    const firma = ev.rows.find((e) => e.tipo === 'firma');
    expect(firma.payload.firma_electronica).toBe('fe-v1.0');
    const sello = ev.rows.find((e) => e.tipo === 'formato_sellado');
    expect(sello.payload.pdf_hash).toBe(v.firma_pdf_hash);
    expect(sello.payload.doc_hash).toBe(v.firma_doc_hash);
  });

  test('firma electrónica: la descarga entrega el PDF sellado (mismo hash) aunque los datos cambien después', async () => {
    const binario = (r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };
    const ag = agent();
    await loginAsesor(ag);
    const url = `/api/captacion/vinculaciones/${vinculacionId}/formato`;
    const { rows: [v] } = await pool.query('SELECT firma_pdf_hash, cargo FROM captacion_vinculaciones WHERE id = $1', [vinculacionId]);

    const sellado = await ag.get(url).buffer(true).parse(binario);
    expect(sellado.headers['x-formato-sellado']).toBe('true');
    expect(crypto.createHash('sha256').update(sellado.body).digest('hex')).toBe(v.firma_pdf_hash);

    await pool.query(`UPDATE captacion_vinculaciones SET cargo = 'Cargo modificado después' WHERE id = $1`, [vinculacionId]);
    try {
      const otra = await ag.get(url).buffer(true).parse(binario);
      expect(crypto.createHash('sha256').update(otra.body).digest('hex')).toBe(v.firma_pdf_hash); // inmutable
      const actual = await ag.get(`${url}?actual=1`).buffer(true).parse(binario);
      expect(actual.headers['x-formato-sellado']).toBe('false');
      expect(actual.body.subarray(0, 5).toString()).toBe('%PDF-');
    } finally {
      await pool.query('UPDATE captacion_vinculaciones SET cargo = $1 WHERE id = $2', [v.cargo, vinculacionId]);
    }
  });

  test('POST /pub/:token/firmar — una solicitud ya firmada no se puede firmar de nuevo → 409', async () => {
    const res = await request(app)
      .post(`/api/captacion/pub/${rawToken}/firmar`)
      .set('x-stepup-token', stepupToken)
      .send({
        firma_png: 'data:image/png;base64,iVBORw0KGgo=',
        firma_trazos: [{ x: 1, y: 2, t: 3 }],
        version_consentimiento: 'v1.0', acepta_terminos: true,
        acepta_firma_electronica: true, version_firma_electronica: 'fe-v1.0',
      });
    expect(res.status).toBe(409);
  });

  test('subsanación: firmada y sin entregar, el asociado puede seguir completando secciones sin perder la firma', async () => {
    const antes = (await pool.query(
      `SELECT seccion_firma_at, estado, firma_doc_hash FROM captacion_vinculaciones WHERE id = $1`, [vinculacionId])).rows[0];
    expect(antes.estado).toBe('solicitud_completa');

    const aportes = await request(app).put(`/api/captacion/pub/${rawToken}/aportes`)
      .send({ valor_aporte: 90000, periodicidad: 'mensual', seguro_vida: true, bono_sorteo: true });
    expect(aportes.status).toBe(200);
    const laboral = await request(app).put(`/api/captacion/pub/${rawToken}/laboral`).send({ cargo: 'Coordinador' });
    expect(laboral.status).toBe(200);

    const despues = (await pool.query(
      `SELECT seccion_firma_at, estado, firma_doc_hash, valor_aporte, cargo FROM captacion_vinculaciones WHERE id = $1`, [vinculacionId])).rows[0];
    expect(despues.seccion_firma_at).toEqual(antes.seccion_firma_at); // la firma sigue vigente
    expect(despues.estado).toBe('solicitud_completa');
    expect(despues.firma_doc_hash).toBe(antes.firma_doc_hash);         // evidencia de lo que firmó, intacta
    expect(Number(despues.valor_aporte)).toBe(90000);
    expect(despues.cargo).toBe('Coordinador');

    // Cada cambio posterior a la firma queda auditado (autor, sección y campos; no los valores)
    const ag = agent();
    await loginAsesor(ag);
    expect((await ag.put(`/api/captacion/vinculaciones/${vinculacionId}/valores`).send({ cuota_admision: 35000 })).status).toBe(200);
    const { rows: cambios } = await pool.query(
      `SELECT seccion, autor_tipo, autor_uuid, payload FROM captacion_eventos
        WHERE vinculacion_id = $1 AND tipo = 'cambio_posterior_a_firma' ORDER BY created_at`, [vinculacionId]);
    expect(cambios.map((c) => c.seccion)).toEqual(['aportes', 'laboral', 'valores']);
    expect(cambios[0].autor_tipo).toBe('prospecto');
    expect(cambios[0].payload.campos).toContain('valor_aporte');
    expect(JSON.stringify(cambios[0].payload)).not.toContain('90000'); // solo nombres de campo
    expect(cambios[2]).toMatchObject({ autor_tipo: 'asesor', autor_uuid: asesorUuid });

    // El GET público deja que el formulario detecte qué pasos siguen pendientes tras la firma
    const get = await request(app).get(`/api/captacion/pub/${rawToken}`);
    expect(get.body.vinculacion.estado).toBe('solicitud_completa');
    expect(get.body.vinculacion.seccion_firma_at).toBeTruthy();
    expect(get.body.vinculacion).toHaveProperty('seccion_aportes_at');
    expect(get.body.vinculacion).toHaveProperty('seccion_documentos_at');
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

  test('GET /vinculaciones/:id/documentos — sin cédula cargada → frente y reverso null', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.get(`/api/captacion/vinculaciones/${vinculacionId}/documentos`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ frente: null, reverso: null });
  });

  test('GET /vinculaciones/:id/documentos — con cédula → URLs firmadas y auditoría', async () => {
    const insertar = async (lado, nombre, mime) => (await pool.query(
      `INSERT INTO archivos (entidad_tipo, entidad_id, s3_key, nombre, mime_type, size_bytes, subido_por)
       VALUES ($1,$2,$3,$4,$5,1000,NULL) RETURNING id`,
      [`captacion_cedula_${lado}`, vinculacionId, `kernel/test/${vinculacionId}/${lado}`, nombre, mime]
    )).rows[0].id;
    const frenteId  = await insertar('frente',  'frente.jpg',  'image/jpeg');
    const reversoId = await insertar('reverso', 'reverso.pdf', 'application/pdf');
    await pool.query(
      `UPDATE captacion_vinculaciones SET cedula_frente_id = $1, cedula_reverso_id = $2 WHERE id = $3`,
      [frenteId, reversoId, vinculacionId]
    );

    try {
      const ag = agent();
      await loginAsesor(ag);
      const res = await ag.get(`/api/captacion/vinculaciones/${vinculacionId}/documentos`);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toMatch(/no-store/);
      expect(res.body.frente.url).toContain('X-Amz-Signature');
      expect(res.body.frente.mime).toBe('image/jpeg');
      expect(res.body.reverso.mime).toBe('application/pdf');

      const { rows } = await pool.query(
        `SELECT payload FROM captacion_eventos WHERE vinculacion_id = $1 AND tipo = 'documento_visto'`,
        [vinculacionId]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].payload.lados).toEqual(['frente', 'reverso']);
    } finally {
      // Dejar la vinculación como estaba: los tests de entregar dependen de "sin documentos"
      await pool.query(
        `UPDATE captacion_vinculaciones SET cedula_frente_id = NULL, cedula_reverso_id = NULL WHERE id = $1`,
        [vinculacionId]
      );
      await pool.query(`DELETE FROM archivos WHERE id = ANY($1)`, [[frenteId, reversoId]]);
    }
  });

  test('GET /vinculaciones/:id/documentos — otro asesor → 404', async () => {
    const otroEmail = 'captacion-test-otro@kernel.test';
    const hash = await bcrypt.hash(asesorPass, 4);
    const { rows: [otro] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
       VALUES ('Otro Asesor', $1, $2, 'asesor', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id`,
      [otroEmail, hash]
    );
    await pool.query(
      `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
       SELECT $1, m.id, a.id FROM modulos m, acciones a
       WHERE m.nombre = 'captacion' AND a.nombre = 'READ' ON CONFLICT DO NOTHING`, [otro.id]
    );
    try {
      const ag = agent();
      await ag.post('/api/auth/login').send({ email: otroEmail, password: asesorPass });
      const res = await ag.get(`/api/captacion/vinculaciones/${vinculacionId}/documentos`);
      expect(res.status).toBe(404);
    } finally {
      await pool.query(`DELETE FROM permisos WHERE usuario_uuid = $1`, [otro.id]);
      await pool.query(`DELETE FROM global_usuarios WHERE id = $1`, [otro.id]);
    }
  });

  describe('formato de vinculación en PDF', () => {
    test('GET /vinculaciones/:id/formato — PDF de 2 páginas con auditoría', async () => {
      const ag = agent();
      await loginAsesor(ag);
      const res = await ag.get(`/api/captacion/vinculaciones/${vinculacionId}/formato`)
        .buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/pdf/);
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="formato-vinculacion-.+\.pdf"/);
      expect(res.headers['cache-control']).toMatch(/no-store/);
      expect(res.body.subarray(0, 5).toString()).toBe('%PDF-');
      const { PDFDocument } = await import('pdf-lib');
      expect((await PDFDocument.load(res.body)).getPageCount()).toBe(2);

      const { rows } = await pool.query(
        `SELECT 1 FROM captacion_eventos WHERE vinculacion_id = $1 AND tipo = 'formato_descargado'`, [vinculacionId]);
      expect(rows.length).toBeGreaterThan(0);
    });

    test('GET /vinculaciones/:id/formato — sin sesión → 401 y id inexistente → 404', async () => {
      expect((await request(app).get(`/api/captacion/vinculaciones/${vinculacionId}/formato`)).status).toBe(401);
      const ag = agent();
      await loginAsesor(ag);
      const res = await ag.get('/api/captacion/vinculaciones/00000000-0000-0000-0000-000000000000/formato');
      expect(res.status).toBe(404);
    });
  });

  describe('cédula cargada por el asesor', () => {
    const base = () => `/api/captacion/vinculaciones/${vinculacionId}/documentos`;
    const meta = (nombre = 'cedula.jpg', mime = 'image/jpeg') => ({ nombre, mime, size: 500000 });

    // Simula lo que hace el navegador: pide URL firmada (S3 no se toca) y confirma con la key recibida
    const subir = async (ag, lado, m = meta()) => {
      const sol = await ag.post(`${base()}/${lado}/solicitar`).send(m);
      if (sol.status !== 200) return { sol };
      const conf = await ag.patch(`${base()}/${lado}/confirmar`).send({ key: sol.body.key, ...m });
      return { sol, conf };
    };

    test('solicitar — devuelve URL firmada y key de la solicitud', async () => {
      const ag = agent();
      await loginAsesor(ag);
      const res = await ag.post(`${base()}/frente/solicitar`).send(meta());
      expect(res.status).toBe(200);
      expect(res.body.uploadUrl).toContain('X-Amz-Signature');
      expect(res.body.key).toMatch(new RegExp(`^kernel/captacion_cedula_frentes/${vinculacionId}/.+\\.jpg$`));
    });

    test('solicitar — tipo no permitido, extensión que no coincide o lado inválido → 400', async () => {
      const ag = agent();
      await loginAsesor(ag);
      expect((await ag.post(`${base()}/frente/solicitar`).send(meta('a.exe', 'application/x-msdownload'))).status).toBe(400);
      expect((await ag.post(`${base()}/frente/solicitar`).send(meta('a.png', 'image/jpeg'))).status).toBe(400);
      expect((await ag.post(`${base()}/lateral/solicitar`).send(meta())).status).toBe(400);
    });

    test('confirmar — key de otra solicitud o sin key → 400', async () => {
      const ag = agent();
      await loginAsesor(ag);
      const ajena = await ag.patch(`${base()}/frente/confirmar`).send({
        key: 'kernel/captacion_cedula_frentes/00000000-0000-0000-0000-000000000000/x.jpg', ...meta(),
      });
      expect(ajena.status).toBe(400);
      expect((await ag.patch(`${base()}/frente/confirmar`).send(meta())).status).toBe(400);
    });

    test('flujo completo: ambas caras marcan la sección, quedan trazadas y reemplazar no deja huérfanos', async () => {
      const ag = agent();
      await loginAsesor(ag);
      try {
        const frente = await subir(ag, 'frente');
        expect(frente.conf.status).toBe(200);
        const tras1 = (await pool.query(
          `SELECT seccion_documentos_at FROM captacion_vinculaciones WHERE id = $1`, [vinculacionId])).rows[0];
        expect(tras1.seccion_documentos_at).toBeNull(); // falta el reverso

        const reverso = await subir(ag, 'reverso', meta('reverso.pdf', 'application/pdf'));
        expect(reverso.conf.status).toBe(200);
        const { rows: [v] } = await pool.query(
          `SELECT seccion_documentos_at, seccion_documentos_autor, cedula_frente_id, cedula_reverso_id
             FROM captacion_vinculaciones WHERE id = $1`, [vinculacionId]);
        expect(v.seccion_documentos_at).not.toBeNull();
        expect(v.seccion_documentos_autor).toBe('asesor');

        const { rows: [arch] } = await pool.query(`SELECT subido_por FROM archivos WHERE id = $1`, [v.cedula_frente_id]);
        expect(arch.subido_por).toBe(asesorUuid);

        // Reemplazar el frente: el anterior desaparece de la tabla y la vinculación apunta al nuevo
        const reemplazo = await subir(ag, 'frente', meta('frente-nuevo.png', 'image/png'));
        expect(reemplazo.conf.status).toBe(200);
        const { rows: frentes } = await pool.query(
          `SELECT id FROM archivos WHERE entidad_tipo = 'captacion_cedula_frente' AND entidad_id = $1`, [vinculacionId]);
        expect(frentes).toHaveLength(1);
        expect(frentes[0].id).toBe(reemplazo.conf.body.archivo_id);
        expect(frentes[0].id).not.toBe(v.cedula_frente_id);

        const { rows: eventos } = await pool.query(
          `SELECT autor_uuid, payload FROM captacion_eventos
            WHERE vinculacion_id = $1 AND tipo = 'documento_subido_asesor' ORDER BY created_at`, [vinculacionId]);
        expect(eventos).toHaveLength(3);
        expect(eventos.every(e => e.autor_uuid === asesorUuid)).toBe(true);
        expect(eventos.map(e => e.payload.lado)).toEqual(['frente', 'reverso', 'frente']);
      } finally {
        // Dejar la vinculación como estaba: los tests de entregar dependen de "sin documentos"
        await pool.query(
          `UPDATE captacion_vinculaciones
              SET cedula_frente_id = NULL, cedula_reverso_id = NULL,
                  seccion_documentos_at = NULL, seccion_documentos_autor = NULL WHERE id = $1`, [vinculacionId]);
        await pool.query(
          `DELETE FROM archivos WHERE entidad_tipo LIKE 'captacion_cedula_%' AND entidad_id = $1`, [vinculacionId]);
      }
    });

    test('otro asesor no puede cargar la cédula de una solicitud ajena → 404', async () => {
      const otroEmail = 'captacion-test-otro2@kernel.test';
      const hash = await bcrypt.hash(asesorPass, 4);
      const { rows: [otro] } = await pool.query(
        `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
         VALUES ('Otro Asesor 2', $1, $2, 'asesor', true, true)
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id`,
        [otroEmail, hash]
      );
      await pool.query(
        `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
         SELECT $1, m.id, a.id FROM modulos m, acciones a
         WHERE m.nombre = 'captacion' AND a.nombre IN ('READ','WRITE') ON CONFLICT DO NOTHING`, [otro.id]);
      try {
        const ag = agent();
        await ag.post('/api/auth/login').send({ email: otroEmail, password: asesorPass });
        expect((await ag.post(`${base()}/frente/solicitar`).send(meta())).status).toBe(404);
        expect((await ag.patch(`${base()}/frente/confirmar`).send({ key: 'kernel/x', ...meta() })).status).toBe(404);
      } finally {
        await pool.query(`DELETE FROM permisos WHERE usuario_uuid = $1`, [otro.id]);
        await pool.query(`DELETE FROM global_usuarios WHERE id = $1`, [otro.id]);
      }
    });
  });

  describe('aportes definidos por el asesor', () => {
    const url = () => `/api/captacion/vinculaciones/${vinculacionId}/aportes`;
    const valido = { valor_aporte: 82000, periodicidad: 'quincenal', seguro_vida: false, bono_sorteo: true };

    test('GET /vinculaciones/:id — incluye las tarifas para el formulario del panel', async () => {
      const ag = agent();
      await loginAsesor(ag);
      const res = await ag.get(`/api/captacion/vinculaciones/${vinculacionId}`);
      expect(res.body.tarifas).toMatchObject({ aporte_minimo: 74000, fondo_bienestar: 5300, seguro_vida: 5000, bono_sorteo: 3000 });
    });

    test('valida igual que el formulario del asociado → 400', async () => {
      const ag = agent();
      await loginAsesor(ag);
      expect((await ag.put(url()).send({ ...valido, valor_aporte: 70000 })).status).toBe(400);
      expect((await ag.put(url()).send({ ...valido, valor_aporte: 74500 })).status).toBe(400);
      expect((await ag.put(url()).send({ ...valido, periodicidad: 'anual' })).status).toBe(400);
    });

    test('guarda con autor "asesor", aplica las tarifas del servidor y deja auditoría', async () => {
      const ag = agent();
      await loginAsesor(ag);
      const res = await ag.put(url()).send({ ...valido, valor_fondo_bienestar: 0, valor_bono_sorteo: 1 });
      expect(res.status).toBe(200);
      expect(res.body.total_mensual).toBe(82000 + 5300 + 3000);

      const { rows: [v] } = await pool.query(
        `SELECT valor_aporte, periodicidad_descuento, valor_fondo_bienestar, valor_bono_sorteo, seccion_aportes_autor,
                seccion_firma_at IS NOT NULL AS firmada
           FROM captacion_vinculaciones WHERE id = $1`, [vinculacionId]);
      expect(Number(v.valor_aporte)).toBe(82000);
      expect(v.periodicidad_descuento).toBe('quincenal');
      expect(Number(v.valor_fondo_bienestar)).toBe(5300);
      expect(Number(v.valor_bono_sorteo)).toBe(3000);
      expect(v.seccion_aportes_autor).toBe('asesor');
      expect(v.firmada).toBe(true); // subsanar no invalida la firma

      const { rows: eventos } = await pool.query(
        `SELECT autor_uuid, payload FROM captacion_eventos WHERE vinculacion_id = $1 AND tipo = 'aportes_definidos_asesor'`, [vinculacionId]);
      expect(eventos).toHaveLength(1);
      expect(eventos[0].autor_uuid).toBe(asesorUuid);
      expect(eventos[0].payload.valor_aporte).toBe(82000);
    });

    test('otro asesor no puede definirlos → 404', async () => {
      const email = 'captacion-test-otro3@kernel.test';
      const hash = await bcrypt.hash(asesorPass, 4);
      const { rows: [otro] } = await pool.query(
        `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
         VALUES ('Otro Asesor 3', $1, $2, 'asesor', true, true)
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id`, [email, hash]);
      await pool.query(
        `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
         SELECT $1, m.id, a.id FROM modulos m, acciones a
         WHERE m.nombre = 'captacion' AND a.nombre IN ('READ','WRITE') ON CONFLICT DO NOTHING`, [otro.id]);
      try {
        const ag = agent();
        await ag.post('/api/auth/login').send({ email, password: asesorPass });
        expect((await ag.put(url()).send(valido)).status).toBe(404);
      } finally {
        await pool.query(`DELETE FROM permisos WHERE usuario_uuid = $1`, [otro.id]);
        await pool.query(`DELETE FROM global_usuarios WHERE id = $1`, [otro.id]);
      }
    });
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

  test('POST /vinculaciones/:id/entregar — sin aporte definido → 400', async () => {
    await pool.query(
      `UPDATE captacion_vinculaciones SET seccion_documentos_at = NOW() WHERE id = $1`, [vinculacionId]
    );
    const { rows: [antes] } = await pool.query(`SELECT valor_aporte FROM captacion_vinculaciones WHERE id = $1`, [vinculacionId]);
    await pool.query(`UPDATE captacion_vinculaciones SET valor_aporte = NULL WHERE id = $1`, [vinculacionId]);
    try {
      const ag = agent();
      await loginAsesor(ag);
      const res = await ag.post(`/api/captacion/vinculaciones/${vinculacionId}/entregar`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/aporte/i);
    } finally {
      await pool.query(`UPDATE captacion_vinculaciones SET valor_aporte = $2 WHERE id = $1`, [vinculacionId, antes.valor_aporte]);
    }
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

  test('cédula — una solicitud entregada ya no admite cambios (asesor ni asociado)', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const meta = { nombre: 'cedula.jpg', mime: 'image/jpeg', size: 1000 };
    const asesor = await ag.post(`/api/captacion/vinculaciones/${vinculacionId}/documentos/frente/solicitar`).send(meta);
    expect(asesor.status).toBe(400);
    expect(asesor.body.error).toMatch(/entregada/i);

    const publico = await request(app).post(`/api/captacion/pub/${rawToken}/documentos/frente/solicitar`).send(meta);
    expect(publico.status).toBe(400);
    expect(publico.body.error).toMatch(/entregada/i);

    const aportes = await request(app).put(`/api/captacion/pub/${rawToken}/aportes`)
      .send({ valor_aporte: 80000, periodicidad: 'mensual', seguro_vida: false, bono_sorteo: false });
    expect(aportes.status).toBe(400);
    expect(aportes.body.error).toMatch(/entregada/i);

    // Ninguna otra sección del formulario público, ni la firma, admite cambios tras la entrega
    const rutas = [
      ['put', 'personal', { cargo: 'x', estado_civil: 'soltero' }],
      ['put', 'laboral', { cargo: 'x' }],
      ['put', 'financiera', { origen_fondos: 'x' }],
      ['put', 'pep', { pep_maneja_recursos_publicos: false, pep_reconocimiento_publico: false, pep_poder_publico: false, pep_vinculo_expuesto: false }],
      ['put', 'beneficiarios', { beneficiarios: [{ orden: 1, nombres: 'X', porcentaje: 100 }] }],
      ['put', 'referencias', { referencias: [{ tipo: 'personal', nombres: 'X', celular: '3000000000' }] }],
    ];
    for (const [metodo, seccion, cuerpo] of rutas) {
      const r = await request(app)[metodo](`/api/captacion/pub/${rawToken}/${seccion}`).send(cuerpo);
      expect([seccion, r.status, r.body.error]).toEqual([seccion, 400, 'La solicitud ya fue entregada']);
    }
    const asesorAportes = await ag.put(`/api/captacion/vinculaciones/${vinculacionId}/aportes`)
      .send({ valor_aporte: 80000, periodicidad: 'mensual', seguro_vida: false, bono_sorteo: false });
    expect(asesorAportes.status).toBe(400);
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
         (empresa_codigo, asesor_uuid, nombres, apellidos, cedula, celular,
          token_hash, token, acepta_habeas_data, habeas_data_at)
       VALUES ($1, $2, 'Test', 'Sync', '77777777', '3000000000',
               'hash-sync-test', 'token-sync-test', true, NOW())
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


// ── Prospectos del stand sin identificar ──────────────────────────────────────

describe('Captacion — Prospectos del stand sin identificar', () => {
  const ids = {};

  // Lo que crea el kiosco al tocar "Quiero asociarme": cédula STAND_xxxx y nombre vacío
  const crearProspecto = async ({ horas = 0, cedula, nombres = '' }) => {
    const token = crypto.randomBytes(24).toString('base64url');
    const { rows: [p] } = await pool.query(
      `INSERT INTO captacion_prospectos
         (empresa_codigo, asesor_uuid, nombres, apellidos, cedula, celular,
          token_hash, token, acepta_habeas_data, habeas_data_at, created_at)
       VALUES ($1,$2,$3,$4,$5,'3000000000',$6,$7,true,NOW(), NOW() - make_interval(hours => $8))
       RETURNING id`,
      [empresaCodigo, asesorUuid, nombres, nombres ? 'Real' : '', cedula,
       crypto.createHash('sha256').update(token).digest('hex'), token, horas]
    );
    return { id: p.id, token };
  };
  const stand = () => `STAND_${crypto.randomBytes(4).toString('hex')}`;
  const activo = async (id) => (await pool.query(`SELECT is_active FROM captacion_prospectos WHERE id = $1`, [id])).rows[0].is_active;
  const listar = async (query = '') => {
    const ag = agent();
    await loginAsesor(ag);
    return (await ag.get(`/api/captacion/prospectos${query}`)).body.map((x) => x.id);
  };

  beforeAll(async () => {
    ids.reciente = await crearProspecto({ horas: 0,  cedula: stand() });
    ids.viejo    = await crearProspecto({ horas: 48, cedula: stand() });
    ids.conVinc  = await crearProspecto({ horas: 48, cedula: stand() });
    ids.real     = await crearProspecto({ horas: 48, cedula: '55555555', nombres: 'Ana' });
    await pool.query(`INSERT INTO captacion_vinculaciones (prospecto_id) VALUES ($1)`, [ids.conVinc.id]);
  });

  test('la lista los oculta por defecto y deja los prospectos reales', async () => {
    const lista = await listar();
    expect(lista).toContain(ids.real.id);
    for (const k of ['reciente', 'viejo', 'conVinc']) expect(lista).not.toContain(ids[k].id);
  });

  test('?sin_identificar=solo devuelve únicamente los del stand; =incluir devuelve todos', async () => {
    const solo = await listar('?sin_identificar=solo');
    expect(solo).toEqual(expect.arrayContaining([ids.reciente.id, ids.viejo.id, ids.conVinc.id]));
    expect(solo).not.toContain(ids.real.id);

    const todos = await listar('?sin_identificar=incluir');
    expect(todos).toEqual(expect.arrayContaining([ids.real.id, ids.reciente.id, ids.viejo.id]));
  });

  test('las filas de la lista traen origen y bandera sin_identificar', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const { body } = await ag.get('/api/captacion/prospectos?sin_identificar=incluir');
    const fantasma = body.find((x) => x.id === ids.reciente.id);
    expect(fantasma.sin_identificar).toBe(true);
    expect(body.find((x) => x.id === ids.real.id).sin_identificar).toBe(false);
    expect(body.find((x) => x.id === ids.real.id).origen).toBe('enlace');
  });

  test('GET /prospectos/resumen — cuenta los sin identificar', async () => {
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.get('/api/captacion/prospectos/resumen');
    expect(res.status).toBe(200);
    expect(res.body.sin_identificar).toBe(3);
  });

  test('las estadísticas del asesor no cuentan a los sin identificar', async () => {
    const { rows: [{ n }] } = await pool.query(
      `SELECT COUNT(*) AS n FROM captacion_prospectos p
        WHERE p.asesor_uuid = $1 AND p.is_active = true AND NOT (p.cedula LIKE 'STAND_%' AND p.nombres = '')`, [asesorUuid]);
    const ag = agent();
    await loginAsesor(ag);
    const res = await ag.get(`/api/captacion/valores/${asesorUuid}`);
    expect(res.body.total_prospectos).toBe(Number(n));
  });

  test('limpieza: solo da de baja los sin identificar viejos y sin vinculación', async () => {
    const bajas = await limpiarProspectosSinIdentificar({ horas: 24, asesorUuid });
    expect(bajas).toBe(1);
    expect(await activo(ids.viejo.id)).toBe(false);
    expect(await activo(ids.reciente.id)).toBe(true);   // muy reciente: alguien puede estar llenándolo
    expect(await activo(ids.conVinc.id)).toBe(true);    // ya inició una vinculación
    expect(await activo(ids.real.id)).toBe(true);       // es una persona real
    // idempotente
    expect(await limpiarProspectosSinIdentificar({ horas: 24, asesorUuid })).toBe(0);
  });

  test('al escribir su nombre y documento en el paso 1, el prospecto deja de ser fantasma y aparece en la lista', async () => {
    const res = await request(app)
      .put(`/api/captacion/pub/${ids.reciente.token}/personal`)
      .send({ nombres: 'Luisa', apellidos: 'Del Stand', cedula: '88888888' });
    expect(res.status).toBe(200);
    expect(await listar()).toContain(ids.reciente.id);
    expect(await listar('?sin_identificar=solo')).not.toContain(ids.reciente.id);
  });
});

// ── Enlace público de presentación (para grupos) ──────────────────────────────

describe('Captacion — Enlace público para grupos', () => {
  let token;
  const pedir = async (cuerpo) => {
    const ag = agent();
    await loginAsesor(ag);
    return ag.post('/api/captacion/enlaces-publicos').send(cuerpo);
  };

  afterAll(async () => {
    await pool.query(`DELETE FROM captacion_enlaces_publicos WHERE asesor_uuid = $1`, [asesorUuid]);
  });

  test('crear el enlace requiere sesión', async () => {
    const res = await request(app).post('/api/captacion/enlaces-publicos').send({ empresa_codigo: empresaCodigo });
    expect(res.status).toBe(401);
  });

  test('sin empresa o con una inexistente → 400', async () => {
    expect((await pedir({})).status).toBe(400);
    expect((await pedir({ empresa_codigo: 'NO-EXISTE' })).status).toBe(400);
  });

  test('crea el enlace y es idempotente: pedirlo de nuevo devuelve el mismo', async () => {
    const a = await pedir({ empresa_codigo: empresaCodigo });
    expect(a.status).toBe(200);
    expect(a.body.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    token = a.body.token;
    const b = await pedir({ empresa_codigo: empresaCodigo });
    expect(b.body.token).toBe(token);
  });

  test('GET /pub/enlace/:token — muestra empresa y asesor, sin datos sensibles', async () => {
    const res = await request(app).get(`/api/captacion/pub/enlace/${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ empresa_nombre: 'Empresa Captacion Test', asesor_nombre: 'Asesor Test' });
  });

  test('token inexistente → 404 al consultar y al iniciar', async () => {
    expect((await request(app).get('/api/captacion/pub/enlace/no-existe')).status).toBe(404);
    expect((await request(app).post('/api/captacion/pub/enlace/no-existe/iniciar')).status).toBe(404);
  });

  test('iniciar crea un prospecto sin identificar asignado al asesor, oculto de la lista y con enlace personal usable', async () => {
    const res = await request(app).post(`/api/captacion/pub/enlace/${token}/iniciar`);
    expect(res.status).toBe(201);
    expect(res.body.token).toHaveLength(43);

    const { rows: [p] } = await pool.query(
      `SELECT id, asesor_uuid, empresa_codigo, nombres, cedula FROM captacion_prospectos WHERE token = $1`, [res.body.token]);
    expect(p.asesor_uuid).toBe(asesorUuid);
    expect(p.empresa_codigo).toBe(empresaCodigo);
    expect(p.nombres).toBe('');
    expect(p.cedula).toMatch(/^STAND_/);

    const ag = agent();
    await loginAsesor(ag);
    const oculta = await ag.get('/api/captacion/prospectos');
    expect(oculta.body.map((x) => x.id)).not.toContain(p.id);
    const todas = await ag.get('/api/captacion/prospectos?sin_identificar=incluir');
    expect(todas.body.find((x) => x.id === p.id).origen).toBe('grupo');

    // El enlace personal generado funciona y pide identificarse
    const get = await request(app).get(`/api/captacion/pub/${res.body.token}`);
    expect(get.status).toBe(200);
    expect(get.body.requiere_identificacion).toBe(true);
  });

  test('renovar genera un enlace nuevo e invalida el anterior', async () => {
    const r = await pedir({ empresa_codigo: empresaCodigo, renovar: true });
    expect(r.body.token).not.toBe(token);
    expect((await request(app).get(`/api/captacion/pub/enlace/${token}`)).status).toBe(404);
    token = r.body.token;
    expect((await request(app).get(`/api/captacion/pub/enlace/${token}`)).status).toBe(200);
  });

  test('desactivar lo deja sin efecto; pedirlo de nuevo lo reactiva con el mismo enlace', async () => {
    const ag = agent();
    await loginAsesor(ag);
    expect((await ag.delete(`/api/captacion/enlaces-publicos/${empresaCodigo}`)).status).toBe(200);
    expect((await request(app).get(`/api/captacion/pub/enlace/${token}`)).status).toBe(404);
    expect((await request(app).post(`/api/captacion/pub/enlace/${token}/iniciar`)).status).toBe(404);
    expect((await ag.delete(`/api/captacion/enlaces-publicos/${empresaCodigo}`)).status).toBe(404); // ya no hay uno activo

    const otra = await pedir({ empresa_codigo: empresaCodigo });
    expect(otra.body.token).toBe(token);
    expect((await request(app).get(`/api/captacion/pub/enlace/${token}`)).status).toBe(200);
  });
});
