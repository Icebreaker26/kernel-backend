/**
 * FLUJO COMPLETO DE UNA AFILIACIÓN, de punta a punta y como lo vive una persona real:
 *
 *   página pública /asociate  →  inicia  →  autoriza sus datos (Ley 1581)  →  se identifica  →  llena el formulario
 *   →  sube su cédula  →  verifica su correo (código)  →  firma electrónicamente  →  el asesor la recibe, revisa su
 *   evidencia y la ENTREGA  →  la solicitud queda cerrada y trazada.
 *
 * Es UN solo recorrido con estado compartido (cada paso depende del anterior), contra la base de datos real y sin
 * mocks: si algún eslabón se rompe, este archivo lo dice y dice en qué paso. Las pruebas de captacion.test.js cubren
 * cada tramo por separado y a fondo (validaciones, casos borde, seguridad); esta cubre que TODO ENCAJA.
 */
import request from 'supertest';
import bcrypt from 'bcrypt';
import { jest } from '@jest/globals';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import { emailsDePrueba } from '../../src/services/emailService.js';

jest.setTimeout(30000);

let app;
const pass = 'testpass123';
const EMPRESA = 'EMP-FLUJO-TEST';
const CEDULA = '88800001';
const CELULAR = '3105550101';
const CORREO = 'maria.flujo@ejemplo.com';
const usuarios = {
  configurador: { email: 'flujo-config@kernel.test', permisos: ['READ', 'CONFIGURAR'], id: null },       // elige quién recibe las solicitudes de la web
  asesor:       { email: 'flujo-asesor@kernel.test', permisos: ['READ', 'WRITE', 'ENTREGAR'], id: null }, // las recibe y las entrega
};
const INICIO = new Date();

const login = async (quien) => {
  const ag = request.agent(app);
  await ag.post('/api/auth/login').send({ email: usuarios[quien].email, password: pass });
  return ag;
};

// Estado que se va acumulando a lo largo del recorrido
const e = { token: null, prospectoId: null, vinculacionId: null, stepup: null, embudoAntes: null, firmaHash: null };
const pub = (ruta = '') => `/api/captacion/pub/${e.token}${ruta}`;
const codigoDelCorreo = () => emailsDePrueba.at(-1).text.match(/es: (\d{6})/)[1];
const eventos = async () => (await pool.query(
  `SELECT tipo, seccion, autor_tipo FROM captacion_eventos WHERE prospecto_id = $1 ORDER BY created_at, id`, [e.prospectoId])).rows;

const limpiar = async (ids) => {
  const prospectos = `(SELECT id FROM captacion_prospectos WHERE asesor_uuid = ANY($1) OR cedula = '${CEDULA}')`;
  const vincs = `(SELECT id FROM captacion_vinculaciones WHERE prospecto_id IN ${prospectos})`;
  await pool.query(`DELETE FROM archivos WHERE entidad_id IN ${vincs} AND entidad_tipo LIKE 'captacion_%'`, [ids]);
  await pool.query(`DELETE FROM captacion_otp WHERE prospecto_id IN ${prospectos}`, [ids]);
  await pool.query(`DELETE FROM captacion_eventos WHERE prospecto_id IN ${prospectos}`, [ids]);
  await pool.query(`DELETE FROM captacion_beneficiarios WHERE vinculacion_id IN ${vincs}`, [ids]);
  await pool.query(`DELETE FROM captacion_referencias WHERE vinculacion_id IN ${vincs}`, [ids]);
  await pool.query(`DELETE FROM captacion_vinculaciones WHERE prospecto_id IN ${prospectos}`, [ids]);
  await pool.query(`DELETE FROM captacion_toques WHERE prospecto_id IN ${prospectos}`, [ids]);
  await pool.query(`DELETE FROM captacion_prospectos WHERE asesor_uuid = ANY($1) OR cedula = '${CEDULA}'`, [ids]);
};

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  for (const u of Object.values(usuarios)) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
       VALUES ('Flujo Test', $1, $2, 'asesor', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true RETURNING id`, [u.email, hash]);
    u.id = r.id;
    await pool.query(
      `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
       SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'captacion' AND a.nombre = ANY($2) ON CONFLICT DO NOTHING`,
      [u.id, u.permisos]);
  }
  await pool.query(`INSERT INTO empresas (codigo, nombre) VALUES ($1, 'Empresa Flujo Test') ON CONFLICT (codigo) DO UPDATE SET is_active = true`, [EMPRESA]);
  await pool.query(`DELETE FROM captacion_config WHERE clave = 'web_asesor_uuid'`);
  await limpiar(Object.values(usuarios).map((u) => u.id));   // por si una corrida anterior quedó a medias
});

afterAll(async () => {
  const ids = Object.values(usuarios).map((u) => u.id);
  await limpiar(ids);
  await pool.query(`DELETE FROM captacion_web_visitas WHERE created_at >= $1`, [INICIO]);
  await pool.query(`DELETE FROM captacion_config WHERE clave = 'web_asesor_uuid'`);
  await pool.query(`DELETE FROM empresas WHERE codigo = $1`, [EMPRESA]);
  await pool.query(`DELETE FROM permisos WHERE usuario_uuid = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM global_usuarios WHERE id = ANY($1)`, [ids]);
  await pool.end();
});

describe('Afiliación de principio a fin (página web → firma → entrega al asesor)', () => {
  // ── Antes de que llegue nadie ───────────────────────────────────────────────
  test('Paso 0 — la cooperativa deja lista la página: el configurador elige al asesor que recibirá las solicitudes', async () => {
    const config = await login('configurador');
    e.embudoAntes = (await config.get('/api/captacion/config/web')).body.embudo;
    const put = await config.put('/api/captacion/config/web').send({ asesor_uuid: usuarios.asesor.id });
    expect(put.status).toBe(200);
  });

  // ── La persona ──────────────────────────────────────────────────────────────
  test('Paso 1 — abre la página pública: ve las empresas y las tarifas, sin datos del asesor', async () => {
    expect((await request(app).post('/api/captacion/pub/web/visita')).status).toBe(204);
    const res = await request(app).get('/api/captacion/pub/web');
    expect(res.status).toBe(200);
    expect(res.body.disponible).toBe(true);
    expect(res.body.empresas).toContainEqual({ codigo: EMPRESA, nombre: 'Empresa Flujo Test' });
    expect(res.body.tarifas).toMatchObject({ aporte_minimo: 74000, aporte_paso: 1000, fondo_bienestar: 5300, seguro_vida: 5000, bono_sorteo: 3000, cuota_admision: 35000 });
    expect(JSON.stringify(res.body)).not.toContain(usuarios.asesor.id);
  });

  test('Paso 2 — elige su empresa y pulsa "Quiero asociarme": queda una solicitud sin identificar, asignada al asesor', async () => {
    const res = await request(app).post('/api/captacion/pub/web/iniciar').send({ empresa_codigo: EMPRESA });
    expect(res.status).toBe(201);
    e.token = res.body.token;
    expect(e.token).toHaveLength(43);

    const { rows: [p] } = await pool.query(`SELECT id, asesor_uuid, empresa_codigo, estado, acepta_habeas_data FROM captacion_prospectos WHERE token = $1`, [e.token]);
    e.prospectoId = p.id;
    expect(p).toMatchObject({ asesor_uuid: usuarios.asesor.id, empresa_codigo: EMPRESA, acepta_habeas_data: false });

    const estado = await request(app).get(pub());
    expect(estado.body).toMatchObject({ requiere_identificacion: true, requiere_habeas_data: true });
  });

  test('Paso 3 — sin autorizar el tratamiento de sus datos no se recibe nada (Ley 1581)', async () => {
    for (const r of [request(app).put(pub('/personal')).send({ nombres: 'X' }), request(app).post(pub('/otp')), request(app).post(pub('/firmar')).send({})]) {
      const res = await r;
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('HABEAS_DATA_REQUERIDO');
    }
  });

  test('Paso 4 — autoriza el tratamiento de sus datos: queda con versión, fecha y evento', async () => {
    const res = await request(app).post(pub('/habeas-data')).send({ acepta: true, version: 'hd-v1.0' });
    expect(res.status).toBe(200);
    const { rows: [p] } = await pool.query(`SELECT acepta_habeas_data FROM captacion_prospectos WHERE id = $1`, [e.prospectoId]);
    expect(p.acepta_habeas_data).toBe(true);
  });

  test('Paso 5 — se identifica y da sus datos personales: se crea la vinculación y el asesor ya puede verla', async () => {
    const res = await request(app).put(pub('/personal')).send({
      nombres: 'María', apellidos: 'Flujo Completa', cedula: CEDULA, celular: CELULAR, correo: CORREO,
      estado_civil: 'soltero', tipo_vivienda: 'arrendada', estrato: 3, genero: 'F', nivel_academico: 'Universidad',
    });
    expect(res.status).toBe(200);
    e.vinculacionId = res.body.vinculacion_id;
    expect(e.vinculacionId).toBeTruthy();

    const { rows: [p] } = await pool.query(`SELECT nombres, apellidos, cedula, celular, correo FROM captacion_prospectos WHERE id = $1`, [e.prospectoId]);
    expect(p).toEqual({ nombres: 'María', apellidos: 'Flujo Completa', cedula: CEDULA, celular: CELULAR, correo: CORREO });

    // Lo que ya dio no se le vuelve a pedir, y el enlace público no devuelve sus datos de contacto
    const estado = await request(app).get(pub());
    expect(estado.body).toMatchObject({ requiere_identificacion: false, requiere_celular: false, requiere_correo: false });
    expect(JSON.stringify(estado.body)).not.toContain(CEDULA);
    expect(JSON.stringify(estado.body)).not.toContain(CORREO);
  });

  test('Paso 6 — llena el resto del formulario: laboral, PEP/SARLAFT, situación financiera, aportes, beneficiarios y referencias', async () => {
    const put = (seccion, cuerpo) => request(app).put(pub(`/${seccion}`)).send(cuerpo);
    expect((await put('laboral', { cargo: 'Auxiliar administrativa', tipo_contrato: 'indefinido', fecha_ingreso: '2022-01-01' })).status).toBe(200);
    const pep = await put('pep', { pep_maneja_recursos_publicos: false, pep_reconocimiento_publico: false, pep_poder_publico: false, pep_vinculo_expuesto: false });
    expect(pep.status).toBe(200);
    expect(pep.body.debida_diligencia_ampliada).toBe(false);
    expect((await put('financiera', { ingresos_mensuales: 2500000, egresos_mensuales: 1800000, total_activos: 5000000, total_pasivos: 1000000, origen_fondos: 'Trabajo como empleada' })).status).toBe(200);

    // Aportes: el cliente elige, pero fondo, seguro y bono los fija el servidor
    const aportes = await put('aportes', { valor_aporte: 76000, periodicidad: 'quincenal', seguro_vida: true, bono_sorteo: false, valor_fondo_bienestar: 0 });
    expect(aportes.status).toBe(200);
    expect(aportes.body.total_mensual).toBe(76000 + 5300 + 5000);

    expect((await put('beneficiarios', { beneficiarios: [
      { orden: 1, nombres: 'Ana Flujo', porcentaje: 60, parentesco: 'Madre' },
      { orden: 2, nombres: 'Luis Flujo', porcentaje: 40, parentesco: 'Hermano' },
    ] })).status).toBe(200);
    expect((await put('referencias', { referencias: [
      { tipo: 'personal', nombres: 'Amiga Uno', celular: '3009990001' },
      { tipo: 'familiar', nombres: 'Familiar Dos', celular: '3009990002' },
    ] })).status).toBe(200);
  });

  test('Paso 7 — sube la cédula (frente y reverso): quedan registradas y la sección se marca completa', async () => {
    for (const lado of ['frente', 'reverso']) {
      const meta = { nombre: `cedula-${lado}.jpg`, mime: 'image/jpeg', size: 250000 };
      const sol = await request(app).post(pub(`/documentos/${lado}/solicitar`)).send(meta);
      expect(sol.status).toBe(200);
      expect(sol.body.key).toContain(`kernel/captacion_cedula_${lado}s/${e.vinculacionId}/`);
      const conf = await request(app).patch(pub(`/documentos/${lado}/confirmar`)).send({ key: sol.body.key, ...meta });
      expect(conf.status).toBe(200);
    }
    const { rows: [v] } = await pool.query(`SELECT seccion_documentos_at, seccion_documentos_autor, cedula_frente_id, cedula_reverso_id FROM captacion_vinculaciones WHERE id = $1`, [e.vinculacionId]);
    expect(v.seccion_documentos_at).not.toBeNull();
    expect(v.seccion_documentos_autor).toBe('prospecto');
    expect(v.cedula_frente_id).toBeTruthy();
    expect(v.cedula_reverso_id).toBeTruthy();
  });

  test('Paso 8 — antes de firmar tiene que verificar su correo: sin el código no puede firmar', async () => {
    const cuerpoFirma = { firma_png: 'data:image/png;base64,iVBORw0KGgo=', firma_trazos: [{ x: 10, y: 20, t: 100 }, { x: 15, y: 25, t: 150 }],
      version_consentimiento: 'v1.0', acepta_terminos: true, acepta_firma_electronica: true, version_firma_electronica: 'fe-v1.0' };
    e.cuerpoFirma = cuerpoFirma;
    const sinCodigo = await request(app).post(pub('/firmar')).send(cuerpoFirma);
    expect(sinCodigo.status).toBe(403);
  });

  test('Paso 9 — recibe el código en su correo (6 dígitos, sin exponerse en la respuesta) y lo confirma', async () => {
    const antes = emailsDePrueba.length;
    const otp = await request(app).post(pub('/otp'));
    expect(otp.status).toBe(200);
    expect(otp.body.correo).toMatch(/^ma\*+@ejemplo\.com$/);   // el correo se muestra enmascarado
    expect(JSON.stringify(otp.body)).not.toMatch(/\d{6}/);
    expect(emailsDePrueba.length).toBe(antes + 1);
    expect(emailsDePrueba.at(-1).to).toBe(CORREO);

    const res = await request(app).post(pub('/step-up')).send({ codigo: codigoDelCorreo() });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    e.stepup = res.body.stepup_token;
    expect(typeof e.stepup).toBe('string');
  });

  test('Paso 10 — FIRMA electrónicamente: la solicitud queda completa, sellada con hash y la persona pasa a "convertido"', async () => {
    const res = await request(app).post(pub('/firmar')).set('x-stepup-token', e.stepup).send(e.cuerpoFirma);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('solicitud_completa');

    const { rows: [p] } = await pool.query(`SELECT estado FROM captacion_prospectos WHERE id = $1`, [e.prospectoId]);
    expect(p.estado).toBe('convertido');
    const { rows: [v] } = await pool.query(`SELECT firma_doc_hash, formulario_snapshot, seccion_firma_at FROM captacion_vinculaciones WHERE id = $1`, [e.vinculacionId]);
    expect(v.firma_doc_hash).toHaveLength(64);
    e.firmaHash = v.firma_doc_hash;
    expect(v.seccion_firma_at).not.toBeNull();
    // La copia congelada de lo que firmó incluye su ficha: identificación, laboral, financiera y aportes
    // (los beneficiarios y las referencias viven en sus propias tablas y se verifican en el paso 13)
    const snap = JSON.stringify(v.formulario_snapshot);
    expect(snap).toContain(CEDULA);
    expect(snap).toContain('Auxiliar administrativa');
    expect(snap).toContain('"valor_aporte":"76000.00"');
    expect(snap).toContain('"periodicidad_descuento":"quincenal"');
  });

  test('Paso 11 — no puede firmar dos veces (409)', async () => {
    const otra = await request(app).post(pub('/firmar')).set('x-stepup-token', e.stepup).send(e.cuerpoFirma);
    expect([400, 403, 409]).toContain(otra.status);
    const { rows: [v] } = await pool.query(`SELECT firma_doc_hash FROM captacion_vinculaciones WHERE id = $1`, [e.vinculacionId]);
    expect(v.firma_doc_hash).toBe(e.firmaHash);   // el sello original no cambió
  });

  // ── El asesor ───────────────────────────────────────────────────────────────
  test('Paso 12 — el asesor ve a la persona en su lista, con origen "web", ya firmada y sin entregar', async () => {
    const ag = await login('asesor');
    const lista = await ag.get('/api/captacion/prospectos');
    const fila = lista.body.find((x) => x.cedula === CEDULA);
    expect(fila).toBeTruthy();
    expect(fila.origen).toBe('web');

    const vincs = await ag.get('/api/captacion/vinculaciones');
    const v = vincs.body.find((x) => x.id === e.vinculacionId);
    expect(v).toBeTruthy();
    expect(v.estado).not.toBe('entregada');
  });

  test('Paso 13 — el asesor revisa la solicitud completa: formulario, beneficiarios, referencias, evidencia de la firma, cédula y PDF sellado', async () => {
    const ag = await login('asesor');
    const det = await ag.get(`/api/captacion/vinculaciones/${e.vinculacionId}`);
    expect(det.status).toBe(200);
    expect(det.body.beneficiarios).toHaveLength(2);
    expect(det.body.beneficiarios.reduce((n, b) => n + Number(b.porcentaje), 0)).toBe(100);
    expect(det.body.referencias).toHaveLength(2);
    expect(det.body.firma_doc_hash).toBe(e.firmaHash);

    const docs = await ag.get(`/api/captacion/vinculaciones/${e.vinculacionId}/documentos`);
    expect(docs.status).toBe(200);
    expect(docs.body.frente).toBeTruthy();
    expect(docs.body.reverso).toBeTruthy();

    const pdf = await ag.get(`/api/captacion/vinculaciones/${e.vinculacionId}/formato`).buffer(true).parse((res, cb) => {
      const partes = []; res.on('data', (c) => partes.push(c)); res.on('end', () => cb(null, Buffer.concat(partes)));
    });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/pdf/);
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
  });

  test('Paso 14 — el asesor ENTREGA la solicitud: queda "entregada", con fecha y responsable', async () => {
    const ag = await login('asesor');
    const res = await ag.post(`/api/captacion/vinculaciones/${e.vinculacionId}/entregar`);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('entregada');
    expect(res.body.entregada_at).toBeTruthy();
    const { rows: [v] } = await pool.query(`SELECT estado, entregada_por FROM captacion_vinculaciones WHERE id = $1`, [e.vinculacionId]);
    expect(v).toEqual({ estado: 'entregada', entregada_por: usuarios.asesor.id });

    expect((await ag.post(`/api/captacion/vinculaciones/${e.vinculacionId}/entregar`)).status).toBe(400);   // no se entrega dos veces
  });

  // ── Después de la entrega ───────────────────────────────────────────────────
  test('Paso 15 — ya entregada, nadie puede modificarla: ni la persona ni el asesor', async () => {
    const bloqueada = async (r) => { const res = await r; expect([res.status, res.body.error]).toEqual([400, 'La solicitud ya fue entregada']); };
    await bloqueada(request(app).put(pub('/personal')).send({ cargo: 'x', estado_civil: 'soltero' }));
    await bloqueada(request(app).put(pub('/laboral')).send({ cargo: 'x' }));
    await bloqueada(request(app).put(pub('/financiera')).send({ origen_fondos: 'x' }));
    await bloqueada(request(app).put(pub('/beneficiarios')).send({ beneficiarios: [{ orden: 1, nombres: 'X', porcentaje: 100 }] }));
    await bloqueada(request(app).put(pub('/referencias')).send({ referencias: [{ tipo: 'personal', nombres: 'X', celular: '3000000000' }] }));
    const ag = await login('asesor');
    expect((await ag.put(`/api/captacion/vinculaciones/${e.vinculacionId}/aportes`).send({ valor_aporte: 80000, periodicidad: 'mensual', seguro_vida: false, bono_sorteo: false })).status).toBe(400);
  });

  test('Paso 16 — todo quedó trazado, en orden y sin guardar secretos', async () => {
    const tipos = (await eventos()).map((x) => x.tipo);
    const posicion = (t) => tipos.indexOf(t);
    for (const t of ['web_init', 'habeas_data_aceptado', 'seccion_guardada', 'otp_enviado', 'stepup_ok', 'firma', 'entregada']) {
      expect([t, posicion(t) >= 0]).toEqual([t, true]);
    }
    // El orden del recorrido se conserva
    expect(posicion('web_init')).toBeLessThan(posicion('habeas_data_aceptado'));
    expect(posicion('habeas_data_aceptado')).toBeLessThan(posicion('otp_enviado'));
    expect(posicion('otp_enviado')).toBeLessThan(posicion('stepup_ok'));
    expect(posicion('stepup_ok')).toBeLessThan(posicion('firma'));
    expect(posicion('firma')).toBeLessThan(tipos.lastIndexOf('entregada'));
    // Se guardaron las secciones del formulario
    const secciones = (await eventos()).filter((x) => x.tipo === 'seccion_guardada').map((x) => x.seccion);
    expect(secciones).toEqual(expect.arrayContaining(['personal', 'pep', 'aportes', 'documentos']));
    // El código del correo no se guarda en claro: solo su hash
    const { rows: [o] } = await pool.query(`SELECT codigo_hash FROM captacion_otp WHERE prospecto_id = $1 ORDER BY created_at DESC LIMIT 1`, [e.prospectoId]);
    expect(o.codigo_hash).toHaveLength(64);
  });

  test('Paso 17 — el embudo de la página lo cuenta: una visita, una que inicia, una que se identifica y una que firma', async () => {
    const config = await login('configurador');
    const despues = (await config.get('/api/captacion/config/web')).body.embudo;
    expect(despues.visitas - e.embudoAntes.visitas).toBe(1);
    expect(despues.iniciados - e.embudoAntes.iniciados).toBe(1);
    expect(despues.identificados - e.embudoAntes.identificados).toBe(1);
    expect(despues.firmados - e.embudoAntes.firmados).toBe(1);
  });
});
