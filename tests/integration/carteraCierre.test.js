import request from 'supertest';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';

let app;
const pass = 'testpass123';
const usuarios = {
  asesor:   { email: 'cierre-asesor@kernel.test',  permisos: { creditos: ['READ', 'WRITE', 'ENTREGAR'] } },
  cartera:  { email: 'cierre-cartera@kernel.test', permisos: { cartera: ['READ', 'WRITE', 'CONFIGURAR'] } },
  cartera2: { email: 'cierre-cartera2@kernel.test', permisos: { cartera: ['READ', 'WRITE'] } },
  lector:   { email: 'cierre-lector@kernel.test',  permisos: { cartera: ['READ'] } },
  ci:       { email: 'cierre-ci@kernel.test',      permisos: { control_interno: ['READ'] } },
  nada:     { email: 'cierre-nada@kernel.test',    permisos: {} },
};
const EMPRESA = 'ZZCIE-E1';
const A = { a1: 'ZZCIE001', a2: 'ZZCIE002', a3: 'ZZCIE003', a4: 'ZZCIE004', a5: 'ZZCIE005', a6: 'ZZCIE006' };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// Cada PDF es distinto (título único): pdf-lib solo marca la fecha al segundo y dos PDF en blanco saldrían idénticos
const pdfReal = async (paginas = 1) => { const d = await PDFDocument.create(); d.setTitle(crypto.randomUUID()); for (let i = 0; i < paginas; i++) d.addPage([400, 600]); return Buffer.from(await d.save()); };
let tarifaOriginal;
let ag = {};
let categoriaId;

const login = async (quien) => {
  const a = request.agent(app);
  await a.post('/api/auth/login').send({ email: usuarios[quien].email, password: pass });
  return a;
};

// Deja una solicitud en estado "recibida" (firma externa, sin autorización de empresa, desembolso por cheque)
const llegarARecibida = async (asociado, { certificado, ...extra } = {}) => {
  const res = await ag.asesor.post('/api/creditos').send({
    asociado_codigo: asociado, categoria_id: categoriaId, canal_origen: 'presencial', valor_solicitado: 5000000,
    cuotas: 24, cuota_mensual: 250000, forma_desembolso: 'cheque', modalidad_firma: 'externa', proveedor_externo: 'Proveedor X', ...extra,
  });
  expect([res.status, res.body.error]).toEqual([201, undefined]);   // si falla, se ve el motivo y no solo el código
  const id = res.body.solicitud.id;
  const b = await ag.asesor.post(`/api/creditos/${id}/documentos/borrador`).field('tipo', 'pagare').attach('archivo', await pdfReal(2), 'pagare.pdf');
  expect(b.status).toBe(201);
  expect((await ag.asesor.post(`/api/creditos/${id}/firma-externa`).field('borrador_id', b.body.id).field('proveedor', 'Proveedor X')
    .field('id_transaccion', 'TX-1').field('fecha_firma', '2026-09-20').attach('archivo', await pdfReal(2), 'firmado.pdf')).status).toBe(201);
  expect((await ag.asesor.post(`/api/creditos/${id}/documentos/adjunto`).field('tipo', 'desprendible_nomina').attach('archivo', await pdfReal(1), 'desp.pdf')).status).toBe(201);
  if (certificado) expect((await ag.asesor.post(`/api/creditos/${id}/documentos/adjunto`).field('tipo', 'certificado_bancario').attach('archivo', certificado, certificado[0] === 0x89 ? 'certificado.png' : 'certificado.pdf')).status).toBe(201);
  expect((await ag.asesor.post(`/api/creditos/${id}/entregar`)).status).toBe(200);
  expect((await ag.cartera.post(`/api/cartera/${id}/recibir`)).status).toBe(200);
  return id;
};

// Sube un documento de Cartera y lo "firma" con el motor (se simula el registro del folio que produce el motor)
const subirCartera = async (id, tipo, quien = 'cartera') => {
  const buf = await pdfReal(1);
  const res = await ag[quien].post(`/api/cartera/${id}/cierre/documentos`).field('tipo', tipo).attach('archivo', buf, `${tipo}.pdf`);
  return { res, buf };
};
// `quien` firma en el motor (dueño del folio); `envia` es quien lo registra en el expediente (por defecto el mismo)
const firmarCartera = async (id, doc, buf, { asociado, quien = 'cartera', envia = quien, hFinal } = {}) => {
  const firmado = await pdfReal(2);   // el PDF que devuelve el motor (borrador + constancia)
  const { rows: [fe] } = await pool.query(
    `INSERT INTO firma_eventos (h_original, h_final, nombre_archivo, paginas, empleado_id, firmantes, final_at) VALUES ($1, $2, $3, 2, $4, $5, NOW()) RETURNING folio`,
    [sha(buf), hFinal ?? sha(firmado), doc.nombre, usuarios[quien].id, JSON.stringify([{ nombre: 'Asociado', tipo_doc: 'CC', num_doc: asociado, rol: 'asociado' }])]);
  const res = await ag[envia].post(`/api/cartera/${id}/cierre/firmado`).field('folio', fe.folio).attach('archivo', firmado, 'firmado.pdf');
  return { res, firmado, folio: fe.folio };
};
const prepararDocs = async (id, asociado) => {
  for (const tipo of ['comprobante_aprobacion', 'formato_estudio_credito']) {
    const { res, buf } = await subirCartera(id, tipo);
    expect(res.status).toBe(201);
    expect((await firmarCartera(id, res.body, buf, { asociado })).res.status).toBe(201);
  }
};
const sellos = { aval: { pagina: 0, x: 0.1, y: 0.1 }, firma: { pagina: 0, x: 0.1, y: 0.3 }, desembolso: { pagina: 0, x: 0.1, y: 0.5 } };
const guardar = (id, cuerpo, quien = 'cartera') => ag[quien].put(`/api/cartera/${id}/cierre`).send(cuerpo);
const cierre = async (id, quien = 'cartera') => (await ag[quien].get(`/api/cartera/${id}/cierre`)).body;
const estado = async (id) => (await pool.query('SELECT estado FROM credito_solicitudes WHERE id = $1', [id])).rows[0].estado;

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  for (const u of Object.values(usuarios)) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved) VALUES ('Cierre Test', $1, $2, 'asesor', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true RETURNING id`, [u.email, hash]);
    u.id = r.id;
    for (const [modulo, acciones] of Object.entries(u.permisos)) {
      await pool.query(
        `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id) SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = $2 AND a.nombre = ANY($3) ON CONFLICT DO NOTHING`,
        [r.id, modulo, acciones]);
    }
  }
  await pool.query(`INSERT INTO empresas (codigo, nombre, contacto_email) VALUES ($1, 'Empresa Cierre SA', NULL) ON CONFLICT (codigo) DO NOTHING`, [EMPRESA]);
  await pool.query(`INSERT INTO credito_config_empresa (empresa_codigo, requiere_autorizacion, momento_autorizacion) VALUES ($1, false, 'indiferente') ON CONFLICT (empresa_codigo) DO NOTHING`, [EMPRESA]);
  for (const c of Object.values(A)) {
    await pool.query(`INSERT INTO asociados (codigo, nombre, apellido, empresa_dsto, nombre_empresa, is_active) VALUES ($1, 'PRUEBA', $2, $3, 'X', true) ON CONFLICT (codigo) DO NOTHING`, [c, `CIERRE ${c}`, EMPRESA]);
  }
  tarifaOriginal = Number((await pool.query(`SELECT valor FROM credito_parametros WHERE clave = 'tarifa_firma_electronica'`)).rows[0].valor);
  for (const k of Object.keys(usuarios)) ag[k] = await login(k);
  categoriaId = (await ag.asesor.get('/api/creditos/categorias')).body[0].id;
  await pool.query(`UPDATE credito_parametros SET valor = 15000 WHERE clave = 'tarifa_firma_electronica'`);
});

afterAll(async () => {
  const uids = Object.values(usuarios).map((u) => u.id);
  await pool.query('ALTER TABLE credito_eventos DISABLE TRIGGER trg_credito_eventos_solo_agregar');
  await pool.query('ALTER TABLE firma_eventos DISABLE TRIGGER trg_firma_eventos_solo_agregar');
  try {
    const { rows: sol } = await pool.query('SELECT id FROM credito_solicitudes WHERE asesor_uuid = ANY($1)', [uids]);
    const ids = sol.map((s) => s.id);
    await pool.query('DELETE FROM credito_cierre WHERE solicitud_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM credito_eventos WHERE solicitud_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM credito_autorizaciones WHERE solicitud_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM credito_documentos WHERE solicitud_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM credito_solicitudes WHERE id = ANY($1)', [ids]);
    await pool.query(`DELETE FROM archivos WHERE entidad_tipo LIKE 'credito_%' AND (entidad_id = ANY($1) OR subido_por = ANY($2))`, [ids, uids]);
    await pool.query('DELETE FROM firma_eventos WHERE empleado_id = ANY($1)', [uids]);
  } finally {
    await pool.query('ALTER TABLE credito_eventos ENABLE TRIGGER trg_credito_eventos_solo_agregar');
    await pool.query('ALTER TABLE firma_eventos ENABLE TRIGGER trg_firma_eventos_solo_agregar');
  }
  await pool.query(`UPDATE credito_parametros SET valor = $1 WHERE clave = 'tarifa_firma_electronica'`, [tarifaOriginal]);
  await pool.query('DELETE FROM asociados WHERE codigo = ANY($1)', [Object.values(A)]);
  await pool.query('DELETE FROM credito_config_empresa WHERE empresa_codigo = $1', [EMPRESA]);
  await pool.query('DELETE FROM empresas WHERE codigo = $1', [EMPRESA]);
  await pool.query('DELETE FROM notificaciones WHERE usuario_uuid = ANY($1)', [uids]);
  await pool.query('DELETE FROM permisos WHERE usuario_uuid = ANY($1)', [uids]);
  await pool.query('DELETE FROM global_usuarios WHERE id = ANY($1)', [uids]);
  await pool.end();
});

describe('Cierre de Cartera — Auth y permisos', () => {
  test('sin sesión 401; sin permiso 403', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    for (const ruta of [`/api/cartera/${id}/cierre`, `/api/cartera/${id}/pdf-final`, '/api/cartera/reportes/avales?mes=2026-09', '/api/cartera/parametros']) {
      expect((await request(app).get(ruta)).status).toBe(401);
      expect((await ag.nada.get(ruta)).status).toBe(403);
    }
    expect((await ag.asesor.get(`/api/cartera/${id}/cierre`)).status).toBe(403);   // el asesor trabaja por /api/creditos
  });

  test('quien solo lee no modifica el cierre; la tarifa exige CONFIGURAR', async () => {
    const id = await llegarARecibida(A.a1);
    expect((await guardar(id, { con_aval: false }, 'lector')).status).toBe(403);
    expect((await ag.lector.post(`/api/cartera/${id}/completar`)).status).toBe(403);
    expect((await ag.lector.post(`/api/cartera/${id}/cierre/documentos`).field('tipo', 'comprobante_aprobacion').attach('archivo', await pdfReal(), 'x.pdf')).status).toBe(403);
    expect((await ag.cartera2.put('/api/cartera/parametros/tarifa-firma').send({ valor: 1 })).status).toBe(403);
    expect((await ag.lector.get(`/api/cartera/${id}/cierre`)).status).toBe(200);
  });

  test('un identificador mal formado responde 404, no 500', async () => {
    expect((await ag.cartera.get('/api/cartera/no-es-uuid/cierre')).status).toBe(404);
    expect((await ag.ci.get('/api/control_interno/creditos/no-es-uuid/pdf-final')).status).toBe(404);
  });
});

describe('Cierre de Cartera — Tarifa de la firma electrónica', () => {
  test('se lee y se cambia; no admite negativos ni campos extra', async () => {
    expect((await ag.lector.get('/api/cartera/parametros')).body).toEqual({ tarifa_firma_electronica: 15000, puede_configurar: false });
    expect((await ag.cartera.get('/api/cartera/parametros')).body.puede_configurar).toBe(true);
    expect((await ag.cartera.put('/api/cartera/parametros/tarifa-firma').send({ valor: -1 })).status).toBe(400);
    expect((await ag.cartera.put('/api/cartera/parametros/tarifa-firma').send({ valor: 1, otro: 2 })).status).toBe(400);
    expect((await ag.cartera.put('/api/cartera/parametros/tarifa-firma').send({ valor: 15000 })).status).toBe(200);
  });
});

describe('Cierre de Cartera — Documentos y firma', () => {
  let id;
  beforeAll(async () => { id = await llegarARecibida(A.a2); });

  test('solo se trabaja el cierre de una solicitud recibida', async () => {
    const res = await ag.asesor.post('/api/creditos').send({ asociado_codigo: A.a3, categoria_id: categoriaId, canal_origen: 'presencial', valor_solicitado: 1000000, forma_desembolso: 'cheque', modalidad_firma: 'externa', proveedor_externo: 'P' });
    const enTramite = res.body.solicitud.id;
    expect((await guardar(enTramite, { con_aval: false })).status).toBe(409);
    expect((await ag.cartera.post(`/api/cartera/${enTramite}/completar`)).status).toBe(409);
    expect((await ag.cartera.get(`/api/cartera/${enTramite}/pdf-final`)).status).toBe(409);
  });

  test('rechaza tipos inválidos y archivos que no son PDF', async () => {
    expect((await ag.cartera.post(`/api/cartera/${id}/cierre/documentos`).field('tipo', 'pagare').attach('archivo', await pdfReal(), 'x.pdf')).status).toBe(400);
    expect((await ag.cartera.post(`/api/cartera/${id}/cierre/documentos`).field('tipo', 'comprobante_aprobacion').attach('archivo', Buffer.from('hola'), 'x.pdf')).status).toBe(400);
    expect((await ag.cartera.post(`/api/cartera/${id}/cierre/documentos`).field('tipo', 'comprobante_aprobacion')).status).toBe(400);
  });

  test('los documentos de Cartera no alteran las pistas del asesor', async () => {
    const antes = (await ag.cartera.get(`/api/cartera/${id}`)).body.pistas;
    const { res } = await subirCartera(id, 'comprobante_aprobacion');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ clase: 'a_firmar', tipo: 'comprobante_aprobacion', etapa: 'cartera' });
    const despues = (await ag.cartera.get(`/api/cartera/${id}`)).body.pistas;
    expect(despues.a_firmar).toBe(antes.a_firmar);
    expect(despues.firmados).toBe(antes.firmados);
    expect(despues.expediente_completo).toBe(true);
  });

  test('cargar de nuevo reemplaza el documento (queda uno vigente por tipo)', async () => {
    const { res } = await subirCartera(id, 'comprobante_aprobacion');
    expect(res.status).toBe(201);
    const c = await cierre(id);
    expect(c.documentos.filter((d) => d.tipo === 'comprobante_aprobacion' && d.clase === 'a_firmar' && d.vigente)).toHaveLength(1);
    expect(c.documentos.filter((d) => d.tipo === 'comprobante_aprobacion' && !d.vigente).length).toBeGreaterThanOrEqual(1);
  });

  test('sirve los bytes del documento a firmar solo a quien puede escribir', async () => {
    const c = await cierre(id);
    const doc = c.documentos.find((d) => d.tipo === 'comprobante_aprobacion' && d.vigente);
    const ok = await ag.cartera.get(`/api/cartera/${id}/cierre/documentos/${doc.id}/contenido`);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/pdf/);
    expect((await ag.lector.get(`/api/cartera/${id}/cierre/documentos/${doc.id}/contenido`)).status).toBe(403);
    expect((await ag.cartera.get(`/api/cartera/${id}/cierre/documentos/00000000-0000-4000-8000-000000000000/contenido`)).status).toBe(404);
  });

  describe('registro del firmado del motor', () => {
    let doc; let buf;
    beforeAll(async () => {
      ({ res: { body: doc }, buf } = await subirCartera(id, 'formato_estudio_credito'));
    });

    test('exige folio y archivo', async () => {
      expect((await ag.cartera.post(`/api/cartera/${id}/cierre/firmado`).field('folio', 'no-uuid').attach('archivo', await pdfReal(), 'x.pdf')).status).toBe(400);
      expect((await ag.cartera.post(`/api/cartera/${id}/cierre/firmado`).field('folio', crypto.randomUUID())).status).toBe(400);
    });
    test('rechaza un folio inexistente o de otro funcionario', async () => {
      expect((await ag.cartera.post(`/api/cartera/${id}/cierre/firmado`).field('folio', crypto.randomUUID()).attach('archivo', await pdfReal(), 'x.pdf')).status).toBe(404);
      const ajeno = await firmarCartera(id, doc, buf, { asociado: A.a2, quien: 'cartera2', envia: 'cartera' });
      expect(ajeno.res.status).toBe(404);
    });
    test('rechaza un archivo que no es el que produjo el motor', async () => {
      const r = await firmarCartera(id, doc, buf, { asociado: A.a2, hFinal: sha(Buffer.from('otra cosa')) });
      expect(r.res.status).toBe(400);
      expect(r.res.body.error).toMatch(/no coincide/);
    });
    test('rechaza si el asociado no figura entre los firmantes', async () => {
      const r = await firmarCartera(id, doc, buf, { asociado: 'OTRO-DOC' });
      expect(r.res.status).toBe(400);
      expect(r.res.body.error).toMatch(/asociado/);
    });
    test('rechaza un documento que Cartera no preparó', async () => {
      const r = await firmarCartera(id, { nombre: 'x.pdf' }, Buffer.from('%PDF-1.4 no preparado'), { asociado: A.a2 });
      expect(r.res.status).toBe(400);
    });
    test('registra el firmado vigente con su folio; un segundo intento da 409', async () => {
      const r = await firmarCartera(id, doc, buf, { asociado: A.a2 });
      expect(r.res.status).toBe(201);
      expect(r.res.body).toMatchObject({ clase: 'firmado', etapa: 'cartera', tipo: 'formato_estudio_credito', borrador_id: doc.id, folio: r.folio });
      expect((await firmarCartera(id, doc, buf, { asociado: A.a2 })).res.status).toBe(409);
    });
    test('el evento queda en el historial', async () => {
      const ev = (await pool.query(`SELECT 1 FROM credito_eventos WHERE solicitud_id = $1 AND tipo = 'cartera_documento_firmado'`, [id])).rowCount;
      expect(ev).toBe(1);
    });
  });
});

describe('Cierre de Cartera — Aval, desembolso neto y sellos', () => {
  let id;
  beforeAll(async () => { id = await llegarARecibida(A.a4); });

  test('avisa si el desembolso ya se guardó o solo es la simulación', async () => {
    expect((await cierre(id)).cierre_guardado).toBe(false);
    await guardar(id, { con_aval: false });
    expect((await cierre(id)).cierre_guardado).toBe(true);
  });

  test('sin aval: el neto resta solo la firma electrónica externa', async () => {
    const r = await guardar(id, { con_aval: false });
    expect(r.status).toBe(200);
    expect(r.body.cierre).toMatchObject({ con_aval: false, aval_valor: '0.00', firma_electronica_valor: '15000.00', desembolso_neto: '4985000.00' });
    expect(r.body.firma_externa).toBe(true);
  });

  test('con aval: pregunta el porcentaje, lo calcula sobre el monto a desembolsar y lo resta', async () => {
    expect((await guardar(id, { con_aval: true })).status).toBe(400);
    expect((await guardar(id, { con_aval: true, aval_porcentaje: 0 })).status).toBe(400);
    expect((await guardar(id, { con_aval: true, aval_porcentaje: 150 })).status).toBe(400);
    const r = await guardar(id, { con_aval: true, aval_porcentaje: 10 });
    expect(r.status).toBe(200);
    expect(r.body.cierre).toMatchObject({ con_aval: true, aval_porcentaje: '10.00', aval_valor: '500000.00', firma_electronica_valor: '15000.00', desembolso_neto: '4485000.00' });
    expect(r.body.sellos_aplicables).toEqual(['aval', 'firma', 'desembolso']);
  });

  test('desmarcar el aval devuelve el valor al desembolso', async () => {
    const r = await guardar(id, { con_aval: false });
    expect(r.body.cierre).toMatchObject({ aval_porcentaje: null, aval_valor: '0.00', desembolso_neto: '4985000.00' });
    expect(r.body.sellos_aplicables).toEqual(['firma', 'desembolso']);
  });

  test('cambios de tarifa posteriores se reflejan al recalcular', async () => {
    await pool.query(`UPDATE credito_parametros SET valor = 20000 WHERE clave = 'tarifa_firma_electronica'`);
    const r = await guardar(id, { con_aval: true, aval_porcentaje: 10 });
    expect(r.body.cierre.desembolso_neto).toBe('4480000.00');
    await pool.query(`UPDATE credito_parametros SET valor = 15000 WHERE clave = 'tarifa_firma_electronica'`);
  });

  test('un descuento que supera el monto se rechaza', async () => {
    const otro = await llegarARecibida(A.a5, { valor_solicitado: 10000 });
    const r = await guardar(otro, { con_aval: false });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/superan/);
  });

  test('valida las posiciones de los sellos (fracciones de la página; sin sellos desconocidos)', async () => {
    expect((await guardar(id, { con_aval: false, sellos: { desembolso: { pagina: 0, x: 2, y: 0.1 } } })).status).toBe(400);
    expect((await guardar(id, { con_aval: false, sellos: { raro: { pagina: 0, x: 0.1, y: 0.1 } } })).status).toBe(400);
    expect((await guardar(id, { con_aval: false, extra: true })).status).toBe(400);
  });

  test('guardar sin `sellos` conserva los ya puestos; con `sellos` los reemplaza', async () => {
    expect((await guardar(id, { con_aval: true, aval_porcentaje: 10, sellos })).status).toBe(200);
    expect((await cierre(id)).cierre.sellos).toEqual(sellos);
    expect((await guardar(id, { con_aval: true, aval_porcentaje: 12 })).body.cierre.sellos).toEqual(sellos);
    const nuevos = { ...sellos, desembolso: { pagina: 0, x: 0.6, y: 0.6 } };
    expect((await guardar(id, { con_aval: true, aval_porcentaje: 12, sellos: nuevos })).body.cierre.sellos.desembolso).toEqual({ pagina: 0, x: 0.6, y: 0.6 });
  });

  test('deja constancia del cálculo en el historial', async () => {
    const { rows } = await pool.query(`SELECT detalle FROM credito_eventos WHERE solicitud_id = $1 AND tipo = 'cartera_desembolso_calculado' ORDER BY created_at DESC`, [id]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].detalle).toHaveProperty('desembolso_neto');
  });
});

describe('Cierre de Cartera — Completar y pasar a Control Interno', () => {
  let id;
  beforeAll(async () => { id = await llegarARecibida(A.a6); });

  test('lista lo que falta, en orden, y no deja completar', async () => {
    const r = await ag.cartera.post(`/api/cartera/${id}/completar`);
    expect(r.status).toBe(409);
    expect(r.body.faltantes.join(' | ')).toMatch(/Carga el Comprobante de aprobación/);
    expect(r.body.faltantes.join(' | ')).toMatch(/Carga el Formato estudio de crédito/);
    expect(await estado(id)).toBe('recibida');
  });

  test('con los documentos cargados pero sin firmar sigue faltando la firma', async () => {
    await subirCartera(id, 'comprobante_aprobacion');
    await subirCartera(id, 'formato_estudio_credito');
    const f = (await cierre(id)).faltantes.join(' | ');
    expect(f).toMatch(/Falta firmar el Comprobante/);
    expect(f).toMatch(/Falta firmar el Formato estudio/);
  });

  test('firmados los documentos, faltan los sellos', async () => {
    await prepararDocs(id, A.a6);
    await guardar(id, { con_aval: true, aval_porcentaje: 8 });
    const c = await cierre(id);
    expect(c.faltantes.join(' | ')).toMatch(/sello AVAL FONDO REGIONAL/);
    expect(c.faltantes.join(' | ')).toMatch(/sello FIRMA ELECTRONICA/);
    expect(c.faltantes.join(' | ')).toMatch(/sello DESEMBOLSO/);
    expect(c.puede_completar).toBe(false);
    expect((await ag.cartera.post(`/api/cartera/${id}/completar`)).status).toBe(409);
  });

  test('sirve el comprobante firmado (sin sellos) para colocar los sellos; 404 si aún no existe', async () => {
    const r = await ag.lector.get(`/api/cartera/${id}/cierre/comprobante`).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/pdf/);
    expect((await PDFDocument.load(r.body)).getPageCount()).toBe(2);   // el firmado del motor: documento + constancia
    const nuevo = await llegarARecibida(A.a5, { valor_solicitado: 2500000 });
    expect((await ag.cartera.get(`/api/cartera/${nuevo}/cierre/comprobante`)).status).toBe(404);
    expect((await ag.nada.get(`/api/cartera/${id}/cierre/comprobante`)).status).toBe(403);
  });

  test('el PDF final se puede generar antes de completar, con todos los anexos', async () => {
    await guardar(id, { con_aval: true, aval_porcentaje: 8, sellos });
    const r = await ag.cartera.get(`/api/cartera/${id}/pdf-final`).buffer(true).parse((res, cb) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/pdf/);
    expect(r.headers['content-disposition']).toMatch(/credito_CR-/);
    const doc = await PDFDocument.load(r.body);
    // comprobante (2 págs. del motor) + estudio (2) + pagaré firmado (2) + desprendible (1)
    expect(doc.getPageCount()).toBe(7);
    expect(r.headers['x-documentos-omitidos']).toBe('0');
  });

  test('sin el comprobante firmado no hay PDF final', async () => {
    const otro = await llegarARecibida(A.a1, { valor_solicitado: 2000000 });
    expect((await ag.cartera.get(`/api/cartera/${otro}/pdf-final`)).status).toBe(409);
  });

  test('con todo listo se completa: congela los valores, cambia el estado y avisa a Control Interno', async () => {
    await pool.query(`UPDATE credito_parametros SET valor = 18000 WHERE clave = 'tarifa_firma_electronica'`);
    const r = await ag.cartera.post(`/api/cartera/${id}/completar`);
    await pool.query(`UPDATE credito_parametros SET valor = 15000 WHERE clave = 'tarifa_firma_electronica'`);
    expect(r.status).toBe(200);
    expect(r.body.desembolso_neto).toBe(5000000 - 400000 - 18000);   // 8 % de 5.000.000 y la tarifa vigente al completar
    expect(await estado(id)).toBe('completada');
    const c = (await pool.query('SELECT completada_at, completada_por FROM credito_solicitudes WHERE id = $1', [id])).rows[0];
    expect(c.completada_at).not.toBeNull();
    expect(c.completada_por).toBe(usuarios.cartera.id);
    const congelado = (await pool.query('SELECT firma_electronica_valor, desembolso_neto FROM credito_cierre WHERE solicitud_id = $1', [id])).rows[0];
    expect(Number(congelado.firma_electronica_valor)).toBe(18000);
    expect(Number(congelado.desembolso_neto)).toBe(4582000);
    // El monto a desembolsar de la solicitud es el neto calculado (antes de completar está vacío)
    expect(Number((await pool.query('SELECT monto_desembolso FROM credito_solicitudes WHERE id = $1', [id])).rows[0].monto_desembolso)).toBe(4582000);
    expect((await pool.query(`SELECT 1 FROM credito_eventos WHERE solicitud_id = $1 AND tipo = 'completada_por_cartera'`, [id])).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM notificaciones WHERE usuario_uuid = $1 AND mensaje ILIKE '%completado por Cartera%'`, [usuarios.ci.id])).rowCount).toBeGreaterThan(0);
    expect((await pool.query(`SELECT 1 FROM notificaciones WHERE usuario_uuid = $1 AND mensaje ILIKE '%completó%'`, [usuarios.asesor.id])).rowCount).toBeGreaterThan(0);
  });

  test('una solicitud completada ya no se modifica', async () => {
    expect((await guardar(id, { con_aval: false })).status).toBe(409);
    expect((await ag.cartera.post(`/api/cartera/${id}/completar`)).status).toBe(409);
    expect((await ag.cartera.post(`/api/cartera/${id}/devolver`).send({ motivo: 'no debería' })).status).toBe(409);
    expect((await subirCartera(id, 'comprobante_aprobacion')).res.status).toBe(409);
    expect((await ag.asesor.put(`/api/creditos/${id}`).send({ observaciones: 'x' })).status).toBe(409);
  });

  test('sigue accesible el PDF final y aparece en la pestaña Completadas de Cartera', async () => {
    expect((await ag.cartera.get(`/api/cartera/${id}/pdf-final`)).status).toBe(200);
    const l = (await ag.cartera.get('/api/cartera?tab=completadas')).body;
    expect(l.some((s) => s.id === id && s.estado === 'completada')).toBe(true);
    expect((await ag.cartera.get('/api/cartera?tab=recibidas')).body.some((s) => s.id === id)).toBe(false);
  });

  describe('bandeja de Control Interno', () => {
    test('lista los créditos completados con sus valores; exige permiso', async () => {
      expect((await ag.nada.get('/api/control_interno/creditos')).status).toBe(403);
      expect((await ag.cartera.get('/api/control_interno/creditos')).status).toBe(403);
      const r = await ag.ci.get('/api/control_interno/creditos');
      expect(r.status).toBe(200);
      const fila = r.body.find((x) => x.id === id);
      expect(fila).toMatchObject({ con_aval: true, aval_porcentaje: '8.00', desembolso_neto: '4582000.00', modalidad_firma: 'externa' });
    });
    test('Control Interno descarga el PDF final aunque no sea Cartera ni el asesor', async () => {
      const r = await ag.ci.get(`/api/control_interno/creditos/${id}/pdf-final`);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/pdf/);
      expect((await ag.nada.get(`/api/control_interno/creditos/${id}/pdf-final`)).status).toBe(403);
    });
    test('no lista los créditos que no están completados', async () => {
      const pendiente = await llegarARecibida(A.a3, { valor_solicitado: 3000000 });
      const r = await ag.ci.get('/api/control_interno/creditos');
      expect(r.body.some((x) => x.id === pendiente)).toBe(false);
    });
  });
});

describe('Cierre de Cartera — Reportes mensuales', () => {
  const mes = new Date().toISOString().slice(0, 7);
  const texto = (res) => res.text ?? res.body?.toString?.();

  test('valida el mes y exige permiso', async () => {
    expect((await ag.cartera.get('/api/cartera/reportes/avales')).status).toBe(400);
    expect((await ag.cartera.get('/api/cartera/reportes/avales?mes=2026-13')).status).toBe(400);
    expect((await ag.cartera.get('/api/cartera/reportes/avales?mes=2026-09&formato=xml')).status).toBe(400);
    expect((await ag.asesor.get(`/api/cartera/reportes/avales?mes=${mes}`)).status).toBe(403);
    expect((await ag.ci.get(`/api/cartera/reportes/firmas-electronicas?mes=${mes}`)).status).toBe(403);
  });

  test('avales del mes: solo créditos completados con aval, con sus valores', async () => {
    const r = await ag.lector.get(`/api/cartera/reportes/avales?mes=${mes}`);
    expect(r.status).toBe(200);
    const mios = r.body.filas.filter((f) => Object.values(A).includes(f.cedula));
    expect(mios).toHaveLength(1);
    expect(mios[0]).toMatchObject({ cedula: A.a6, aval_porcentaje: '8.00', aval_valor: '400000.00', desembolso_neto: '4582000.00' });
  });

  test('un mes sin completados devuelve la lista vacía', async () => {
    expect((await ag.lector.get('/api/cartera/reportes/avales?mes=2001-01')).body.filas).toEqual([]);
  });

  test('avales del mes en CSV para Excel (BOM, ;, encabezados)', async () => {
    const r = await ag.lector.get(`/api/cartera/reportes/avales?mes=${mes}&formato=csv`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.headers['content-disposition']).toContain(`avales_${mes}.csv`);
    const t = texto(r);
    expect(t.charCodeAt(0)).toBe(0xfeff);
    expect(t.split('\r\n')[0]).toBe('﻿FECHA;RADICADO;CEDULA;ASOCIADO;EMPRESA;CATEGORIA;VALOR_SOLICITADO;PORCENTAJE_AVAL;VALOR_AVAL;VALOR_FIRMA_ELECTRONICA;DESEMBOLSO_NETO');
    expect(t).toContain(A.a6);
  });

  test('firmas electrónicas del mes: quiénes la usaron y cuánto costó', async () => {
    const r = await ag.lector.get(`/api/cartera/reportes/firmas-electronicas?mes=${mes}`);
    const fila = r.body.filas.find((f) => f.cedula === A.a6);
    expect(fila).toMatchObject({ proveedor: 'Proveedor X', valor: '18000.00', documentos: 1 });
  });

  test('firmas electrónicas en CSV', async () => {
    const r = await ag.lector.get(`/api/cartera/reportes/firmas-electronicas?mes=${mes}&formato=csv`);
    expect(r.headers['content-disposition']).toContain(`firmas_electronicas_${mes}.csv`);
    expect(texto(r)).toContain('FECHA;RADICADO;CEDULA;ASOCIADO;EMPRESA;PROVEEDOR;DOCUMENTOS_FIRMADOS;VALOR');
  });
});

// ── Lectura del certificado bancario ──────────────────────────────────────────
const MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const hoyEs = () => { const [a, m, d] = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }).split('-').map(Number); return `${d} de ${MESES_ES[m - 1]} de ${a}`; };
// PDF con texto seleccionable y la forma del certificado digital de Bancolombia (datos inventados)
const pdfCertificado = async ({ doc = '005', cuenta = '12345678901' } = {}) => {
  const d = await PDFDocument.create(); d.setTitle(crypto.randomUUID());
  const fuente = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([600, 800]);
  [`Jueves, ${hoyEs()}`, 'A quien le interese', 'Bancolombia S.A. se permite informar que MARIA PEREZ', `identificado(a) con CC ${doc}, a la fecha de expedicion de esta certificacion, tiene con`,
    'el Banco los siguientes productos:', 'Cuenta de ahorros', cuenta, '2025-06-17', 'Activo'].forEach((l, i) => p.drawText(l, { x: 30, y: 760 - i * 16, size: 9, font: fuente }));
  return Buffer.from(await d.save());
};
// Imagen con el texto del certificado (como una foto o un escaneo): el OCR la lee sin que el archivo traiga texto
const pngCertificado = ({ doc = '005', cuenta = '12345678901' } = {}) => {
  const c = createCanvas(1400, 520); const x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, 1400, 520); x.fillStyle = '#000000'; x.font = '34px sans-serif';
  [`Jueves, ${hoyEs()}`, 'Bancolombia S.A. se permite informar que MARIA PEREZ', `identificado(a) con CC ${doc}, a la fecha de expedicion de esta certificacion`, 'tiene con el Banco los siguientes productos:', `Cuenta de ahorros ${cuenta} 2025-06-17 Activo`]
    .forEach((l, i) => x.fillText(l, 30, 70 + i * 90));
  return c.toBuffer('image/png');
};
const pdfEscaneado = async (opts) => {
  const d = await PDFDocument.create(); d.setTitle(crypto.randomUUID());
  const img = await d.embedPng(pngCertificado(opts));
  d.addPage([700, 260]).drawImage(img, { x: 0, y: 0, width: 700, height: 260 });
  return Buffer.from(await d.save());
};
const certificado = async (id, quien = 'cartera') => ag[quien].get(`/api/cartera/${id}/cierre/certificado`);

describe('Cierre de Cartera — lectura del certificado bancario', () => {
  test('sin certificado subido dice que no hay nada que leer', async () => {
    const id = await llegarARecibida(A.a5);
    const r = await certificado(id);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ estado: 'sin_certificado', alertas: [] });
  });

  test('lee el certificado del asociado: banco, titular, cuenta y sin alertas', async () => {
    const id = await llegarARecibida(A.a5, { forma_desembolso: 'transferencia', certificado: await pdfCertificado() });
    const r = await certificado(id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: 'leido', plantilla: 'bancolombia', banco: 'Bancolombia', titular_documento: '005', dias: 0, alertas: [] });
    expect(r.body.cuentas).toEqual([{ tipo_cuenta: 'ahorros', numero_cuenta: '12345678901', apertura: '2025-06-17', estado: 'activo' }]);
  });

  test('un certificado de otra persona avisa que sería pago a un tercero', async () => {
    const id = await llegarARecibida(A.a5, { forma_desembolso: 'transferencia', certificado: await pdfCertificado({ doc: '999' }) });
    const r = await certificado(id);
    expect(r.body.estado).toBe('leido');
    expect(r.body.alertas.map((a) => a.codigo)).toEqual(['titular_distinto']);
  });

  test('un PDF sin texto (foto o escaneo) no se inventa nada', async () => {
    const id = await llegarARecibida(A.a5, { forma_desembolso: 'transferencia', certificado: await pdfReal() });
    expect((await certificado(id)).body).toEqual({ estado: 'sin_texto', alertas: [] });
  });

  test('una foto del certificado se lee por OCR local y queda marcada como sugerencia por verificar', async () => {
    const id = await llegarARecibida(A.a5, { forma_desembolso: 'transferencia', certificado: pngCertificado() });
    const r = await certificado(id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: 'leido', origen: 'ocr', banco: 'Bancolombia', titular_documento: '005' });
    // El OCR puede confundir un dígito (aquí lee un 0 como 3): por eso es solo una sugerencia y siempre lleva la alerta de verificar
    expect(r.body.cuentas[0]).toMatchObject({ tipo_cuenta: 'ahorros' });
    expect(r.body.cuentas[0].numero_cuenta).toMatch(/^\d{11}$/);
    expect(r.body.alertas.map((a) => a.codigo)).toContain('lectura_ocr');
  });

  test('un PDF escaneado (solo imagen) también se lee por OCR', async () => {
    const id = await llegarARecibida(A.a5, { forma_desembolso: 'transferencia', certificado: await pdfEscaneado() });
    const r = await certificado(id);
    expect(r.body).toMatchObject({ estado: 'leido', origen: 'ocr', titular_documento: '005' });
    expect(r.body.cuentas[0].numero_cuenta).toMatch(/^\d{11}$/);
  });

  test('un PDF con texto NO pasa por OCR (se lee directo y es fiable)', async () => {
    const id = await llegarARecibida(A.a5, { forma_desembolso: 'transferencia', certificado: await pdfCertificado() });
    const r = await certificado(id);
    expect(r.body.origen).toBe('texto');
    expect(r.body.alertas.map((a) => a.codigo)).not.toContain('lectura_ocr');
  });

  test('una imagen sin texto legible no se inventa nada', async () => {
    const c = createCanvas(300, 200); const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 300, 200);
    const id = await llegarARecibida(A.a5, { forma_desembolso: 'transferencia', certificado: c.toBuffer('image/png') });
    expect((await certificado(id)).body).toEqual({ estado: 'sin_texto', alertas: [] });
  });

  test('dos lecturas a la vez se atienden sin fallar (van en cola)', async () => {
    const id = await llegarARecibida(A.a5, { forma_desembolso: 'transferencia', certificado: pngCertificado() });
    const [a, b] = await Promise.all([certificado(id), certificado(id)]);
    expect([a.body.estado, b.body.estado]).toEqual(['leido', 'leido']);
  });

  test('leerlo no guarda nada: la cuenta sigue sin capturar hasta que Cartera guarde', async () => {
    const id = await llegarARecibida(A.a5, { forma_desembolso: 'transferencia', certificado: await pdfCertificado() });
    await certificado(id);
    expect((await cierre(id)).cierre.numero_cuenta ?? null).toBeNull();
    expect((await cierre(id)).cierre_guardado).toBe(false);
  });

  test('exige sesión y permiso de Cartera; un asesor no lo lee', async () => {
    const id = await llegarARecibida(A.a5);
    expect((await request(app).get(`/api/cartera/${id}/cierre/certificado`)).status).toBe(401);
    expect((await certificado(id, 'asesor')).status).toBe(403);
    expect((await certificado(id, 'nada')).status).toBe(403);
    expect((await certificado(id, 'lector')).status).toBe(200);
    expect((await ag.cartera.get('/api/cartera/no-es-uuid/cierre/certificado')).status).toBe(404);
  });
});
