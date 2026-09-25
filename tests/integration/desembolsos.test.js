import request from 'supertest';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';

let app;
const pass = 'testpass123';
const usuarios = {
  asesor:   { email: 'desemb-asesor@kernel.test',   permisos: { creditos: ['READ', 'WRITE', 'ENTREGAR'] } },
  // Cartera que además puede revisar en Control Interno (para probar que nadie revisa lo que él mismo completó)
  cartera:  { email: 'desemb-cartera@kernel.test',  permisos: { cartera: ['READ', 'WRITE', 'CONFIGURAR'], control_interno: ['READ', 'REVISAR_CREDITOS'] } },
  ci:       { email: 'desemb-ci@kernel.test',       permisos: { control_interno: ['READ', 'REVISAR_CREDITOS'] } },
  ciLector: { email: 'desemb-cilector@kernel.test', permisos: { control_interno: ['READ'] } },
  // Aprueba en CI y además tiene permiso de pagar: no debe poder pagar lo que aprobó
  ciTes:    { email: 'desemb-cites@kernel.test',    permisos: { control_interno: ['READ', 'REVISAR_CREDITOS'], tesoreria: ['READ', 'PAGAR_CREDITOS'] } },
  tes:      { email: 'desemb-tes@kernel.test',      permisos: { tesoreria: ['READ', 'PAGAR_CREDITOS'] } },
  tesLector: { email: 'desemb-teslector@kernel.test', permisos: { tesoreria: ['READ'] } },
  nada:     { email: 'desemb-nada@kernel.test',     permisos: {} },
};
const EMPRESA = 'ZZDES-E1';
const A = { a1: '9990000001', a2: '9990000002', a3: '9990000003', a4: '9990000004', a5: '9990000005', a6: '9990000006', a7: '9990000007', a8: '9990000008', a9: '9990000009' };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pdfReal = async (paginas = 1) => { const d = await PDFDocument.create(); d.setTitle(crypto.randomUUID()); for (let i = 0; i < paginas; i++) d.addPage([400, 600]); return Buffer.from(await d.save()); };
let ag = {};
let categoriaId;
const cuentas = {};
const MES = new Date().toISOString().slice(0, 7);
const HOY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

const login = async (quien) => {
  const a = request.agent(app);
  await a.post('/api/auth/login').send({ email: usuarios[quien].email, password: pass });
  return a;
};

const CUENTA = { banco: 'Bancolombia', tipo_cuenta: 'ahorros', numero_cuenta: '12345678901', titular_nombre: 'Ana Pérez', titular_documento: '' };

// Lleva un crédito hasta "completada" (Cartera lo cierra). `cuenta` = datos bancarios (solo transferencia).
const crearCompletado = async (asociado, { forma = 'transferencia', valor = 5000000, cuenta = {}, sinCuenta = false, hastaRecibida = false } = {}) => {
  const res = await ag.asesor.post('/api/creditos').send({
    asociado_codigo: asociado, categoria_id: categoriaId, canal_origen: 'presencial', valor_solicitado: valor, cuotas: 24, cuota_mensual: 250000,
    forma_desembolso: forma, modalidad_firma: 'externa', proveedor_externo: 'Proveedor X',
  });
  expect(res.status).toBe(201);
  const id = res.body.solicitud.id;
  const b = await ag.asesor.post(`/api/creditos/${id}/documentos/borrador`).field('tipo', 'pagare').attach('archivo', await pdfReal(2), 'pagare.pdf');
  expect(b.status).toBe(201);
  expect((await ag.asesor.post(`/api/creditos/${id}/firma-externa`).field('borrador_id', b.body.id).field('proveedor', 'Proveedor X')
    .field('id_transaccion', 'TX-1').field('fecha_firma', '2026-09-20').attach('archivo', await pdfReal(2), 'firmado.pdf')).status).toBe(201);
  expect((await ag.asesor.post(`/api/creditos/${id}/documentos/adjunto`).field('tipo', 'desprendible_nomina').attach('archivo', await pdfReal(1), 'desp.pdf')).status).toBe(201);
  if (forma === 'transferencia') expect((await ag.asesor.post(`/api/creditos/${id}/documentos/adjunto`).field('tipo', 'certificado_bancario').attach('archivo', await pdfReal(1), 'cert.pdf')).status).toBe(201);
  expect((await ag.asesor.post(`/api/creditos/${id}/entregar`)).status).toBe(200);
  expect((await ag.cartera.post(`/api/cartera/${id}/recibir`)).status).toBe(200);
  if (hastaRecibida) return id;
  for (const tipo of ['comprobante_aprobacion', 'formato_estudio_credito']) {
    const original = await pdfReal(1);
    const d = await ag.cartera.post(`/api/cartera/${id}/cierre/documentos`).field('tipo', tipo).attach('archivo', original, `${tipo}.pdf`);
    expect(d.status).toBe(201);
    const firmado = await pdfReal(2);
    const { rows: [fe] } = await pool.query(
      `INSERT INTO firma_eventos (h_original, h_final, nombre_archivo, paginas, empleado_id, firmantes, final_at) VALUES ($1, $2, $3, 2, $4, $5, NOW()) RETURNING folio`,
      [sha(original), sha(firmado), d.body.nombre, usuarios.cartera.id, JSON.stringify([{ nombre: 'Asociado', tipo_doc: 'CC', num_doc: asociado, rol: 'asociado' }])]);
    expect((await ag.cartera.post(`/api/cartera/${id}/cierre/firmado`).field('folio', fe.folio).attach('archivo', firmado, 'firmado.pdf')).status).toBe(201);
  }
  const cierre = { con_aval: false, sellos: { firma: { pagina: 0, x: 0.1, y: 0.1 }, desembolso: { pagina: 0, x: 0.1, y: 0.3 } } };
  if (forma === 'transferencia' && !sinCuenta) cierre.cuenta = { ...CUENTA, titular_documento: asociado, ...cuenta };
  const g = await ag.cartera.put(`/api/cartera/${id}/cierre`).send(cierre);
  expect(g.status).toBe(200);
  const c = await ag.cartera.post(`/api/cartera/${id}/completar`);
  if (!sinCuenta) expect(c.status).toBe(200);
  return id;
};

const revisar = (id, cuerpo, quien = 'ci') => ag[quien].post(`/api/control_interno/creditos/${id}/revision`).send(cuerpo);
const detalleCI = async (id, quien = 'ci') => (await ag[quien].get(`/api/control_interno/creditos/${id}`)).body;
const todoMarcado = async (id) => Object.fromEntries((await detalleCI(id)).lista.map((i) => [i.clave, true]));
const aprobar = async (id, quien = 'ci') => revisar(id, { decision: 'aprobada', lista: await todoMarcado(id) }, quien);
const estado = async (id) => (await pool.query('SELECT estado FROM credito_solicitudes WHERE id = $1', [id])).rows[0].estado;
const ordenDe = async (id) => (await pool.query(`SELECT * FROM credito_ordenes_pago WHERE solicitud_id = $1 ORDER BY created_at DESC LIMIT 1`, [id])).rows[0];
const pagar = (ordenId, cuerpo, quien = 'tes') => ag[quien].post(`/api/tesoreria/desembolsos/${ordenId}/pagar`).send(cuerpo);
const pagoValido = (extra = {}) => ({ cuenta_origen_id: cuentas.banco.id, referencia: `REF-${crypto.randomUUID().slice(0, 8)}`, fecha_pago: HOY, ...extra });
// Crea un crédito aprobado con su orden pendiente
const conOrden = async (asociado, opts) => { const id = await crearCompletado(asociado, opts); expect((await aprobar(id)).status).toBe(200); return { id, orden: await ordenDe(id) }; };

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  for (const u of Object.values(usuarios)) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved) VALUES ('Desembolso Test', $1, $2, 'asesor', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true RETURNING id`, [u.email, hash]);
    u.id = r.id;
    for (const [modulo, acciones] of Object.entries(u.permisos)) {
      await pool.query(
        `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id) SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = $2 AND a.nombre = ANY($3) ON CONFLICT DO NOTHING`, [r.id, modulo, acciones]);
    }
  }
  await pool.query(`INSERT INTO empresas (codigo, nombre, contacto_email) VALUES ($1, 'Empresa Desembolso SA', NULL) ON CONFLICT (codigo) DO NOTHING`, [EMPRESA]);
  await pool.query(`INSERT INTO credito_config_empresa (empresa_codigo, requiere_autorizacion, momento_autorizacion) VALUES ($1, false, 'indiferente') ON CONFLICT (empresa_codigo) DO NOTHING`, [EMPRESA]);
  for (const c of Object.values(A)) {
    await pool.query(`INSERT INTO asociados (codigo, nombre, apellido, empresa_dsto, nombre_empresa, is_active) VALUES ($1, 'ANA', $2, $3, 'X', true) ON CONFLICT (codigo) DO NOTHING`, [c, `PÉREZ ${c.slice(-1)}`, EMPRESA]);
  }
  for (const [k, [nombre, tipo, activa]] of Object.entries({ banco: ['ZZ Banco Operativo', 'banco', true], caja: ['ZZ Caja Menor', 'caja', true], tarjeta: ['ZZ Tarjeta', 'tarjeta', true], inactiva: ['ZZ Banco Inactivo', 'banco', false] })) {
    cuentas[k] = (await pool.query(`INSERT INTO tesoreria_cuentas (nombre, tipo, entidad, numero, saldo_inicial, is_active) VALUES ($1, $2, 'Banco', '000', 0, $3) RETURNING id`, [nombre, tipo, activa])).rows[0];
  }
  for (const k of Object.keys(usuarios)) ag[k] = await login(k);
  categoriaId = (await ag.asesor.get('/api/creditos/categorias')).body[0].id;
});

afterAll(async () => {
  const uids = Object.values(usuarios).map((u) => u.id);
  await pool.query('ALTER TABLE credito_eventos DISABLE TRIGGER trg_credito_eventos_solo_agregar');
  await pool.query('ALTER TABLE firma_eventos DISABLE TRIGGER trg_firma_eventos_solo_agregar');
  await pool.query('ALTER TABLE credito_ordenes_pago DISABLE TRIGGER trg_credito_orden_foto_inmutable');
  try {
    const { rows: sol } = await pool.query('SELECT id FROM credito_solicitudes WHERE asesor_uuid = ANY($1)', [uids]);
    const ids = sol.map((s) => s.id);
    const { rows: ord } = await pool.query('SELECT movimiento_id FROM credito_ordenes_pago WHERE solicitud_id = ANY($1) AND movimiento_id IS NOT NULL', [ids]);
    await pool.query('DELETE FROM credito_ordenes_pago WHERE solicitud_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM tesoreria_movimientos WHERE id = ANY($1) OR registrado_por = ANY($2)', [ord.map((o) => o.movimiento_id), uids]);
    for (const t of ['credito_revisiones_ci', 'credito_cierre', 'credito_eventos', 'credito_autorizaciones', 'credito_documentos']) await pool.query(`DELETE FROM ${t} WHERE solicitud_id = ANY($1)`, [ids]);
    await pool.query('DELETE FROM credito_solicitudes WHERE id = ANY($1)', [ids]);
    await pool.query(`DELETE FROM archivos WHERE entidad_tipo LIKE 'credito_%' AND (entidad_id = ANY($1) OR subido_por = ANY($2))`, [ids, uids]);
    await pool.query('DELETE FROM firma_eventos WHERE empleado_id = ANY($1)', [uids]);
  } finally {
    await pool.query('ALTER TABLE credito_eventos ENABLE TRIGGER trg_credito_eventos_solo_agregar');
    await pool.query('ALTER TABLE firma_eventos ENABLE TRIGGER trg_firma_eventos_solo_agregar');
    await pool.query('ALTER TABLE credito_ordenes_pago ENABLE TRIGGER trg_credito_orden_foto_inmutable');
  }
  await pool.query('DELETE FROM tesoreria_periodos WHERE nombre LIKE $1', ['ZZ%']);
  await pool.query('DELETE FROM tesoreria_cuentas WHERE id = ANY($1)', [Object.values(cuentas).map((c) => c.id)]);
  await pool.query('DELETE FROM asociados WHERE codigo = ANY($1)', [Object.values(A)]);
  await pool.query('DELETE FROM credito_config_empresa WHERE empresa_codigo = $1', [EMPRESA]);
  await pool.query('DELETE FROM empresas WHERE codigo = $1', [EMPRESA]);
  await pool.query('DELETE FROM notificaciones WHERE usuario_uuid = ANY($1)', [uids]);
  await pool.query('DELETE FROM permisos WHERE usuario_uuid = ANY($1)', [uids]);
  await pool.query('DELETE FROM global_usuarios WHERE id = ANY($1)', [uids]);
  await pool.end();
});

describe('Cuenta de pago que captura Cartera', () => {
  let id;
  beforeAll(async () => { id = await crearCompletado(A.a1, { sinCuenta: true }).catch(() => null); });

  test('con transferencia, sin datos de la cuenta no se puede completar', async () => {
    // El crédito quedó en "recibida": falta la cuenta
    const { rows: [s] } = await pool.query(`SELECT id, estado FROM credito_solicitudes WHERE asociado_codigo = $1 ORDER BY created_at DESC LIMIT 1`, [A.a1]);
    id = s.id;
    expect(s.estado).toBe('recibida');
    const c = await ag.cartera.get(`/api/cartera/${id}/cierre`);
    expect(c.body.faltantes.join(' | ')).toMatch(/cuenta bancaria del asociado/);
    expect((await ag.cartera.post(`/api/cartera/${id}/completar`)).status).toBe(409);
  });

  test.each([
    ['banco vacío', { banco: '' }], ['número corto', { numero_cuenta: '123' }], ['número con letras', { numero_cuenta: '12AB5678' }],
    ['tipo inválido', { tipo_cuenta: 'nomina' }], ['sin titular', { titular_nombre: '' }], ['documento inválido', { titular_documento: '1' }],
  ])('rechaza %s (400)', async (_, malo) => {
    const r = await ag.cartera.put(`/api/cartera/${id}/cierre`).send({ con_aval: false, cuenta: { ...CUENTA, titular_documento: A.a1, ...malo } });
    expect(r.status).toBe(400);
  });

  test('guarda la cuenta normalizada (nombre en mayúsculas, número y documento sin espacios ni guiones)', async () => {
    const r = await ag.cartera.put(`/api/cartera/${id}/cierre`).send({ con_aval: false, cuenta: { banco: 'Bancolombia', tipo_cuenta: 'ahorros', numero_cuenta: '123 4567-8901', titular_nombre: '  ana   pérez ', titular_documento: '9.990.000-001' } });
    expect(r.status).toBe(200);
    expect(r.body.cierre).toMatchObject({ banco: 'Bancolombia', tipo_cuenta: 'ahorros', numero_cuenta: '12345678901', titular_nombre: 'ANA PÉREZ', titular_documento: '9990000001' });
  });

  test('guardar sin `cuenta` conserva la ya capturada', async () => {
    const r = await ag.cartera.put(`/api/cartera/${id}/cierre`).send({ con_aval: false });
    expect(r.body.cierre.numero_cuenta).toBe('12345678901');
  });

  test('el historial guarda solo los últimos 4 dígitos, nunca el número completo', async () => {
    const { rows } = await pool.query(`SELECT detalle FROM credito_eventos WHERE solicitud_id = $1 AND tipo = 'cartera_cuenta_registrada' ORDER BY created_at DESC`, [id]);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows[0].detalle)).toContain('8901');
    expect(JSON.stringify(rows[0].detalle)).not.toContain('12345678901');
  });

  test('un cheque o efectivo no lleva cuenta (400)', async () => {
    const otro = await crearCompletado(A.a2, { forma: 'cheque', hastaRecibida: true });
    const r = await ag.cartera.put(`/api/cartera/${otro}/cierre`).send({ con_aval: false, cuenta: { ...CUENTA, titular_documento: A.a2 } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no lleva cuenta bancaria/);
  });
});

describe('Control Interno — revisión', () => {
  let id;
  beforeAll(async () => { id = await crearCompletado(A.a3); });

  test('exige sesión y permisos', async () => {
    expect((await request(app).get(`/api/control_interno/creditos/${id}`)).status).toBe(401);
    expect((await ag.nada.get(`/api/control_interno/creditos/${id}`)).status).toBe(403);
    expect((await ag.ciLector.post(`/api/control_interno/creditos/${id}/revision`).send({ decision: 'devuelta', destino: 'cartera', motivo: 'x x x' })).status).toBe(403);
    expect((await ag.ci.get('/api/control_interno/creditos/no-es-uuid')).status).toBe(404);
  });

  test('el detalle muestra asociado, valores, cuenta y la lista de verificación que aplica', async () => {
    const d = await detalleCI(id);
    expect(d).toMatchObject({ radicado: expect.stringMatching(/^CR-/), estado: 'completada', forma_desembolso: 'transferencia', puede_revisar: true });
    expect(d.asociado).toEqual({ codigo: A.a3, nombre: 'ANA PÉREZ 3' });
    expect(d.valores).toMatchObject({ valor_solicitado: 5000000, aval_valor: 0, firma_electronica_valor: expect.any(Number) });
    expect(d.cuenta).toMatchObject({ banco: 'Bancolombia', tipo_cuenta: 'ahorros', numero_cuenta: '12345678901', titular_documento: A.a3, titular_es_asociado: true });
    expect(d.lista.map((i) => i.clave)).toEqual(['documentos', 'valores', 'datos_bancarios']);   // la empresa no exige autorización
    expect(d.documentos.some((x) => x.tipo === 'comprobante_aprobacion' && x.etapa === 'cartera')).toBe(true);
  });

  test('el detalle trae lo necesario para mostrar el avance: fechas de cada etapa, asesor y datos de cada documento', async () => {
    const d = await detalleCI(id);
    expect(d).toMatchObject({ asesor_nombre: expect.any(String), entregada_at: expect.any(String), recibida_at: expect.any(String), radicada_at: expect.any(String), completada_at: expect.any(String) });
    expect(new Date(d.entregada_at) <= new Date(d.recibida_at)).toBe(true);
    expect(new Date(d.recibida_at) <= new Date(d.completada_at)).toBe(true);
    const doc = d.documentos.find((x) => x.tipo === 'comprobante_aprobacion');
    expect(doc).toMatchObject({ mime_type: 'application/pdf', size_bytes: expect.any(Number), subido_por_nombre: expect.any(String) });
  });

  test('si el titular no es el asociado se agrega la confirmación de tercero y se marca', async () => {
    const otro = await crearCompletado(A.a4, { cuenta: { titular_documento: '1234567', titular_nombre: 'Luis Ruiz' } });
    const d = await detalleCI(otro);
    expect(d.cuenta.titular_es_asociado).toBe(false);
    expect(d.lista.map((i) => i.clave)).toContain('titular_tercero');
  });

  test('con cheque no hay cuenta ni ítem de datos bancarios', async () => {
    const ch = await crearCompletado(A.a5, { forma: 'cheque' });
    const d = await detalleCI(ch);
    expect(d.cuenta).toBeNull();
    expect(d.lista.map((i) => i.clave)).toEqual(['documentos', 'valores']);
  });

  test('quien completó el crédito en Cartera no lo puede revisar', async () => {
    const d = await detalleCI(id, 'cartera');
    expect(d.puede_revisar).toBe(false);
    expect(d.motivo_bloqueo).toMatch(/otra persona/);
    expect((await revisar(id, { decision: 'aprobada', lista: await todoMarcado(id) }, 'cartera')).status).toBe(403);
    expect(await estado(id)).toBe('completada');
  });

  test('no se aprueba si falta marcar algún ítem, y dice cuáles', async () => {
    const lista = await todoMarcado(id);
    lista.datos_bancarios = false;
    const r = await revisar(id, { decision: 'aprobada', lista });
    expect(r.status).toBe(400);
    expect(r.body.faltantes).toEqual(['datos_bancarios']);
    expect((await revisar(id, { decision: 'aprobada' })).status).toBe(400);   // sin lista
    expect(await estado(id)).toBe('completada');
  });

  test('para aprobar un titular tercero hay que confirmar expresamente', async () => {
    const otro = (await pool.query(`SELECT id FROM credito_solicitudes WHERE asociado_codigo = $1`, [A.a4])).rows[0].id;
    const lista = await todoMarcado(otro);
    delete lista.titular_tercero;
    expect((await revisar(otro, { decision: 'aprobada', lista })).body.faltantes).toEqual(['titular_tercero']);
  });

  test('devolver exige destino y motivo; rechaza campos de más', async () => {
    expect((await revisar(id, { decision: 'devuelta', motivo: 'Falta algo' })).status).toBe(400);
    expect((await revisar(id, { decision: 'devuelta', destino: 'cartera' })).status).toBe(400);
    expect((await revisar(id, { decision: 'devuelta', destino: 'cartera', motivo: 'x' })).status).toBe(400);
    expect((await revisar(id, { decision: 'devuelta', destino: 'cielo', motivo: 'Falta algo' })).status).toBe(400);
    expect((await revisar(id, { decision: 'devuelta', destino: 'cartera', motivo: 'Falta algo', extra: 1 })).status).toBe(400);
  });

  test('devolver a Cartera: vuelve a "recibida", se limpia el monto y Cartera puede cerrar de nuevo', async () => {
    const r = await revisar(id, { decision: 'devuelta', destino: 'cartera', motivo: 'El número de cuenta no coincide con el certificado' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: 'recibida', orden_id: null });
    const { rows: [s] } = await pool.query('SELECT estado, monto_desembolso, completada_at, completada_por FROM credito_solicitudes WHERE id = $1', [id]);
    expect(s).toMatchObject({ estado: 'recibida', monto_desembolso: null, completada_at: null, completada_por: null });
    expect((await pool.query(`SELECT 1 FROM credito_ordenes_pago WHERE solicitud_id = $1`, [id])).rowCount).toBe(0);
    const { rows: [rev] } = await pool.query('SELECT decision, destino, motivo FROM credito_revisiones_ci WHERE solicitud_id = $1', [id]);
    expect(rev).toMatchObject({ decision: 'devuelta', destino: 'cartera', motivo: 'El número de cuenta no coincide con el certificado' });
    expect((await pool.query(`SELECT 1 FROM credito_eventos WHERE solicitud_id = $1 AND tipo = 'devuelta_por_control_interno'`, [id])).rowCount).toBe(1);
    // Cartera corrige la cuenta y vuelve a completar
    expect((await ag.cartera.put(`/api/cartera/${id}/cierre`).send({ con_aval: false, cuenta: { ...CUENTA, numero_cuenta: '99998888777', titular_documento: A.a3 } })).status).toBe(200);
    expect((await ag.cartera.post(`/api/cartera/${id}/completar`)).status).toBe(200);
    expect((await detalleCI(id)).cuenta.numero_cuenta).toBe('99998888777');
    expect((await detalleCI(id)).revisiones).toHaveLength(1);
  });

  test('devolver al asesor: queda "devuelta" con el motivo visible para él', async () => {
    const r = await revisar(id, { decision: 'devuelta', destino: 'asesor', motivo: 'Falta la firma en la libranza' });
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('devuelta');
    const d = (await ag.asesor.get(`/api/creditos/${id}`)).body;
    expect(d.solicitud).toMatchObject({ estado: 'devuelta', devuelta_motivo: 'Falta la firma en la libranza' });
    expect((await pool.query(`SELECT 1 FROM notificaciones WHERE usuario_uuid = $1 AND mensaje ILIKE '%devolvió%'`, [usuarios.asesor.id])).rowCount).toBeGreaterThan(0);
  });

  test('un crédito que ya no está en Control Interno no se puede revisar (409)', async () => {
    expect((await revisar(id, { decision: 'devuelta', destino: 'cartera', motivo: 'Otra vez' })).status).toBe(409);
    expect((await ag.ci.get(`/api/control_interno/creditos/${id}`)).status).toBe(404);   // devuelta: ya no está en Control Interno
  });

  test('el certificado bancario se abre por un enlace temporal; sin certificado da 404', async () => {
    const ok = await ag.ci.get(`/api/control_interno/creditos/${(await pool.query(`SELECT id FROM credito_solicitudes WHERE asociado_codigo = $1`, [A.a4])).rows[0].id}/certificado`);
    expect(ok.status).toBe(200);
    expect(ok.body.url).toEqual(expect.any(String));
    const ch = (await pool.query(`SELECT id FROM credito_solicitudes WHERE asociado_codigo = $1`, [A.a5])).rows[0].id;
    expect((await ag.ci.get(`/api/control_interno/creditos/${ch}/certificado`)).status).toBe(404);
  });
});

describe('Control Interno — aprobación y orden de pago', () => {
  let id; let orden;
  beforeAll(async () => { ({ id, orden } = await conOrden(A.a6)); });

  test('aprobar pasa el crédito a Tesorería y crea la orden con la foto exacta', async () => {
    expect(await estado(id)).toBe('en_tesoreria');
    expect(orden).toMatchObject({
      estado: 'pendiente', radicado: expect.stringMatching(/^CR-/), asociado_codigo: A.a6, asociado_nombre: 'ANA PÉREZ 6', forma_pago: 'transferencia',
      banco: 'Bancolombia', tipo_cuenta: 'ahorros', numero_cuenta: '12345678901', titular_nombre: 'ANA PÉREZ', titular_documento: A.a6, titular_es_asociado: true, aprobada_por: usuarios.ci.id,
    });
    expect(Number(orden.monto)).toBe(Number((await pool.query('SELECT desembolso_neto FROM credito_cierre WHERE solicitud_id = $1', [id])).rows[0].desembolso_neto));
    expect(orden.huella).toMatch(/^[0-9a-f]{64}$/);
    const rev = (await pool.query(`SELECT decision, lista FROM credito_revisiones_ci WHERE solicitud_id = $1`, [id])).rows[0];
    expect(rev.decision).toBe('aprobada');
    expect(rev.lista).toMatchObject({ documentos: true, valores: true, datos_bancarios: true });
  });

  test('aprobar dos veces no duplica la orden (409)', async () => {
    expect((await revisar(id, { decision: 'aprobada', lista: { documentos: true, valores: true, datos_bancarios: true } })).status).toBe(409);
    expect((await pool.query(`SELECT 1 FROM credito_ordenes_pago WHERE solicitud_id = $1`, [id])).rowCount).toBe(1);
  });

  test('avisa a Tesorería y al asesor', async () => {
    expect((await pool.query(`SELECT 1 FROM notificaciones WHERE usuario_uuid = $1 AND mensaje ILIKE '%Desembolso por pagar%'`, [usuarios.tes.id])).rowCount).toBeGreaterThan(0);
    expect((await pool.query(`SELECT 1 FROM notificaciones WHERE usuario_uuid = $1 AND mensaje ILIKE '%aprobó%'`, [usuarios.asesor.id])).rowCount).toBeGreaterThan(0);
  });

  test('la foto de la orden no se puede modificar ni borrar en la base (trigger)', async () => {
    for (const campo of ['monto = monto + 1', "numero_cuenta = '000'", "titular_nombre = 'OTRO'", "asociado_codigo = 'X'", "huella = repeat('a', 64)"]) {
      await expect(pool.query(`UPDATE credito_ordenes_pago SET ${campo} WHERE id = $1`, [orden.id])).rejects.toThrow(/no se puede modificar/);
    }
    await expect(pool.query('DELETE FROM credito_ordenes_pago WHERE id = $1', [orden.id])).rejects.toThrow(/no se borran/);
  });

  test('a lo sumo una orden viva por crédito (índice único)', async () => {
    await expect(pool.query(
      `INSERT INTO credito_ordenes_pago (solicitud_id, radicado, asociado_codigo, asociado_nombre, forma_pago, monto, titular_es_asociado, huella)
       VALUES ($1, 'X', 'X', 'X', 'efectivo', 1, true, repeat('a', 64))`, [id])).rejects.toThrow(/uq_credito_orden_viva/);
  });
});

describe('Tesorería — lista de desembolsos', () => {
  let id; let orden;
  beforeAll(async () => { ({ id, orden } = await conOrden(A.a7)); });

  test('exige permiso', async () => {
    expect((await request(app).get('/api/tesoreria/desembolsos')).status).toBe(401);
    expect((await ag.nada.get('/api/tesoreria/desembolsos')).status).toBe(403);
    expect((await ag.tes.get('/api/tesoreria/desembolsos?estado=raro')).status).toBe(400);
  });

  test('cada orden trae lo necesario para pagar sin dudas: asociado, cédula, cuenta, titular y monto', async () => {
    const r = await ag.tesLector.get('/api/tesoreria/desembolsos');
    expect(r.status).toBe(200);
    const o = r.body.find((x) => x.id === orden.id);
    expect(o).toMatchObject({
      radicado: orden.radicado, asociado_codigo: A.a7, asociado_nombre: 'ANA PÉREZ 7', forma_pago: 'transferencia', banco: 'Bancolombia', tipo_cuenta: 'ahorros',
      numero_cuenta: '12345678901', titular_nombre: 'ANA PÉREZ', titular_documento: A.a7, titular_es_asociado: true, estado: 'pendiente', aprobada_por_nombre: 'Desembolso Test',
    });
    expect(Number(o.monto)).toBeGreaterThan(0);
  });

  test('las pestañas separan pendientes, pagadas y anuladas', async () => {
    expect((await ag.tes.get('/api/tesoreria/desembolsos?estado=pagada')).body.some((x) => x.id === orden.id)).toBe(false);
    expect((await ag.tes.get('/api/tesoreria/desembolsos?estado=anulada')).body.some((x) => x.id === orden.id)).toBe(false);
    expect((await ag.tes.get('/api/tesoreria/desembolsos?estado=pendiente')).body.some((x) => x.id === orden.id)).toBe(true);
  });
});

describe('Tesorería — pagar', () => {
  let id; let orden;
  beforeAll(async () => { ({ id, orden } = await conOrden(A.a8)); });

  test('exige el permiso de pagar (leer no basta)', async () => {
    expect((await pagar(orden.id, pagoValido(), 'tesLector')).status).toBe(403);
    expect((await pagar(orden.id, pagoValido(), 'nada')).status).toBe(403);
    expect((await ag.tes.post('/api/tesoreria/desembolsos/no-es-uuid/pagar').send(pagoValido())).status).toBe(404);
  });

  test('quien aprobó en Control Interno no puede pagar lo que aprobó', async () => {
    const propio = await conOrdenPor('ciTes', A.a9);
    const r = await pagar(propio.orden.id, pagoValido(), 'ciTes');
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/aprobaste/);
    expect((await pool.query('SELECT estado FROM credito_ordenes_pago WHERE id = $1', [propio.orden.id])).rows[0].estado).toBe('pendiente');
  });

  test.each([
    ['sin cuenta de origen', { cuenta_origen_id: undefined }],
    ['cuenta que no es uuid', { cuenta_origen_id: 'abc' }],
    ['referencia corta', { referencia: 'x' }],
    ['sin referencia', { referencia: undefined }],
    ['fecha inválida', { fecha_pago: '24/09/2026' }],
    ['campos de más', { monto: 1 }],
  ])('rechaza %s (400)', async (_, malo) => {
    expect((await pagar(orden.id, { ...pagoValido(), ...malo })).status).toBe(400);
  });

  test('no se paga con una cuenta inexistente, inactiva, de tarjeta o de caja (transferencia)', async () => {
    expect((await pagar(orden.id, pagoValido({ cuenta_origen_id: crypto.randomUUID() }))).status).toBe(400);
    expect((await pagar(orden.id, pagoValido({ cuenta_origen_id: cuentas.inactiva.id }))).status).toBe(400);
    expect((await pagar(orden.id, pagoValido({ cuenta_origen_id: cuentas.tarjeta.id }))).status).toBe(400);
    const r = await pagar(orden.id, pagoValido({ cuenta_origen_id: cuentas.caja.id }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/cuenta bancaria/);
  });

  test('no acepta una fecha futura', async () => {
    const manana = new Date(Date.now() + 2 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    expect((await pagar(orden.id, pagoValido({ fecha_pago: manana }))).status).toBe(400);
  });

  test('no acepta una fecha anterior a la aprobación de Control Interno (no se paga antes de aprobar)', async () => {
    const antes = new Date(Date.now() - 3 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const r = await pagar(orden.id, pagoValido({ fecha_pago: antes }));
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/anterior a la aprobación de Control Interno/);
    expect((await pool.query('SELECT estado FROM credito_ordenes_pago WHERE id = $1', [orden.id])).rows[0].estado).toBe('pendiente');
  });

  test('no se paga en un período contable cerrado', async () => {
    const { rows: [p] } = await pool.query(`INSERT INTO tesoreria_periodos (nombre, fecha_inicio, fecha_fin, estado) VALUES ('ZZ cerrado', $1, $1, 'cerrado') RETURNING id`, [HOY]);
    const r = await pagar(orden.id, pagoValido());
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/cerrado/);
    await pool.query('DELETE FROM tesoreria_periodos WHERE id = $1', [p.id]);
  });

  test('si la foto de la orden fue alterada en la base, NO se paga', async () => {
    await pool.query('ALTER TABLE credito_ordenes_pago DISABLE TRIGGER trg_credito_orden_foto_inmutable');
    try {
      await pool.query(`UPDATE credito_ordenes_pago SET numero_cuenta = '55555555555' WHERE id = $1`, [orden.id]);
      const r = await pagar(orden.id, pagoValido());
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/no coinciden con lo aprobado/);
    } finally {
      await pool.query(`UPDATE credito_ordenes_pago SET numero_cuenta = '12345678901' WHERE id = $1`, [orden.id]);
      await pool.query('ALTER TABLE credito_ordenes_pago ENABLE TRIGGER trg_credito_orden_foto_inmutable');
    }
    expect(await estado(id)).toBe('en_tesoreria');
  });

  test('paga: registra el egreso, cierra la orden y deja el crédito pagado', async () => {
    const cuerpo = pagoValido({ referencia: 'TRF-000123' });
    const r = await pagar(orden.id, cuerpo);
    expect(r.status).toBe(200);
    expect(r.body.movimiento_id).toEqual(expect.any(String));
    expect(await estado(id)).toBe('pagada');
    const o = await ordenDe(id);
    expect(o).toMatchObject({ estado: 'pagada', referencia_pago: 'TRF-000123', cuenta_origen_id: cuentas.banco.id, pagada_por: usuarios.tes.id, movimiento_id: r.body.movimiento_id });
    const { rows: [m] } = await pool.query('SELECT * FROM tesoreria_movimientos WHERE id = $1', [r.body.movimiento_id]);
    expect(m).toMatchObject({ tipo: 'egreso', cuenta_id: cuentas.banco.id, referencia: 'TRF-000123', tercero_nombre: 'ANA PÉREZ 8', registrado_por: usuarios.tes.id });
    expect(Number(m.monto)).toBe(Number(o.monto));
    expect(m.descripcion).toContain(o.radicado);
    expect(m.descripcion).toContain(A.a8);
    expect(m.descripcion).toContain('****8901');
    expect(m.descripcion).not.toContain('12345678901');   // el número completo no viaja a la descripción del movimiento
    const cat = (await pool.query('SELECT nombre FROM tesoreria_categorias WHERE id = $1', [m.categoria_id])).rows[0];
    expect(cat.nombre).toBe('Desembolso de crédito');
    expect((await pool.query(`SELECT 1 FROM credito_eventos WHERE solicitud_id = $1 AND tipo = 'desembolso_pagado'`, [id])).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM notificaciones WHERE usuario_uuid = $1 AND mensaje ILIKE '%pagó el desembolso%'`, [usuarios.asesor.id])).rowCount).toBeGreaterThan(0);
  });

  test('los reportes mensuales de Cartera siguen incluyendo el crédito después de pagado', async () => {
    const r = await ag.cartera.get(`/api/cartera/reportes/firmas-electronicas?mes=${MES}`);
    expect(r.status).toBe(200);
    expect(r.body.filas.some((f) => f.cedula === A.a8)).toBe(true);
  });

  test('una orden pagada no se vuelve a pagar (409) ni se devuelve', async () => {
    expect((await pagar(orden.id, pagoValido())).status).toBe(409);
    expect((await ag.tes.post(`/api/tesoreria/desembolsos/${orden.id}/devolver`).send({ motivo: 'Ya pagada' })).status).toBe(409);
    expect((await pool.query(`SELECT count(*)::int AS n FROM tesoreria_movimientos WHERE referencia = 'TRF-000123'`)).rows[0].n).toBe(1);
  });

  test('aparece en la pestaña de pagadas con quién pagó y desde qué cuenta', async () => {
    const o = (await ag.tes.get('/api/tesoreria/desembolsos?estado=pagada')).body.find((x) => x.id === orden.id);
    expect(o).toMatchObject({ estado: 'pagada', referencia_pago: 'TRF-000123', cuenta_origen_nombre: 'ZZ Banco Operativo', pagada_por_nombre: 'Desembolso Test' });
  });

  test('la misma referencia no se puede usar dos veces desde la misma cuenta', async () => {
    const otro = await conOrden(A.a1, { forma: 'transferencia' });
    const r = await pagar(otro.orden.id, pagoValido({ referencia: 'trf-000123' }));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/referencia/);
    expect((await pagar(otro.orden.id, pagoValido({ referencia: 'TRF-000124' }))).status).toBe(200);
  });

  test('efectivo sale de una caja y cheque de una cuenta bancaria', async () => {
    const ef = await conOrden(A.a2, { forma: 'efectivo' });
    expect((await pagar(ef.orden.id, pagoValido({ cuenta_origen_id: cuentas.caja.id }))).status).toBe(200);
    const ch = await conOrden(A.a3, { forma: 'cheque' });
    expect((await pagar(ch.orden.id, pagoValido({ cuenta_origen_id: cuentas.caja.id }))).status).toBe(400);
    expect((await pagar(ch.orden.id, pagoValido())).status).toBe(200);
    const m = (await pool.query('SELECT descripcion FROM tesoreria_movimientos WHERE id = $1', [(await ordenDe(ef.id)).movimiento_id])).rows[0];
    expect(m.descripcion).toContain('en efectivo');
  });
});

describe('Tesorería — devolver a Control Interno', () => {
  let id; let orden;
  beforeAll(async () => { ({ id, orden } = await conOrden(A.a4, { cuenta: { titular_documento: A.a4 } })); });

  test('exige permiso de pagar y un motivo', async () => {
    expect((await ag.tesLector.post(`/api/tesoreria/desembolsos/${orden.id}/devolver`).send({ motivo: 'Algo raro' })).status).toBe(403);
    expect((await ag.tes.post(`/api/tesoreria/desembolsos/${orden.id}/devolver`).send({})).status).toBe(400);
    expect((await ag.tes.post(`/api/tesoreria/desembolsos/${orden.id}/devolver`).send({ motivo: 'x' })).status).toBe(400);
  });

  test('anula la orden, el crédito vuelve a Control Interno y se avisa', async () => {
    const r = await ag.tes.post(`/api/tesoreria/desembolsos/${orden.id}/devolver`).send({ motivo: 'El banco rechazó la cuenta' });
    expect(r.status).toBe(200);
    expect(await estado(id)).toBe('completada');
    const o = (await pool.query('SELECT estado, anulada_motivo FROM credito_ordenes_pago WHERE id = $1', [orden.id])).rows[0];
    expect(o).toMatchObject({ estado: 'anulada', anulada_motivo: 'El banco rechazó la cuenta' });
    expect((await ag.tes.get('/api/tesoreria/desembolsos?estado=anulada')).body.some((x) => x.id === orden.id)).toBe(true);
    expect((await pool.query(`SELECT 1 FROM notificaciones WHERE usuario_uuid = $1 AND mensaje ILIKE '%Tesorería devolvió%'`, [usuarios.ci.id])).rowCount).toBeGreaterThan(0);
    expect((await pagar(orden.id, pagoValido())).status).toBe(409);   // la orden anulada no se paga
  });

  test('Control Interno puede revisar de nuevo y se crea una orden nueva', async () => {
    const otro = await aprobar(id, 'ciTes');
    expect(otro.status).toBe(200);
    const vivas = (await pool.query(`SELECT estado FROM credito_ordenes_pago WHERE solicitud_id = $1 ORDER BY created_at`, [id])).rows.map((x) => x.estado);
    expect(vivas).toEqual(['anulada', 'pendiente']);
    expect(await estado(id)).toBe('en_tesoreria');
  });
});

// Igual que conOrden pero aprueba un usuario concreto de Control Interno
async function conOrdenPor(quien, asociado) {
  const id = await crearCompletado(asociado);
  expect((await aprobar(id, quien)).status).toBe(200);
  return { id, orden: await ordenDe(id) };
}
