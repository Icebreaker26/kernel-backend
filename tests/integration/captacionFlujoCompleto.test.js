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
import { eliminarArchivo } from '../../src/services/archivoService.js';
import { canonicalizar, sha256 } from '../../src/services/hashCanonico.js';
import { TEXTOS } from '../../src/modules/captacion/services/textosConsentimiento.js';

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
const UA = 'Mozilla/5.0 (Linux; Android 14) Kernel-Test/1.0';
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
  await pool.query(`DELETE FROM captacion_config WHERE clave IN ('web_asesor_uuid', 'exigir_validacion_voz')`);
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
    const otp = await request(app).post(pub('/otp')).set('User-Agent', UA);
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
    const res = await request(app).post(pub('/firmar')).set('x-stepup-token', e.stepup).set('User-Agent', UA).send(e.cuerpoFirma);
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

  test('Paso 10b — el hash cubre la firma (imagen y trazos) y un perito lo puede recalcular; el texto aceptado queda guardado', async () => {
    const { rows: [v] } = await pool.query(
      `SELECT firma_doc_hash, formulario_snapshot, firma_user_agent, firma_verificacion FROM captacion_vinculaciones WHERE id = $1`, [e.vinculacionId]);
    // El snapshot guardado incluye la firma dibujada, la hora, la IP y la verificación del correo
    expect(v.formulario_snapshot.firma.png).toBe(e.cuerpoFirma.firma_png);
    expect(v.formulario_snapshot.firma.trazos).toEqual(e.cuerpoFirma.firma_trazos);
    expect(v.formulario_snapshot.firma.verificacion.correo).toBe(CORREO);
    // Recalculado desde lo guardado da el mismo hash: si alguien cambia la firma, el hash deja de cuadrar
    expect(sha256(canonicalizar(v.formulario_snapshot))).toBe(v.firma_doc_hash);
    const alterado = structuredClone(v.formulario_snapshot);
    alterado.firma.png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    expect(sha256(canonicalizar(alterado))).not.toBe(v.firma_doc_hash);

    // Los tres textos que aceptó quedan íntegros e inmutables
    const { rows: textos } = await pool.query(`SELECT tipo, version, texto, hash FROM captacion_textos_consentimiento ORDER BY tipo`);
    for (const [tipo, version] of [['habeas_data', 'hd-v1.0'], ['declaracion', 'v1.0'], ['firma_electronica', 'fe-v1.0']]) {
      const t = textos.find((x) => x.tipo === tipo && x.version === version);
      expect(t.texto).toBe(TEXTOS[tipo][version]);
      expect(t.hash).toBe(sha256(TEXTOS[tipo][version]));
      expect(v.formulario_snapshot.consentimientos[tipo].hash).toBe(t.hash);
    }
    await expect(pool.query(`UPDATE captacion_textos_consentimiento SET texto = 'x' WHERE tipo = 'habeas_data'`)).rejects.toThrow(/inmutable/);
    await expect(pool.query(`DELETE FROM captacion_textos_consentimiento WHERE tipo = 'habeas_data'`)).rejects.toThrow(/inmutable/);

    // Dispositivo en la firma y en el código enviado
    expect(v.firma_user_agent).toBeTruthy();
    const { rows: [otp] } = await pool.query(`SELECT user_agent FROM captacion_otp WHERE prospecto_id = $1 ORDER BY created_at DESC LIMIT 1`, [e.prospectoId]);
    expect(otp.user_agent).toBeTruthy();
  });

  test('Paso 10c — firmada la solicitud, la persona ya no puede cambiar su identidad ni su contacto desde su enlace', async () => {
    const res = await request(app).put(pub('/personal')).send({ celular: '3200000000' });
    expect([res.status, res.body.code]).toEqual([409, 'DATOS_FIRMADOS']);
    const { rows: [p] } = await pool.query(`SELECT celular FROM captacion_prospectos WHERE id = $1`, [e.prospectoId]);
    expect(p.celular).toBe(CELULAR);
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

  test('Paso 13a — el PDF sellado es evidencia: no se puede eliminar, y si su contenido no coincide con su hash no se entrega', async () => {
    const ag = await login('asesor');
    const { rows: [v] } = await pool.query(`SELECT firma_pdf_archivo_id, firma_pdf_hash FROM captacion_vinculaciones WHERE id = $1`, [e.vinculacionId]);
    expect(v.firma_pdf_archivo_id).toBeTruthy();
    await expect(eliminarArchivo(v.firma_pdf_archivo_id, { omitirS3: true })).rejects.toMatchObject({ code: 'ARCHIVO_PROTEGIDO' });
    const { rowCount } = await pool.query(`SELECT 1 FROM archivos WHERE id = $1`, [v.firma_pdf_archivo_id]);
    expect(rowCount).toBe(1);

    const url = `/api/captacion/vinculaciones/${e.vinculacionId}/formato`;
    try {
      // Si el hash guardado ya no corresponde al archivo, no se entrega y queda registrado
      await pool.query(`UPDATE captacion_vinculaciones SET firma_pdf_hash = $2 WHERE id = $1`, [e.vinculacionId, 'f'.repeat(64)]);
      const alterado = await ag.get(url);
      expect([alterado.status, alterado.body.code]).toEqual([409, 'FORMATO_ALTERADO']);
      const { rowCount: eventos } = await pool.query(
        `SELECT 1 FROM captacion_eventos WHERE vinculacion_id = $1 AND tipo = 'formato_integridad_fallida'`, [e.vinculacionId]);
      expect(eventos).toBe(1);
    } finally {
      await pool.query(`UPDATE captacion_vinculaciones SET firma_pdf_hash = $2 WHERE id = $1`, [e.vinculacionId, v.firma_pdf_hash]);
    }
    expect((await ag.get(url)).status).toBe(200);
  });

  test('Paso 13a2 — el asesor DEVUELVE a subsanar la cédula (frente) y la firma: la persona corrige, firma de nuevo y la firma anterior queda archivada', async () => {
    const ag = await login('asesor');
    const url = `/api/captacion/vinculaciones/${e.vinculacionId}`;
    const hashViejo = e.firmaHash;
    const { rows: [antes] } = await pool.query(`SELECT firma_pdf_archivo_id FROM captacion_vinculaciones WHERE id = $1`, [e.vinculacionId]);

    // Validaciones del pedido
    expect((await ag.post(`${url}/subsanacion`).send({ items: [], motivo: 'La foto se ve borrosa' })).status).toBe(400);
    expect((await ag.post(`${url}/subsanacion`).send({ items: ['firma'], motivo: 'x' })).status).toBe(400);

    const emailsAntes = emailsDePrueba.length;
    const pide = await ag.post(`${url}/subsanacion`).send({ items: ['cedula_frente', 'firma'], motivo: 'El frente de la cédula sale borroso y la firma es una foto de otra cosa' });
    expect(pide.status).toBe(201);
    expect(pide.body).toMatchObject({ correo_enviado: true, firma_archivada: true });
    expect(pide.body.enlace).toContain(`/conocenos/${e.token}`);
    expect(emailsDePrueba.length).toBe(emailsAntes + 1);
    expect(emailsDePrueba.at(-1)).toMatchObject({ to: CORREO });
    expect(emailsDePrueba.at(-1).text).toContain('borroso');

    // Una sola devolución abierta; y mientras esté abierta no se entrega
    expect((await ag.post(`${url}/subsanacion`).send({ items: ['datos'], motivo: 'Otra cosa distinta' })).body.code).toBe('SUBSANACION_ABIERTA');
    const bloqueo = await ag.post(`${url}/entregar`);
    expect([bloqueo.status, bloqueo.body.code]).toEqual([400, 'SUBSANACION_PENDIENTE']);

    // La firma vigente se archivó (con su hash y su PDF sellado) y la solicitud quedó sin firma
    const { rows: [v1] } = await pool.query(`SELECT estado, seccion_firma_at, firma_png, firma_doc_hash FROM captacion_vinculaciones WHERE id = $1`, [e.vinculacionId]);
    expect(v1).toEqual({ estado: 'por_subsanar', seccion_firma_at: null, firma_png: null, firma_doc_hash: null });
    const { rows: hist } = await pool.query(`SELECT datos FROM captacion_firmas_historial WHERE vinculacion_id = $1`, [e.vinculacionId]);
    expect(hist).toHaveLength(1);
    expect(hist[0].datos.firma_doc_hash).toBe(hashViejo);
    expect(hist[0].datos.firma_pdf_archivo_id).toBe(antes.firma_pdf_archivo_id);
    expect((await pool.query(`SELECT 1 FROM archivos WHERE id = $1`, [antes.firma_pdf_archivo_id])).rowCount).toBe(1);   // el PDF anterior sigue existiendo

    // La persona ve qué se le pidió y por qué, y no puede dar por resuelto lo que falta
    const estado = await request(app).get(pub());
    expect(estado.body.subsanacion).toMatchObject({ items: ['cedula_frente', 'firma'], pendientes: ['cedula_frente', 'firma'] });
    expect(estado.body.subsanacion.motivo).toContain('borroso');
    const incompleta = await request(app).post(pub('/subsanacion/resolver'));
    expect([incompleta.status, incompleta.body.code, incompleta.body.pendientes]).toEqual([400, 'SUBSANACION_INCOMPLETA', ['cedula_frente', 'firma']]);

    // Sube otra foto del frente (queda como pendiente la firma)
    const meta = { nombre: 'cedula-frente-nueva.jpg', mime: 'image/jpeg', size: 260000 };
    const sol = await request(app).post(pub('/documentos/frente/solicitar')).send(meta);
    expect(sol.status).toBe(200);
    expect((await request(app).patch(pub('/documentos/frente/confirmar')).send({ key: sol.body.key, ...meta })).status).toBe(200);
    expect((await request(app).get(pub())).body.subsanacion.pendientes).toEqual(['firma']);

    // Firma de nuevo (basta con firmar; su verificación por correo sigue vigente)
    const firma = await request(app).post(pub('/firmar')).set('x-stepup-token', e.stepup).set('User-Agent', UA).send(e.cuerpoFirma);
    expect(firma.status).toBe(200);
    const { rows: [v2] } = await pool.query(`SELECT estado, firma_doc_hash, firma_pdf_archivo_id FROM captacion_vinculaciones WHERE id = $1`, [e.vinculacionId]);
    expect(v2.estado).toBe('por_subsanar');                  // sigue devuelta hasta que la persona confirme
    expect(v2.firma_doc_hash).toHaveLength(64);
    expect(v2.firma_doc_hash).not.toBe(hashViejo);           // nueva firma, nuevo hash (otra hora)
    expect(v2.firma_pdf_archivo_id).toBeTruthy();
    expect(v2.firma_pdf_archivo_id).not.toBe(antes.firma_pdf_archivo_id);
    e.firmaHash = v2.firma_doc_hash;

    // Confirma la corrección: la solicitud vuelve a estar lista y el asesor recibe el aviso
    expect((await request(app).post(pub('/subsanacion/resolver'))).status).toBe(200);
    const { rows: [v3] } = await pool.query(`SELECT estado FROM captacion_vinculaciones WHERE id = $1`, [e.vinculacionId]);
    expect(v3.estado).toBe('solicitud_completa');
    const lista = await ag.get(`${url}/subsanacion`);
    expect(lista.body.abierta).toBeNull();
    expect(lista.body.historial).toHaveLength(1);
    expect(lista.body.historial[0]).toMatchObject({ resuelta_por: 'prospecto' });
    expect(lista.body.firmas_archivadas).toBe(1);
    const { rows: tipos } = await pool.query(
      `SELECT tipo FROM captacion_eventos WHERE prospecto_id = $1 AND tipo LIKE 'subsanacion_%' ORDER BY created_at, id`, [e.prospectoId]);
    expect(tipos.map((t) => t.tipo)).toEqual(['subsanacion_solicitada', 'subsanacion_resuelta']);
  });

  test('Paso 13a3 — devolver solo los datos deja a la persona corregir su contacto aunque ya haya firmado; el asesor puede cerrarla', async () => {
    const ag = await login('asesor');
    const url = `/api/captacion/vinculaciones/${e.vinculacionId}`;
    expect((await request(app).put(pub('/personal')).send({ celular: '3200000001' })).body.code).toBe('DATOS_FIRMADOS');   // sin devolución, sigue bloqueado

    expect((await ag.post(`${url}/subsanacion`).send({ items: ['datos'], motivo: 'El celular tiene un dígito de más' })).status).toBe(201);
    const corrige = await request(app).put(pub('/personal')).send({ celular: '3105550102' });
    expect(corrige.status).toBe(200);
    expect((await pool.query(`SELECT celular FROM captacion_prospectos WHERE id = $1`, [e.prospectoId])).rows[0].celular).toBe('3105550102');

    expect((await ag.post(`${url}/subsanacion/cerrar`)).status).toBe(200);
    expect((await ag.post(`${url}/subsanacion/cerrar`)).status).toBe(404);       // ya no hay una abierta
    // Vuelve el celular original para no alterar los pasos siguientes
    await pool.query(`UPDATE captacion_prospectos SET celular = $2 WHERE id = $1`, [e.prospectoId, CELULAR]);
  });

  test('Paso 13a4 — el asesor compara con la cédula: si coincide lo confirma; si no, escribe los datos tal cual aparecen en la cédula y todo queda trazado', async () => {
    const ag = await login('asesor');
    const url = `/api/captacion/vinculaciones/${e.vinculacionId}`;
    const { rows: [antes] } = await pool.query(
      `SELECT firma_doc_hash, firma_pdf_archivo_id, firma_pdf_hash, formulario_snapshot FROM captacion_vinculaciones WHERE id = $1`, [e.vinculacionId]);

    expect((await ag.get(`${url}/correcciones`)).body).toEqual({ correcciones: [], verificacion: null });

    // Coincide tal cual: queda la confirmación (quién, cuándo y con qué valores)
    expect((await ag.post(`${url}/verificacion-identidad`)).status).toBe(201);
    const conf = (await ag.get(`${url}/correcciones`)).body.verificacion;
    expect(conf).toMatchObject({ origen: 'confirmada', cedula: CEDULA, nombres: 'María', vigente: true });

    // Datos inválidos o sin cambios
    const motivo = 'La cédula dice otro número y "María José"; se escribió mal en el formulario';
    expect((await ag.put(`${url}/identidad`).send({ cedula: 'ABC123', motivo })).status).toBe(400);
    expect((await ag.put(`${url}/identidad`).send({ cedula: '88800002' })).status).toBe(400);            // sin motivo
    expect((await ag.put(`${url}/identidad`).send({ motivo })).status).toBe(400);                          // sin qué corregir
    expect((await ag.put(`${url}/identidad`).send({ cedula: CEDULA, motivo })).status).toBe(400);          // igual a lo que ya tiene

    // Otro asesor no puede corregir una solicitud ajena
    const { rows: [otro] } = await pool.query(`SELECT 1 FROM global_usuarios WHERE id = $1`, [usuarios.configurador.id]);
    expect(otro).toBeTruthy();
    expect((await (await login('configurador')).put(`${url}/identidad`).send({ cedula: '88800002', motivo })).status).toBeGreaterThanOrEqual(403);

    // No coincide: la escribe como aparece en la cédula
    const corrige = await ag.put(`${url}/identidad`).send({ cedula: '88800002', nombres: 'María José', motivo });
    expect(corrige.status).toBe(200);
    expect(corrige.body).toMatchObject({ campos: ['cedula', 'nombres'], formato_resellado: true });
    const { rows: [p] } = await pool.query(`SELECT cedula, nombres FROM captacion_prospectos WHERE id = $1`, [e.prospectoId]);
    expect(p).toEqual({ cedula: '88800002', nombres: 'María José' });

    // Trazabilidad: valor anterior y nuevo, motivo, asesor, y una verificación "corregida" vigente
    const { correcciones, verificacion } = (await ag.get(`${url}/correcciones`)).body;
    expect(correcciones).toHaveLength(1);
    expect(correcciones[0]).toMatchObject({ antes: { cedula: CEDULA, nombres: 'María' }, despues: { cedula: '88800002', nombres: 'María José' }, motivo });
    expect(verificacion).toMatchObject({ origen: 'corregida', cedula: '88800002', nombres: 'María José', vigente: true });

    // La firma original sigue probando lo firmado (no cambia); el PDF sellado anterior se conserva y se selló uno nuevo
    const { rows: [despues] } = await pool.query(
      `SELECT firma_doc_hash, firma_pdf_archivo_id, firma_pdf_hash, formulario_snapshot FROM captacion_vinculaciones WHERE id = $1`, [e.vinculacionId]);
    expect(despues.firma_doc_hash).toBe(antes.firma_doc_hash);
    expect(despues.formulario_snapshot).toEqual(antes.formulario_snapshot);
    expect(despues.firma_pdf_archivo_id).toBeTruthy();
    expect(despues.firma_pdf_archivo_id).not.toBe(antes.firma_pdf_archivo_id);
    expect(despues.firma_pdf_hash).not.toBe(antes.firma_pdf_hash);
    expect((await pool.query(`SELECT 1 FROM archivos WHERE id = $1`, [antes.firma_pdf_archivo_id])).rowCount).toBe(1);
    const { rows: [corr] } = await pool.query(`SELECT pdf_anterior_id, pdf_anterior_hash FROM captacion_correcciones WHERE vinculacion_id = $1`, [e.vinculacionId]);
    expect(corr).toEqual({ pdf_anterior_id: antes.firma_pdf_archivo_id, pdf_anterior_hash: antes.firma_pdf_hash });
    const { rows: evs } = await pool.query(
      `SELECT tipo FROM captacion_eventos WHERE prospecto_id = $1 AND tipo IN ('identidad_corregida', 'identidad_verificada') ORDER BY created_at, id`, [e.prospectoId]);
    expect(evs.map((x) => x.tipo)).toEqual(['identidad_verificada', 'identidad_corregida']);

    // Otra solicitud con esa cédula: no se permite duplicar
    const { rows: [dup] } = await pool.query(
      `INSERT INTO captacion_prospectos (empresa_codigo, asesor_uuid, nombres, apellidos, cedula, celular, token_hash, token, acepta_habeas_data)
       VALUES ($1, $2, 'Otra', 'Persona', '88800003', '3105550103', 'h', 'tok-dup-corr', true) RETURNING id`, [EMPRESA, usuarios.asesor.id]);
    expect((await ag.put(`${url}/identidad`).send({ cedula: '88800003', motivo })).body.code).toBe('CEDULA_DUPLICADA');
    await pool.query(`DELETE FROM captacion_prospectos WHERE id = $1`, [dup.id]);

    // Se deja como estaba para los pasos siguientes
    expect((await ag.put(`${url}/identidad`).send({ cedula: CEDULA, nombres: 'María', motivo: 'Se restaura el dato original de la prueba' })).status).toBe(200);
  });

  test('Paso 13b — con la validación por voz exigida, no se entrega sin la llamada; y solo vale con el protocolo cumplido', async () => {
    const config = await login('configurador');
    expect((await config.put('/api/captacion/config/validacion-voz').send({ exigida: true })).status).toBe(200);
    const ag = await login('asesor');
    const url = `/api/captacion/vinculaciones/${e.vinculacionId}`;

    const sinLlamada = await ag.post(`${url}/entregar`);
    expect([sinLlamada.status, sinLlamada.body.code]).toEqual([400, 'VALIDACION_VOZ_REQUERIDA']);

    const info = await ag.get(`${url}/validacion-voz`);
    expect(info.body).toMatchObject({ exigida: true, validada: false, firmada: true, celular: CELULAR });
    expect(info.body.protocolo.map((q) => q.clave)).toEqual(['empresa', 'cargo', 'aporte', 'beneficiario', 'referencia']);

    // Sin contestar: queda el intento, no vale
    expect((await ag.post(`${url}/validacion-voz`).send({ resultado: 'no_contesta' })).status).toBe(201);
    // "Validada" con menos de 3 coincidencias, o sin confirmar la voluntad: se rechaza
    const pocas = await ag.post(`${url}/validacion-voz`).send({ resultado: 'validada', confirma_voluntad: true, preguntas: [{ clave: 'cargo', coincide: true }] });
    expect(pocas.status).toBe(400);
    const sinVoluntad = await ag.post(`${url}/validacion-voz`).send({ resultado: 'validada', confirma_voluntad: false,
      preguntas: ['empresa', 'cargo', 'aporte'].map((clave) => ({ clave, coincide: true })) });
    expect(sinVoluntad.status).toBe(400);
    expect((await ag.post(`${url}/entregar`)).status).toBe(400);

    // Validada de verdad
    const ok = await ag.post(`${url}/validacion-voz`).send({ resultado: 'validada', confirma_voluntad: true,
      preguntas: ['empresa', 'cargo', 'aporte', 'beneficiario'].map((clave) => ({ clave, coincide: true })), observaciones: 'Contestó de inmediato' });
    expect(ok.status).toBe(201);
    const despues = await ag.get(`${url}/validacion-voz`);
    expect(despues.body.validada).toBe(true);
    expect(despues.body.historial).toHaveLength(2);   // los intentos fallidos con parámetros inválidos no se guardan
    const { rows: evs } = await pool.query(`SELECT payload FROM captacion_eventos WHERE prospecto_id = $1 AND tipo = 'validacion_voz'`, [e.prospectoId]);
    expect(evs).toHaveLength(2);
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
    const agEntrega = await login('asesor');
    expect((await agEntrega.put(`/api/captacion/vinculaciones/${e.vinculacionId}/identidad`).send({ cedula: '88800009', motivo: 'Intento tras la entrega' })).status).toBe(400);
    expect((await agEntrega.post(`/api/captacion/vinculaciones/${e.vinculacionId}/verificacion-identidad`)).status).toBe(400);
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
