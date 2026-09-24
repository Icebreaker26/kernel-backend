import request from 'supertest';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import { emailsDePrueba, simulacionDePrueba } from '../../src/services/emailService.js';
import { procesarCola, MAX_INTENTOS } from '../../src/services/emailColaService.js';
import { colocarObjetoDePrueba, eliminarArchivo } from '../../src/services/archivoService.js';
import { dispararCorreoAutorizacion } from '../../src/modules/creditos/services/creditoService.js';

let app;
const pass = 'testpass123';
const usuarios = {
  asesor:   { email: 'creditos-asesor@kernel.test',   permisos: { creditos: ['READ', 'WRITE', 'ENTREGAR'] } },
  asesor2:  { email: 'creditos-asesor2@kernel.test',  permisos: { creditos: ['READ', 'WRITE', 'ENTREGAR'] } },
  admin:    { email: 'creditos-admin@kernel.test',    permisos: { creditos: ['READ', 'CONFIGURAR'] } },
  cartera:  { email: 'creditos-cartera@kernel.test',  permisos: { cartera: ['READ', 'WRITE'] } },
  lector:   { email: 'creditos-lector@kernel.test',   permisos: { creditos: ['READ'] } },
  nada:     { email: 'creditos-nada@kernel.test',     permisos: {} },
  root:     { email: 'creditos-root@kernel.test',     permisos: {}, rol: 'admin' },   // administrador del sistema
};
const E = { e1: 'ZZCRT-E1', e2: 'ZZCRT-E2', e3: 'ZZCRT-E3', e4: 'ZZCRT-E4' };
const A = { a1: 'ZZCRT001', a2: 'ZZCRT002', a3: 'ZZCRT003', a4: 'ZZCRT004', a5: 'ZZCRT005', a6: 'ZZCRT006', a7: 'ZZCRT007' };
const H = 'a'.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const pdf = (nombre) => Buffer.from(`%PDF-1.4\n% ${nombre} ${crypto.randomUUID()}\n%%EOF\n`);

const login = async (quien) => {
  const ag = request.agent(app);
  await ag.post('/api/auth/login').send({ email: usuarios[quien].email, password: pass });
  return ag;
};
let ag = {};
let categoriaId;

const cuerpo = (asociado, extra = {}) => ({
  asociado_codigo: asociado, categoria_id: categoriaId, canal_origen: 'presencial',
  valor_solicitado: 5000000, cuotas: 24, cuota_mensual: 250000,
  forma_desembolso: 'cheque', modalidad_firma: 'externa', proveedor_externo: 'Proveedor X', ...extra,
});
const radicar = async (asociado, extra) => {
  const res = await ag.asesor.post('/api/creditos').send(cuerpo(asociado, extra));
  expect(res.status).toBe(201);
  return res.body;
};
const detalle = async (id, quien = 'asesor') => (await ag[quien].get(`/api/creditos/${id}`)).body;
const subirBorrador = async (id, tipo = 'pagare', buf = pdf(tipo)) => {
  const res = await ag.asesor.post(`/api/creditos/${id}/documentos/borrador`).field('tipo', tipo).attach('archivo', buf, `${tipo}.pdf`);
  expect(res.status).toBe(201);
  return { doc: res.body, buf };
};
const firmarExterna = (id, borradorId, extra = {}) => ag.asesor.post(`/api/creditos/${id}/firma-externa`)
  .field('borrador_id', borradorId).field('proveedor', 'Proveedor X').field('id_transaccion', 'TX-1').field('fecha_firma', '2026-09-20')
  .attach('archivo', pdf('firmado'), 'firmado.pdf').attach('evidencia', pdf('evidencia'), 'evidencia.pdf');
const subirAdjunto = (id, tipo) => ag.asesor.post(`/api/creditos/${id}/documentos/adjunto`).field('tipo', tipo).attach('archivo', pdf(tipo), `${tipo}.pdf`);
const autorizar = (id, extra = {}) => ag.asesor.post(`/api/creditos/${id}/autorizacion/registrar`)
  .field('decision', 'aprobada').field('fecha_autorizacion', '2026-09-22').field('canal', 'correo').attach('archivo', pdf('correo-empresa'), 'correo.pdf');
const completar = async (id, { certificado = false } = {}) => {
  const { doc } = await subirBorrador(id);
  expect((await firmarExterna(id, doc.id)).status).toBe(201);
  expect((await autorizar(id)).status).toBe(201);
  expect((await subirAdjunto(id, 'desprendible_nomina')).status).toBe(201);
  if (certificado) expect((await subirAdjunto(id, 'certificado_bancario')).status).toBe(201);
};

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  for (const u of Object.values(usuarios)) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
       VALUES ('Créditos Test', $1, $2, $3, true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, rol = EXCLUDED.rol, is_active = true RETURNING id`, [u.email, hash, u.rol ?? 'asesor']);
    u.id = r.id;
    for (const [modulo, acciones] of Object.entries(u.permisos)) {
      await pool.query(
        `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id) SELECT $1, m.id, a.id FROM modulos m, acciones a
          WHERE m.nombre = $2 AND a.nombre = ANY($3) ON CONFLICT DO NOTHING`, [r.id, modulo, acciones]);
    }
  }
  await pool.query(`INSERT INTO empresas (codigo, nombre, contacto_email) VALUES ($1, 'Empresa Uno SA', 'rrhh-e1@empresa.test'), ($2, 'Empresa Dos SA', NULL), ($3, 'Empresa Tres SA', NULL), ($4, 'Empresa Cuatro SA', 'rrhh-e4@empresa.test') ON CONFLICT (codigo) DO NOTHING`, [E.e1, E.e2, E.e3, E.e4]);
  await pool.query(`INSERT INTO credito_config_empresa (empresa_codigo, requiere_autorizacion, momento_autorizacion, emails_autorizacion) VALUES ($1, true, 'despues_firma', ARRAY['nomina-e2@empresa.test']), ($2, false, 'indiferente', '{}') ON CONFLICT (empresa_codigo) DO NOTHING`, [E.e2, E.e4]);
  const asoc = [[A.a1, E.e1], [A.a2, E.e2], [A.a3, E.e3], [A.a4, E.e1], [A.a5, E.e4], [A.a6, E.e1], [A.a7, E.e1]];
  for (const [c, e] of asoc) {
    await pool.query(`INSERT INTO asociados (codigo, nombre, apellido, empresa_dsto, nombre_empresa, is_active, fecha_retiro) VALUES ($1, 'PRUEBA', $2, $3, 'X', $4, $5) ON CONFLICT (codigo) DO NOTHING`, [c, `CREDITOS ${c}`, e, c !== A.a4, c === A.a4 ? new Date() : null]);
  }
  for (const k of Object.keys(usuarios)) ag[k] = await login(k);
  categoriaId = (await ag.asesor.get('/api/creditos/categorias')).body[0].id;
});

afterAll(async () => {
  const uids = Object.values(usuarios).map((u) => u.id);
  // Las líneas de tiempo son de solo agregar (trigger): para limpiar los datos de prueba se desactivan un instante
  await pool.query('ALTER TABLE credito_eventos DISABLE TRIGGER trg_credito_eventos_solo_agregar');
  await pool.query('ALTER TABLE firma_eventos DISABLE TRIGGER trg_firma_eventos_solo_agregar');
  try {
    const { rows: sol } = await pool.query('SELECT id FROM credito_solicitudes WHERE asesor_uuid = ANY($1)', [uids]);
    const ids = sol.map((s) => s.id);
    await pool.query('DELETE FROM credito_eventos WHERE solicitud_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM credito_autorizaciones WHERE solicitud_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM credito_documentos WHERE solicitud_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM credito_solicitudes WHERE id = ANY($1)', [ids]);
    await pool.query(`DELETE FROM archivos WHERE entidad_tipo LIKE 'credito_%' AND (entidad_id = ANY($1) OR subido_por = ANY($2))`, [ids, uids]);
    await pool.query('DELETE FROM firma_eventos WHERE empleado_id = ANY($1)', [uids]);
    await pool.query(`DELETE FROM email_cola WHERE referencia_tipo = 'credito_autorizacion'`);
    await pool.query(`DELETE FROM email_supresiones WHERE lower(email) LIKE 'cola-%@empresa.test'`);
  } finally {
    await pool.query('ALTER TABLE credito_eventos ENABLE TRIGGER trg_credito_eventos_solo_agregar');
    await pool.query('ALTER TABLE firma_eventos ENABLE TRIGGER trg_firma_eventos_solo_agregar');
  }
  await pool.query('DELETE FROM asociados WHERE codigo = ANY($1)', [Object.values(A)]);
  await pool.query('DELETE FROM credito_config_empresa WHERE empresa_codigo = ANY($1)', [Object.values(E)]);
  await pool.query('DELETE FROM empresas WHERE codigo = ANY($1)', [Object.values(E)]);
  await pool.query('DELETE FROM notificaciones WHERE usuario_uuid = ANY($1)', [uids]);
  await pool.query('DELETE FROM permisos WHERE usuario_uuid = ANY($1)', [uids]);
  await pool.query('DELETE FROM global_usuarios WHERE id = ANY($1)', [uids]);
  await pool.end();
});

describe('Créditos — Auth y permisos', () => {
  test('sin sesión responde 401', async () => {
    expect((await request(app).get('/api/creditos')).status).toBe(401);
    expect((await request(app).get('/api/cartera')).status).toBe(401);
  });
  test('sin permiso responde 403', async () => {
    expect((await ag.nada.get('/api/creditos')).status).toBe(403);
    expect((await ag.nada.get('/api/cartera')).status).toBe(403);
  });
  test('quien solo lee no puede radicar ni entregar, y sin CONFIGURAR no ve la configuración', async () => {
    expect((await ag.lector.post('/api/creditos').send(cuerpo(A.a1))).status).toBe(403);
    expect((await ag.lector.post('/api/creditos/00000000-0000-4000-8000-000000000000/entregar')).status).toBe(403);
    expect((await ag.asesor.get('/api/creditos/config/empresas')).status).toBe(403);
    expect((await ag.cartera.get('/api/creditos')).status).toBe(403);   // Cartera trabaja por /api/cartera
  });
});

describe('Créditos — Búsqueda y validación', () => {
  test('busca asociados vigentes por cédula o nombre y no devuelve retirados', async () => {
    const res = await ag.asesor.get('/api/creditos/asociados/buscar?q=ZZCRT00');
    expect(res.status).toBe(200);
    const codigos = res.body.map((a) => a.codigo);
    expect(codigos).toContain(A.a1);
    expect(codigos).not.toContain(A.a4);   // inactivo
    expect((await ag.asesor.get('/api/creditos/asociados/buscar?q=ZZ')).body).toEqual([]);   // muy corto
  });

  test('info del asociado trae la política de su empresa (sin configurar = pide autorización)', async () => {
    const r1 = (await ag.asesor.get(`/api/creditos/asociados/${A.a1}`)).body;
    expect(r1.config).toMatchObject({ requiere_autorizacion: true, momento_autorizacion: 'indiferente', sin_configurar: true });
    const r2 = (await ag.asesor.get(`/api/creditos/asociados/${A.a2}`)).body;
    expect(r2.config).toMatchObject({ momento_autorizacion: 'despues_firma', emails_autorizacion: ['nomina-e2@empresa.test'] });
  });

  test('rechaza externa sin proveedor, campos de más y el monto a desembolsar (lo calcula Cartera) (400)', async () => {
    const post = (extra) => ag.asesor.post('/api/creditos').send(cuerpo(A.a1, extra));
    expect((await post({ monto_desembolso: 4000000 })).status).toBe(400);   // el asesor ya no lo digita
    expect((await post({ motivo_diferencia: 'Recoge un saldo' })).status).toBe(400);
    expect((await post({ proveedor_externo: '' })).status).toBe(400);
    expect((await post({ x: 1 })).status).toBe(400);
    expect((await post({ valor_solicitado: -5 })).status).toBe(400);
    expect((await post({ forma_desembolso: 'trueque' })).status).toBe(400);
    const ok = await post({});
    expect(ok.status).toBe(201);
    expect(ok.body.solicitud.monto_desembolso).toBeNull();   // se calcula al cerrar en Cartera
  });

  test('bloquea asociados inactivos, inexistentes y categorías inválidas', async () => {
    expect((await ag.asesor.post('/api/creditos').send(cuerpo(A.a4))).status).toBe(422);
    expect((await ag.asesor.post('/api/creditos').send(cuerpo('NOEXISTE99'))).status).toBe(404);
    expect((await ag.asesor.post('/api/creditos').send(cuerpo(A.a1, { categoria_id: crypto.randomUUID() }))).status).toBe(400);
  });

  test('la misma clave de idempotencia no duplica la solicitud', async () => {
    const clave = crypto.randomUUID();
    const a = await ag.asesor.post('/api/creditos').send(cuerpo(A.a6, { clave }));
    const b = await ag.asesor.post('/api/creditos').send(cuerpo(A.a6, { clave }));
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.duplicada).toBe(true);
    expect(b.body.solicitud.id).toBe(a.body.solicitud.id);
  });
});

describe('Créditos — Radicación y correo a la empresa', () => {
  test('radica, pide autorización a la empresa con Reply-To del asesor y sin datos financieros', async () => {
    const antes = emailsDePrueba.length;
    const r = await radicar(A.a1);
    expect(r.solicitud.radicado).toMatch(/^CR-\d{4}-\d{6}$/);
    expect(r.correo.resultado).toBe('solicitada');
    const correo = emailsDePrueba.slice(antes).find((m) => m.to === 'rrhh-e1@empresa.test');
    expect(correo).toBeTruthy();
    expect(correo.replyTo).toBe(usuarios.asesor.email);
    expect(correo.subject).toContain(r.solicitud.radicado);
    expect(correo.html).toContain(A.a1);
    expect(correo.html + correo.text).not.toMatch(/5\.?000\.?000/);   // no lleva el valor total del crédito
    const d = await detalle(r.solicitud.id);
    expect(d.pistas.autorizacion_estado).toBe('solicitada');
    expect(d.eventos.map((e) => e.tipo)).toEqual(expect.arrayContaining(['radicada', 'autorizacion_solicitada']));
  });

  test('empresa sin correo ni configuración: queda "sin destinatario" y se puede enviar indicando uno', async () => {
    const r = await radicar(A.a3);
    expect(r.correo.resultado).toBe('sin_destinatario');
    expect((await detalle(r.solicitud.id)).pistas.autorizacion_estado).toBe('sin_destinatario');
    const antes = emailsDePrueba.length;
    const env = await ag.asesor.post(`/api/creditos/${r.solicitud.id}/autorizacion/enviar`).send({ emails: ['nomina-e3@empresa.test'] });
    expect(env.status).toBe(200);
    expect(env.body.resultado).toBe('solicitada');
    expect(emailsDePrueba.slice(antes).map((m) => m.to)).toContain('nomina-e3@empresa.test');
    expect((await detalle(r.solicitud.id)).pistas.autorizacion_estado).toBe('solicitada');
  });

  test('empresa que pide la firma primero: el correo sale cuando la firma queda completa', async () => {
    const antes = emailsDePrueba.length;
    const r = await radicar(A.a2);
    expect(r.correo.resultado).toBe('espera_firma');
    expect(emailsDePrueba.slice(antes).some((m) => m.to === 'nomina-e2@empresa.test')).toBe(false);
    const { doc } = await subirBorrador(r.solicitud.id);
    expect((await firmarExterna(r.solicitud.id, doc.id)).status).toBe(201);
    expect(emailsDePrueba.slice(antes).some((m) => m.to === 'nomina-e2@empresa.test')).toBe(true);
    const d = await detalle(r.solicitud.id);
    expect(d.pistas.autorizacion_estado).toBe('solicitada');
    expect(d.eventos.map((e) => e.tipo)).toContain('firma_completa');
  });

  test('empresa que no exige autorización: no se envía correo y la pista ya está cumplida', async () => {
    const antes = emailsDePrueba.length;
    const r = await radicar(A.a5);
    expect(r.correo.resultado).toBe('no_requerida');
    expect(emailsDePrueba.length).toBe(antes);
    expect((await detalle(r.solicitud.id)).pistas).toMatchObject({ autorizacion_requerida: false, autorizacion_ok: true });
  });

  test('cambiar lo que exige la empresa requiere motivo', async () => {
    const sin = await ag.asesor.post('/api/creditos').send(cuerpo(A.a5, { autorizacion_requerida: true }));
    expect(sin.status).toBe(400);
    const con = await ag.asesor.post('/api/creditos').send(cuerpo(A.a5, { autorizacion_requerida: true, override_motivo: 'La empresa lo pidió por teléfono', emails_autorizacion: ['otro@empresa.test'] }));
    expect(con.status).toBe(201);
    expect(con.body.solicitud.autorizacion_requerida).toBe(true);
    expect(con.body.solicitud.override_motivo).toBeTruthy();
  });
});

describe('Créditos — Flujo completo con firma externa y entrega a Cartera', () => {
  let id; let radicado; let borradores; let firmados;

  test('no se puede entregar mientras falte algo, y dice qué falta', async () => {
    const r = await radicar(A.a1);
    id = r.solicitud.id; radicado = r.solicitud.radicado;
    const res = await ag.asesor.post(`/api/creditos/${id}/entregar`);
    expect(res.status).toBe(409);
    expect(res.body.faltantes.join(' ')).toMatch(/documentos a firmar/);
    expect(res.body.faltantes.join(' ')).toMatch(/autorización/);
    expect(res.body.faltantes.join(' ')).toMatch(/desprendible/);
  });

  test('sube dos documentos a firmar; solo acepta PDF reales', async () => {
    const a = await subirBorrador(id, 'pagare');
    const b = await subirBorrador(id, 'carta_instrucciones');
    borradores = [a.doc, b.doc];
    const falso = await ag.asesor.post(`/api/creditos/${id}/documentos/borrador`).field('tipo', 'pagare').attach('archivo', Buffer.from('MZ esto no es un pdf'), 'x.pdf');
    expect(falso.status).toBe(400);
    const tipoMalo = await ag.asesor.post(`/api/creditos/${id}/documentos/borrador`).field('tipo', 'desprendible_nomina').attach('archivo', pdf('x'), 'x.pdf');
    expect(tipoMalo.status).toBe(400);
    // Solo los cinco documentos que la cooperativa firma
    for (const t of ['otro', 'autorizacion_descuento']) {
      expect((await ag.asesor.post(`/api/creditos/${id}/documentos/borrador`).field('tipo', t).attach('archivo', pdf(t), `${t}.pdf`)).status).toBe(400);
    }
    for (const t of ['libranza', 'solicitud_credito', 'proyeccion']) {
      const ok = await ag.asesor.post(`/api/creditos/${id}/documentos/borrador`).field('tipo', t).attach('archivo', pdf(t), `${t}.pdf`);
      expect(ok.status).toBe(201);
      expect((await ag.asesor.delete(`/api/creditos/${id}/documentos/${ok.body.id}`)).status).toBe(200);   // se retiran para no alterar el resto de la prueba
    }
    expect((await detalle(id)).pistas).toMatchObject({ a_firmar: 2, firmados: 0, firma_completa: false });
  });

  test('firma externa: no se exige la evidencia del proveedor y cada documento se firma una sola vez', async () => {
    const sinEvidencia = await ag.asesor.post(`/api/creditos/${id}/firma-externa`).field('borrador_id', borradores[0].id).field('proveedor', 'Prov').field('fecha_firma', '2026-09-20').attach('archivo', pdf('f'), 'f.pdf');
    expect(sinEvidencia.status).toBe(201);   // el certificado del proveedor no es obligatorio
    const futura = sinEvidencia;
    firmados = [futura.body];
    expect((await firmarExterna(id, borradores[0].id)).status).toBe(409);   // ya firmado
    expect((await firmarExterna(id, crypto.randomUUID())).status).toBe(400);   // documento inexistente
    expect((await detalle(id)).pistas).toMatchObject({ a_firmar: 2, firmados: 1, firma_completa: false });
    // Si se adjunta evidencia se valida que sea un archivo real, y se guarda
    const evidenciaMala = await ag.asesor.post(`/api/creditos/${id}/firma-externa`).field('borrador_id', borradores[1].id).field('proveedor', 'Prov').field('fecha_firma', '2026-09-20')
      .attach('archivo', pdf('f2'), 'f2.pdf').attach('evidencia', Buffer.from('MZ no es un archivo valido'), 'e.pdf');
    expect(evidenciaMala.status).toBe(400);
    const seg = await firmarExterna(id, borradores[1].id);
    expect(seg.status).toBe(201);
    expect((await detalle(id)).pistas.firma_completa).toBe(true);
  });

  test('un documento ya firmado no se puede quitar', async () => {
    expect((await ag.asesor.delete(`/api/creditos/${id}/documentos/${borradores[0].id}`)).status).toBe(409);
  });

  test('autorización: la fecha y el soporte son obligatorios al aprobar', async () => {
    const base = () => ag.asesor.post(`/api/creditos/${id}/autorizacion/registrar`).field('decision', 'aprobada').field('canal', 'correo');
    expect((await base().field('fecha_autorizacion', '2026-09-22')).status).toBe(400);   // sin soporte
    expect((await base().attach('archivo', pdf('c'), 'c.pdf')).status).toBe(400);   // sin fecha
    expect((await base().field('fecha_autorizacion', '2099-01-01').attach('archivo', pdf('c'), 'c.pdf')).status).toBe(400);   // futura
    expect((await ag.asesor.post(`/api/creditos/${id}/autorizacion/registrar`).field('decision', 'rechazada').field('canal', 'correo')).status).toBe(400);   // sin motivo
  });

  test('la empresa rechaza, el asesor vuelve a pedir y luego se aprueba', async () => {
    const rech = await ag.asesor.post(`/api/creditos/${id}/autorizacion/registrar`).field('decision', 'rechazada').field('canal', 'correo').field('motivo_rechazo', 'Cuota muy alta');
    expect(rech.status).toBe(201);
    let d = await detalle(id);
    expect(d.pistas.autorizacion_estado).toBe('rechazada');
    expect(d.faltantes.join(' ')).toMatch(/rechazó/);
    expect((await ag.asesor.post(`/api/creditos/${id}/autorizacion/enviar`).send({})).body.resultado).toBe('solicitada');   // ronda nueva
    d = await detalle(id);
    expect(d.autorizaciones).toHaveLength(2);
    expect(d.pistas.autorizacion_estado).toBe('solicitada');
    const ok = await autorizar(id);
    expect(ok.status).toBe(201);
    d = await detalle(id);
    expect(d.pistas).toMatchObject({ autorizacion_estado: 'aprobada', autorizacion_ok: true });
    expect(d.autorizaciones[0]).toMatchObject({ estado: 'aprobada', fecha_autorizacion: expect.any(String) });
    expect((await ag.asesor.post(`/api/creditos/${id}/autorizacion/enviar`).send({})).status).toBe(409);   // ya aprobada
  });

  test('con el desprendible queda listo (cheque: sin certificado bancario) y se entrega', async () => {
    expect((await detalle(id)).pistas.listo).toBe(false);   // falta el desprendible
    expect((await subirAdjunto(id, 'desprendible_nomina')).status).toBe(201);
    const d = await detalle(id);
    expect(d.pistas).toMatchObject({ listo: true, certificado_requerido: false });
    expect(d.faltantes).toEqual([]);
    expect((await ag.asesor.post(`/api/creditos/${id}/entregar`)).status).toBe(200);
    expect((await detalle(id)).solicitud.estado).toBe('entregada');
  });

  test('entregada, ya no admite cambios', async () => {
    expect((await ag.asesor.put(`/api/creditos/${id}`).send({ valor_solicitado: 1 })).status).toBe(409);
    expect((await subirAdjunto(id, 'otro_adjunto')).status).toBe(409);
  });

  test('Cartera ve el expediente, un asesor ajeno no, y las vistas quedan registradas', async () => {
    const lista = (await ag.cartera.get('/api/cartera?tab=entregadas')).body;
    const fila = lista.find((s) => s.radicado === radicado);
    expect(fila).toMatchObject({ estado: 'entregada', expediente_completo: true, firma_completa: true, autorizacion_estado: 'aprobada' });
    expect((await ag.cartera.get('/api/cartera?tab=por_llegar')).body.some((s) => s.radicado === radicado)).toBe(false);
    expect((await ag.cartera.get('/api/cartera?tab=inexistente')).status).toBe(400);

    expect((await ag.asesor2.get(`/api/creditos/${id}`)).status).toBe(404);   // asesor ajeno
    expect((await ag.asesor2.get('/api/creditos')).body.some((s) => s.radicado === radicado)).toBe(false);
    expect((await ag.asesor.get('/api/creditos')).body.some((s) => s.radicado === radicado)).toBe(true);
    expect((await ag.admin.get('/api/creditos?todas=1')).body.some((s) => s.radicado === radicado)).toBe(true);   // quien administra ve todo

    const d = (await ag.cartera.get(`/api/cartera/${id}`)).body;
    expect(d.documentos.filter((x) => x.clase === 'firmado' && x.vigente)).toHaveLength(2);
    const firmado = d.documentos.find((x) => x.clase === 'firmado');
    const url = await ag.cartera.get(`/api/cartera/${id}/archivos/${firmado.archivo_id}/url`);
    expect(url.status).toBe(200);
    expect(url.body.url).toMatch(/^https?:\/\//);
    const soporte = await ag.cartera.get(`/api/cartera/${id}/archivos/${d.autorizaciones[0].archivo_id}/url`);
    expect(soporte.status).toBe(200);
    expect((await ag.cartera.get(`/api/cartera/${id}/archivos/${crypto.randomUUID()}/url`)).status).toBe(404);
    const vistas = (await ag.cartera.get(`/api/cartera/${id}`)).body.eventos.filter((e) => e.tipo === 'documento_visto');
    expect(vistas.length).toBeGreaterThanOrEqual(2);
    expect(vistas[0].autor_nombre).toBeTruthy();
  });

  test('Cartera descarga todo el expediente en un ZIP, con resumen y huellas; queda registrado', async () => {
    const binario = (r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };
    const res = await ag.cartera.get(`/api/cartera/${id}/expediente`).buffer(true).parse(binario);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/zip/);
    expect(res.headers['content-disposition']).toMatch(new RegExp(`attachment; filename="expediente_${radicado}\\.zip"`));
    const zip = unzipSync(new Uint8Array(res.body));
    const nombres = Object.keys(zip);
    expect(nombres.filter((n) => n.startsWith('1_documentos_firmados/'))).toHaveLength(2);
    expect(nombres.filter((n) => n.startsWith('4_evidencia_firma_externa/'))).toHaveLength(1);   // solo donde el asesor la adjuntó
    expect(nombres.filter((n) => n.startsWith('2_autorizacion_empresa/')).length).toBeGreaterThanOrEqual(1);   // el soporte aprobado (y el rechazo, si tuvo)
    expect(nombres.filter((n) => n.startsWith('3_documentos_del_asociado/'))).toHaveLength(1);
    expect(nombres.some((n) => n.includes('Pagare')) && nombres.some((n) => n.includes('Carta_de_instrucciones'))).toBe(true);
    expect(nombres.some((n) => n.startsWith('borrador') || n.includes('a_firmar'))).toBe(false);   // los borradores sin firmar no van
    const resumen = strFromU8(zip['0_resumen.txt']);
    expect(resumen).toContain(radicado);
    expect(resumen).toContain('Expediente completo: sí');
    expect(resumen).toMatch(/SHA-256 [a-f0-9]{64}/);
    expect(resumen).not.toContain('NO COINCIDE');
    expect(resumen).toContain('Ley 1581');
    expect((await detalle(id)).eventos.filter((e) => e.tipo === 'expediente_descargado').length).toBeGreaterThanOrEqual(1);
    // Sin permiso de Cartera no se descarga, y sin sesión tampoco
    expect((await ag.asesor.get(`/api/cartera/${id}/expediente`)).status).toBe(403);
    expect((await request(app).get(`/api/cartera/${id}/expediente`)).status).toBe(401);
  });

  test('integridad: los archivos guardados coinciden con su hash', async () => {
    const res = await ag.cartera.get(`/api/cartera/${id}/integridad`);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(4);
    expect(res.body.every((x) => x.integro)).toBe(true);
  });

  test('Cartera recibe una sola vez y solo lo entregado', async () => {
    expect((await ag.cartera.post(`/api/cartera/${id}/recibir`)).status).toBe(200);
    expect((await ag.cartera.post(`/api/cartera/${id}/recibir`)).status).toBe(409);
    expect((await ag.cartera.post(`/api/cartera/${id}/devolver`).send({ motivo: 'x y z' })).status).toBe(409);
    expect((await ag.cartera.get('/api/cartera?tab=recibidas')).body.some((s) => s.radicado === radicado)).toBe(true);
    expect((await ag.asesor.post(`/api/cartera/${id}/recibir`)).status).toBe(403);   // el asesor no tiene permiso de Cartera
  });

  test('la línea de tiempo cuenta toda la historia y es inmutable', async () => {
    const tipos = (await detalle(id)).eventos.map((e) => e.tipo);
    expect(tipos).toEqual(expect.arrayContaining(['radicada', 'documento_a_firmar', 'documento_firmado', 'autorizacion_solicitada', 'autorizacion_rechazada', 'autorizacion_aprobada', 'firma_completa', 'entregada_a_cartera', 'recibida_por_cartera']));
    await expect(pool.query('DELETE FROM credito_eventos WHERE solicitud_id = $1', [id])).rejects.toThrow(/solo agregar/);
    await expect(pool.query(`UPDATE credito_eventos SET tipo = 'x' WHERE solicitud_id = $1`, [id])).rejects.toThrow(/solo agregar/);
  });
});

describe('Créditos — Transferencia, firma presencial y devolución', () => {
  let id; let borrador; let original;

  test('el expediente de una solicitud aún en trámite no se descarga', async () => {
    const r = await radicar(A.a7);
    expect((await ag.cartera.get(`/api/cartera/${r.solicitud.id}/expediente`)).status).toBe(409);
  });

  test('con transferencia también exige el certificado bancario', async () => {
    const r = await radicar(A.a7, { forma_desembolso: 'transferencia', modalidad_firma: 'presencial', proveedor_externo: '' });
    id = r.solicitud.id;
    ({ doc: borrador, buf: original } = await subirBorrador(id, 'pagare'));
    expect((await autorizar(id)).status).toBe(201);
    expect((await subirAdjunto(id, 'desprendible_nomina')).status).toBe(201);
    const d = await detalle(id);
    expect(d.pistas).toMatchObject({ certificado_requerido: true, tiene_certificado: false });
    expect(d.faltantes.join(' ')).toMatch(/certificado bancario/);
  });

  test('el motor recibe los bytes del documento a firmar por el backend (sin depender del CORS de S3)', async () => {
    const res = await ag.asesor.get(`/api/creditos/${id}/documentos/${borrador.id}/contenido`).buffer(true).parse((r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(sha(res.body)).toBe(sha(original));
    expect((await ag.asesor2.get(`/api/creditos/${id}/documentos/${borrador.id}/contenido`)).status).toBe(404);   // otro asesor
    expect((await ag.asesor.get(`/api/creditos/${id}/documentos/${crypto.randomUUID()}/contenido`)).status).toBe(404);
    const adjunto = (await detalle(id)).documentos.find((x) => x.clase === 'adjunto');
    expect((await ag.asesor.get(`/api/creditos/${id}/documentos/${adjunto.id}/contenido`)).status).toBe(404);   // solo los documentos a firmar
    expect((await request(app).get(`/api/creditos/${id}/documentos/${borrador.id}/contenido`)).status).toBe(401);
  });

  test('firma presencial: solo se acepta el PDF que produjo el motor de firma', async () => {
    const firmado = pdf('firmado-presencial');
    const nuevoFe = async (h_original, firmantes, h_final = sha(firmado)) => (await pool.query(
      `INSERT INTO firma_eventos (h_original, h_final, nombre_archivo, paginas, empleado_id, firmantes, final_at) VALUES ($1, $2, 'pagare.pdf', 1, $3, $4, NOW()) RETURNING folio`,
      [h_original, h_final, usuarios.asesor.id, JSON.stringify(firmantes)])).rows[0].folio;
    const firmante = (doc) => [{ nombre: 'X', tipo_doc: 'CC', num_doc: doc, rol: 'asociado', metodo_firma: 'pen', con_huella: false, h_firma_png: H }];
    const enviar = (folio, buf = firmado, quien = 'asesor') => ag[quien].post(`/api/creditos/${id}/firmado`).field('folio', folio).attach('archivo', buf, 'pagare_firmado.pdf');
    const fe = await nuevoFe(sha(original), firmante(A.a7));

    expect((await ag.asesor.post(`/api/creditos/${id}/firmado`).field('folio', fe)).status).toBe(400);   // sin archivo
    expect((await enviar(fe, Buffer.from('MZ esto no es un pdf'))).status).toBe(400);   // no es PDF
    expect((await enviar(fe, pdf('alterado'))).status).toBe(400);   // otra huella: no es lo que produjo el motor
    expect((await enviar(fe, firmado, 'asesor2')).status).toBe(404);   // otro funcionario
    expect((await enviar(await nuevoFe(sha(pdf('nunca-radicado')), firmante(A.a7)))).status).toBe(400);   // documento no preparado en la solicitud
    expect((await enviar(await nuevoFe(sha(original), firmante('99999999')))).status).toBe(400);   // firmante distinto del asociado
    expect((await ag.asesor.post(`/api/creditos/${id}/firmado`).field('folio', 'no-es-uuid').attach('archivo', firmado, 'x.pdf')).status).toBe(400);

    const ok = await enviar(fe);
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ clase: 'firmado', folio: fe, borrador_id: borrador.id, sha256: sha(firmado) });
    expect((await enviar(fe)).status).toBe(409);   // ya registrado
    expect((await detalle(id)).pistas.firma_completa).toBe(true);
    const integ = (await ag.asesor.get(`/api/creditos/${id}/integridad`)).body;
    expect(integ.every((x) => x.integro)).toBe(true);
  });

  test('con el certificado queda listo, se entrega y Cartera la devuelve con motivo', async () => {
    expect((await subirAdjunto(id, 'certificado_bancario')).status).toBe(201);
    expect((await detalle(id)).pistas.listo).toBe(true);
    expect((await ag.asesor.post(`/api/creditos/${id}/entregar`)).status).toBe(200);
    expect((await ag.cartera.post(`/api/cartera/${id}/devolver`).send({ motivo: 'x' })).status).toBe(400);   // motivo muy corto
    expect((await ag.cartera.post(`/api/cartera/${id}/devolver`).send({ motivo: 'El desprendible está ilegible' })).status).toBe(200);
    const d = await detalle(id);
    expect(d.solicitud).toMatchObject({ estado: 'devuelta', devuelta_motivo: 'El desprendible está ilegible' });
    expect((await ag.cartera.get('/api/cartera?tab=devueltas')).body.some((s) => s.id === id)).toBe(true);
  });

  test('devuelta, el asesor la corrige; cambiar las condiciones invalida firma y autorización', async () => {
    expect((await subirAdjunto(id, 'desprendible_nomina')).status).toBe(201);   // devuelta admite cambios
    const sin = await ag.asesor.put(`/api/creditos/${id}`).send({ observaciones: 'Se corrigió el desprendible' });
    expect(sin.status).toBe(200);
    expect(sin.body.invalidados).toBe(0);
    expect((await detalle(id)).pistas.listo).toBe(true);   // solo cambió una observación

    const res = await ag.asesor.put(`/api/creditos/${id}`).send({ valor_solicitado: 6000000 });
    expect(res.status).toBe(200);
    expect(res.body.invalidados).toBeGreaterThanOrEqual(1);
    const d = await detalle(id);
    expect(d.pistas).toMatchObject({ firma_completa: false, autorizacion_estado: 'invalidada', listo: false });
    expect(d.eventos.map((e) => e.tipo)).toContain('cambio_posterior_a_firma');
    expect((await ag.asesor.post(`/api/creditos/${id}/entregar`)).status).toBe(409);
    expect((await ag.asesor.put(`/api/creditos/${id}`).send({ monto_desembolso: 7000000 })).status).toBe(400);   // el monto no se digita
  });

  test('se puede cerrar una solicitud (desistida) y ya no admite nada', async () => {
    expect((await ag.asesor.post(`/api/creditos/${id}/cerrar`).send({ estado: 'desistida', motivo: 'El asociado ya no lo necesita' })).status).toBe(200);
    expect((await detalle(id)).solicitud.estado).toBe('desistida');
    expect((await subirAdjunto(id, 'otro_adjunto')).status).toBe(409);
    expect((await ag.asesor.post(`/api/creditos/${id}/cerrar`).send({ estado: 'otra', motivo: 'abc' })).status).toBe(400);
  });
});

describe('Créditos — Configuración por empresa', () => {
  test('quien administra lista y cambia la política; se valida el cuerpo', async () => {
    const lista = await ag.admin.get('/api/creditos/config/empresas?q=Empresa Uno');
    expect(lista.status).toBe(200);
    expect(lista.body.find((e) => e.codigo === E.e1)).toMatchObject({ configurada: false, requiere_autorizacion: true });
    const put = (b) => ag.admin.put(`/api/creditos/config/empresas/${E.e1}`).send(b);
    expect((await put({ requiere_autorizacion: 'si', momento_autorizacion: 'antes_firma', emails_autorizacion: [] })).status).toBe(400);
    expect((await put({ requiere_autorizacion: true, momento_autorizacion: 'nunca', emails_autorizacion: [] })).status).toBe(400);
    expect((await put({ requiere_autorizacion: true, momento_autorizacion: 'antes_firma', emails_autorizacion: ['no-es-correo'] })).status).toBe(400);
    const ok = await put({ requiere_autorizacion: true, momento_autorizacion: 'antes_firma', emails_autorizacion: ['nomina-e1@empresa.test'] });
    expect(ok.status).toBe(200);
    expect(ok.body.emails_autorizacion).toEqual(['nomina-e1@empresa.test']);
    expect((await ag.admin.put('/api/creditos/config/empresas/NOEXISTE').send({ requiere_autorizacion: true, momento_autorizacion: 'antes_firma', emails_autorizacion: [] })).status).toBe(404);
  });

  test('la configuración manda: el correo va a la lista de la empresa, no a su contacto general', async () => {
    const antes = emailsDePrueba.length;
    await radicar(A.a1);
    const destinos = emailsDePrueba.slice(antes).map((m) => m.to);
    expect(destinos).toContain('nomina-e1@empresa.test');
    expect(destinos).not.toContain('rrhh-e1@empresa.test');
  });
});

describe('Créditos — Quién modifica y reasignación', () => {
  let id;

  test('solo el asesor dueño (o un administrador) modifica; quien solo puede ver no', async () => {
    id = (await radicar(A.a5)).solicitud.id;
    // Otro asesor ni siquiera la ve
    expect((await ag.asesor2.get(`/api/creditos/${id}`)).status).toBe(404);
    expect((await ag.asesor2.put(`/api/creditos/${id}`).send({ observaciones: 'x' })).status).toBe(404);
    // Quien administra la configuración (CONFIGURAR, sin rol admin) ve todo pero no modifica
    const d = await ag.admin.get(`/api/creditos/${id}`);
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ puede_editar: false, puede_reasignar: false });
    expect((await ag.admin.put(`/api/creditos/${id}`).send({ observaciones: 'x' })).status).toBe(403);
    expect((await ag.admin.post(`/api/creditos/${id}/cerrar`).send({ estado: 'desistida', motivo: 'no debería poder' })).status).toBe(403);
    // Cartera solo lee
    expect((await ag.cartera.get(`/api/cartera/${id}`)).status).toBe(200);
    expect((await ag.cartera.put(`/api/creditos/${id}`).send({ observaciones: 'x' })).status).toBe(403);
    // El dueño sí, y el administrador del sistema también
    const dueno = await detalle(id);
    expect(dueno).toMatchObject({ puede_editar: true, puede_reasignar: false });
    expect((await ag.asesor.put(`/api/creditos/${id}`).send({ observaciones: 'del asesor' })).status).toBe(200);
    const root = await ag.root.get(`/api/creditos/${id}`);
    expect(root.body).toMatchObject({ puede_editar: true, puede_reasignar: true });
    expect((await ag.root.put(`/api/creditos/${id}`).send({ observaciones: 'del administrador' })).status).toBe(200);
    expect((await ag.root.post(`/api/creditos/${id}/documentos/adjunto`).field('tipo', 'desprendible_nomina').attach('archivo', pdf('d'), 'd.pdf')).status).toBe(201);
    // El administrador ve las solicitudes de todos
    expect((await ag.root.get('/api/creditos?todas=1')).body.some((x) => x.id === id)).toBe(true);
  });

  test('solo un administrador reasigna, y solo a quien puede gestionar créditos', async () => {
    const body = (uuid, motivo = 'El asesor está de vacaciones') => ({ asesor_uuid: uuid, motivo });
    expect((await ag.asesor.post(`/api/creditos/${id}/reasignar`).send(body(usuarios.asesor2.id))).status).toBe(403);   // ni el dueño
    expect((await ag.admin.post(`/api/creditos/${id}/reasignar`).send(body(usuarios.asesor2.id))).status).toBe(403);    // ni con CONFIGURAR
    expect((await ag.admin.get('/api/creditos/asesores')).status).toBe(403);
    const lista = await ag.root.get('/api/creditos/asesores');
    expect(lista.status).toBe(200);
    const ids = lista.body.map((u) => u.id);
    expect(ids).toEqual(expect.arrayContaining([usuarios.asesor.id, usuarios.asesor2.id, usuarios.root.id]));
    expect(ids).not.toContain(usuarios.lector.id);   // solo lectura: no gestiona
    expect(ids).not.toContain(usuarios.nada.id);

    const r = (b) => ag.root.post(`/api/creditos/${id}/reasignar`).send(b);
    expect((await r(body(usuarios.asesor.id))).status).toBe(400);      // ya es el asesor
    expect((await r(body(usuarios.lector.id))).status).toBe(400);      // sin permiso de créditos
    expect((await r(body(usuarios.nada.id))).status).toBe(400);
    expect((await r(body(crypto.randomUUID()))).status).toBe(400);     // no existe
    expect((await r(body('no-es-uuid'))).status).toBe(400);
    expect((await r(body(usuarios.asesor2.id, 'x'))).status).toBe(400);   // motivo muy corto
    expect((await ag.root.post(`/api/creditos/${crypto.randomUUID()}/reasignar`).send(body(usuarios.asesor2.id))).status).toBe(404);
  });

  test('reasignada: el nuevo asesor la gestiona y el anterior pierde el acceso; queda en la línea de tiempo', async () => {
    const ok = await ag.root.post(`/api/creditos/${id}/reasignar`).send({ asesor_uuid: usuarios.asesor2.id, motivo: 'El asesor está de vacaciones' });
    expect(ok.status).toBe(200);
    expect((await ag.asesor.get(`/api/creditos/${id}`)).status).toBe(404);
    expect((await ag.asesor.put(`/api/creditos/${id}`).send({ observaciones: 'no debería' })).status).toBe(404);
    expect((await ag.asesor.get('/api/creditos')).body.some((x) => x.id === id)).toBe(false);
    const nuevo = await ag.asesor2.get(`/api/creditos/${id}`);
    expect(nuevo.body).toMatchObject({ puede_editar: true });
    expect((await ag.asesor2.put(`/api/creditos/${id}`).send({ observaciones: 'del nuevo asesor' })).status).toBe(200);
    expect((await ag.asesor2.get('/api/creditos')).body.some((x) => x.id === id)).toBe(true);
    const ev = nuevo.body.eventos.find((e) => e.tipo === 'reasignada');
    expect(ev.detalle).toMatchObject({ a: 'Créditos Test', motivo: 'El asesor está de vacaciones' });
    expect(ev.autor_nombre).toBeTruthy();
  });

  test('una solicitud cerrada ya no se reasigna', async () => {
    expect((await ag.asesor2.post(`/api/creditos/${id}/cerrar`).send({ estado: 'desistida', motivo: 'El asociado ya no lo necesita' })).status).toBe(200);
    expect((await ag.root.post(`/api/creditos/${id}/reasignar`).send({ asesor_uuid: usuarios.asesor.id, motivo: 'Intento tardío' })).status).toBe(409);
    expect((await ag.root.get(`/api/creditos/${id}`)).body.puede_reasignar).toBe(false);
  });
});

describe('Créditos — Documentos del asociado (pestaña del perfil)', () => {
  let id; let firmadoArchivo; let soporteArchivo;

  test('reúne los archivos de todas las solicitudes del asociado; el asesor solo ve los suyos', async () => {
    id = (await radicar(A.a6)).solicitud.id;
    const { doc } = await subirBorrador(id, 'pagare');
    expect((await firmarExterna(id, doc.id)).status).toBe(201);
    expect((await autorizar(id)).status).toBe(201);
    expect((await subirAdjunto(id, 'desprendible_nomina')).status).toBe(201);

    const propios = await ag.asesor.get(`/api/creditos/asociados/${A.a6}/documentos`);
    expect(propios.status).toBe(200);
    const clases = propios.body.filter((d) => d.solicitud_id === id).map((d) => d.clase);
    expect(clases).toEqual(expect.arrayContaining(['a_firmar', 'firmado', 'adjunto', 'autorizacion']));
    const fila = propios.body.find((d) => d.solicitud_id === id && d.clase === 'firmado');
    expect(fila).toMatchObject({ radicado: expect.stringMatching(/^CR-/), vigente: true, tipo: 'pagare', solicitud_estado: 'en_tramite', subido_por_nombre: 'Créditos Test' });
    firmadoArchivo = fila.archivo_id;
    soporteArchivo = propios.body.find((d) => d.solicitud_id === id && d.clase === 'autorizacion').archivo_id;
    // ordenados del más reciente al más antiguo
    const fechas = propios.body.map((d) => new Date(d.created_at).getTime());
    expect(fechas).toEqual([...fechas].sort((a, b) => b - a));

    // Otro asesor no ve lo ajeno; Cartera, quien administra créditos y el admin ven todo
    expect((await ag.asesor2.get(`/api/creditos/asociados/${A.a6}/documentos`)).body.some((d) => d.solicitud_id === id)).toBe(false);
    for (const quien of ['cartera', 'admin', 'root']) {
      expect((await ag[quien].get(`/api/creditos/asociados/${A.a6}/documentos`)).body.some((d) => d.solicitud_id === id)).toBe(true);
    }
    // Un asociado sin solicitudes devuelve lista vacía
    expect((await ag.root.get('/api/creditos/asociados/NOEXISTE99/documentos')).body).toEqual([]);
  });

  test('sin permiso de Créditos ni de Cartera no se consulta', async () => {
    expect((await ag.nada.get(`/api/creditos/asociados/${A.a6}/documentos`)).status).toBe(403);
    expect((await request(app).get(`/api/creditos/asociados/${A.a6}/documentos`)).status).toBe(401);
  });

  test('abrir un archivo desde el perfil devuelve un enlace temporal y queda en el historial', async () => {
    const res = await ag.cartera.get(`/api/creditos/asociados/${A.a6}/documentos/${firmadoArchivo}/url`);
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https?:\/\//);
    expect((await ag.asesor.get(`/api/creditos/asociados/${A.a6}/documentos/${soporteArchivo}/url`)).status).toBe(200);   // soporte de la autorización
    const vistas = (await detalle(id)).eventos.filter((e) => e.tipo === 'documento_visto' && e.detalle.desde === 'perfil_asociado');
    expect(vistas.length).toBeGreaterThanOrEqual(2);
    expect(vistas.map((v) => v.autor_nombre).every(Boolean)).toBe(true);
  });

  test('no abre archivos ajenos, de otro asociado ni inexistentes', async () => {
    const url = (codigo, archivo, quien) => ag[quien].get(`/api/creditos/asociados/${codigo}/documentos/${archivo}/url`);
    expect((await url(A.a6, firmadoArchivo, 'asesor2')).status).toBe(404);          // asesor ajeno
    expect((await url(A.a1, firmadoArchivo, 'cartera')).status).toBe(404);          // el archivo es de otro asociado
    expect((await url(A.a6, crypto.randomUUID(), 'cartera')).status).toBe(404);
    expect((await url(A.a6, 'no-es-uuid', 'cartera')).status).toBe(404);
    expect((await url(A.a6, firmadoArchivo, 'nada')).status).toBe(403);
  });

  test('lo retirado sigue en la lista, marcado sin vigencia', async () => {
    const adj = (await ag.asesor.get(`/api/creditos/asociados/${A.a6}/documentos`)).body.find((d) => d.solicitud_id === id && d.clase === 'adjunto');
    expect((await ag.asesor.delete(`/api/creditos/${id}/documentos/${adj.id}`)).status).toBe(200);
    const despues = (await ag.asesor.get(`/api/creditos/asociados/${A.a6}/documentos`)).body.find((d) => d.id === adj.id);
    expect(despues).toMatchObject({ vigente: false });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Robustez: restricciones de la base de datos, concurrencia, correo en cola, integridad y filtros
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════════

describe('Créditos — Restricciones de la base de datos', () => {
  let id; let borradorId; let firmado;

  test('prepara una solicitud con un documento firmado', async () => {
    id = (await radicar(A.a6, { valor_solicitado: 3000000 })).solicitud.id;
    borradorId = (await subirBorrador(id, 'pagare')).doc.id;
    const f = await firmarExterna(id, borradorId);
    expect(f.status).toBe(201);
    firmado = f.body;
  });

  test('el monto a desembolsar no puede superar el valor solicitado (CHECK)', async () => {
    await expect(pool.query('UPDATE credito_solicitudes SET monto_desembolso = valor_solicitado + 1 WHERE id = $1', [id])).rejects.toThrow(/chk_credito_monto/);
  });

  test('el monto a desembolsar puede quedar vacío (lo calcula Cartera) o ser menor que el valor sin motivo', async () => {
    await pool.query('UPDATE credito_solicitudes SET monto_desembolso = NULL WHERE id = $1', [id]);
    await pool.query('UPDATE credito_solicitudes SET monto_desembolso = valor_solicitado - 1 WHERE id = $1', [id]);
    await pool.query('UPDATE credito_solicitudes SET monto_desembolso = NULL WHERE id = $1', [id]);
  });

  test('valores inválidos de estado, canal, forma y modalidad se rechazan (CHECK)', async () => {
    for (const [col, val] of [['estado', 'inventado'], ['canal_origen', 'fax'], ['forma_desembolso', 'trueque'], ['modalidad_firma', 'otra'], ['autorizacion_momento', 'nunca']]) {
      await expect(pool.query(`UPDATE credito_solicitudes SET ${col} = $2 WHERE id = $1`, [id, val])).rejects.toThrow(/check constraint/);
    }
    await expect(pool.query('UPDATE credito_solicitudes SET valor_solicitado = 0 WHERE id = $1', [id])).rejects.toThrow(/check constraint/);
  });

  test('una autorización aprobada exige fecha y soporte (CHECK)', async () => {
    await expect(pool.query(`INSERT INTO credito_autorizaciones (solicitud_id, estado) VALUES ($1, 'aprobada')`, [id])).rejects.toThrow(/chk_autorizacion_soporte/);
    await expect(pool.query(`INSERT INTO credito_autorizaciones (solicitud_id, estado) VALUES ($1, 'quizas')`, [id])).rejects.toThrow(/check constraint/);
  });

  test('un documento a firmar tiene, como mucho, un firmado vigente (índice único)', async () => {
    await expect(pool.query(
      `INSERT INTO credito_documentos (solicitud_id, clase, tipo, nombre, archivo_id, sha256, borrador_id) VALUES ($1, 'firmado', 'pagare', 'otro.pdf', $2, $3, $4)`,
      [id, firmado.archivo_id, 'f'.repeat(64), borradorId])).rejects.toThrow(/uq_credito_doc_firmado/);
    await expect(pool.query(`INSERT INTO credito_documentos (solicitud_id, clase, tipo, nombre, archivo_id, sha256) VALUES ($1, 'inventada', 'x', 'x', $2, $3)`,
      [id, firmado.archivo_id, 'f'.repeat(64)])).rejects.toThrow(/check constraint/);
  });

  test('no se puede borrar un asociado, una empresa ni una solicitud con historia (RESTRICT)', async () => {
    await expect(pool.query('DELETE FROM asociados WHERE codigo = $1', [A.a6])).rejects.toThrow(/foreign key/);
    await expect(pool.query('DELETE FROM empresas WHERE codigo = $1', [E.e1])).rejects.toThrow(/foreign key/);
    await expect(pool.query('DELETE FROM credito_solicitudes WHERE id = $1', [id])).rejects.toThrow(/foreign key/);
  });

  test('la línea de tiempo no admite cambios de fondo, pero sí que el autor pase a NULL', async () => {
    const { rows: [ev] } = await pool.query('SELECT id FROM credito_eventos WHERE solicitud_id = $1 LIMIT 1', [id]);
    for (const col of ["tipo = 'x'", "detalle = '{}'", 'created_at = NOW()']) {
      await expect(pool.query(`UPDATE credito_eventos SET ${col} WHERE id = $1`, [ev.id])).rejects.toThrow(/solo agregar/);
    }
    await expect(pool.query('DELETE FROM credito_eventos WHERE id = $1', [ev.id])).rejects.toThrow(/solo agregar/);
  });

  test('la numeración del radicado es única y creciente aunque se radique en paralelo', async () => {
    const lote = await Promise.all(Array.from({ length: 4 }, () => ag.asesor.post('/api/creditos').send(cuerpo(A.a6))));
    expect(lote.every((r) => r.status === 201)).toBe(true);
    const numeros = lote.map((r) => Number(r.body.solicitud.radicado.split('-')[2]));
    expect(new Set(numeros).size).toBe(4);
    expect(lote.map((r) => r.body.solicitud.radicado).every((r) => /^CR-\d{4}-\d{6}$/.test(r))).toBe(true);
  });

  test('la misma clave de idempotencia enviada en paralelo crea una sola solicitud', async () => {
    const clave = crypto.randomUUID();
    const res = await Promise.all(Array.from({ length: 4 }, () => ag.asesor.post('/api/creditos').send(cuerpo(A.a6, { clave }))));
    expect(res.every((r) => [200, 201].includes(r.status))).toBe(true);
    expect(new Set(res.map((r) => r.body.solicitud.id)).size).toBe(1);
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM credito_solicitudes WHERE clave_idempotencia = $1', [clave])).rows[0].n).toBe(1);
  });
});

describe('Créditos — Reglas de la vista de pistas (v_credito_pistas)', () => {
  test('retirar el documento sin firmar completa la pista de firma', async () => {
    const id = (await radicar(A.a6)).solicitud.id;
    const a = (await subirBorrador(id, 'pagare')).doc;
    const b = (await subirBorrador(id, 'libranza')).doc;
    expect((await firmarExterna(id, a.id)).status).toBe(201);
    expect((await detalle(id)).pistas).toMatchObject({ a_firmar: 2, firmados: 1, firma_completa: false });
    expect((await ag.asesor.delete(`/api/creditos/${id}/documentos/${b.id}`)).status).toBe(200);
    expect((await detalle(id)).pistas).toMatchObject({ a_firmar: 1, firmados: 1, firma_completa: true });
  });

  test('sin documentos a firmar, la firma nunca está completa', async () => {
    const id = (await radicar(A.a6)).solicitud.id;
    expect((await detalle(id)).pistas).toMatchObject({ a_firmar: 0, firma_completa: false, listo: false, expediente_completo: false });
  });

  test('cambiar la forma de desembolso recalcula si se exige el certificado, sin invalidar la firma', async () => {
    const id = (await radicar(A.a6, { forma_desembolso: 'cheque' })).solicitud.id;
    await completar(id);
    expect((await detalle(id)).pistas).toMatchObject({ documentos_ok: true, certificado_requerido: false, listo: true });
    const cambio = await ag.asesor.put(`/api/creditos/${id}`).send({ forma_desembolso: 'transferencia' });
    expect(cambio.body.invalidados).toBe(0);   // la forma de desembolso no cambia lo firmado
    expect((await detalle(id)).pistas).toMatchObject({ firma_completa: true, certificado_requerido: true, documentos_ok: false, listo: false });
    expect((await subirAdjunto(id, 'certificado_bancario')).status).toBe(201);
    expect((await detalle(id)).pistas.listo).toBe(true);
    await ag.asesor.put(`/api/creditos/${id}`).send({ forma_desembolso: 'efectivo' });
    expect((await detalle(id)).pistas).toMatchObject({ certificado_requerido: false, documentos_ok: true, listo: true });
  });

  test('un adjunto retirado deja de contar; uno de otro tipo no sustituye al desprendible', async () => {
    const id = (await radicar(A.a6)).solicitud.id;
    const otro = await subirAdjunto(id, 'otro_adjunto');
    expect((await detalle(id)).pistas.tiene_desprendible).toBe(false);
    const d = await subirAdjunto(id, 'desprendible_nomina');
    expect((await detalle(id)).pistas.tiene_desprendible).toBe(true);
    expect((await ag.asesor.delete(`/api/creditos/${id}/documentos/${d.body.id}`)).status).toBe(200);
    expect((await detalle(id)).pistas.tiene_desprendible).toBe(false);
    expect(otro.status).toBe(201);
  });

  test('entregada, la solicitud sigue "completa" aunque ya no esté "lista" para entregar', async () => {
    const id = (await radicar(A.a6)).solicitud.id;
    await completar(id);
    expect((await ag.asesor.post(`/api/creditos/${id}/entregar`)).status).toBe(200);
    expect((await detalle(id)).pistas).toMatchObject({ listo: false, expediente_completo: true });
    expect((await ag.asesor.post(`/api/creditos/${id}/entregar`)).status).toBe(409);   // no se entrega dos veces
  });
});

describe('Créditos — Correo de autorización: concurrencia', () => {
  test('cinco disparos simultáneos envían un solo correo y crean una sola ronda', async () => {
    const { rows: [s] } = await pool.query(
      `INSERT INTO credito_solicitudes (radicado, asociado_codigo, empresa_codigo, categoria_id, asesor_uuid, canal_origen, valor_solicitado,
         forma_desembolso, modalidad_firma, autorizacion_requerida, autorizacion_momento)
       VALUES ('CR-TEST-' || substr(md5(random()::text), 1, 8), $1, $2, $3, $4, 'presencial', 1000000, 'cheque', 'externa', true, 'indiferente') RETURNING id`,
      [A.a3, E.e3, categoriaId, usuarios.asesor.id]);
    const antes = emailsDePrueba.length;
    const rs = await Promise.all(Array.from({ length: 5 }, () => dispararCorreoAutorizacion(s.id, { emails: ['conc@empresa.test'], actor: usuarios.asesor })));
    expect(rs.filter((r) => r.resultado === 'solicitada')).toHaveLength(1);
    expect(rs.filter((r) => r.resultado === 'ya_solicitada')).toHaveLength(4);
    expect(emailsDePrueba.slice(antes).filter((m) => m.to === 'conc@empresa.test')).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM credito_autorizaciones WHERE solicitud_id = $1', [s.id])).rows[0].n).toBe(1);
  });

  test('"enviar de nuevo" fuerza una ronda nueva aunque ya haya una solicitada', async () => {
    const r = await radicar(A.a1);
    const antes = emailsDePrueba.length;
    const otra = await ag.asesor.post(`/api/creditos/${r.solicitud.id}/autorizacion/enviar`).send({ emails: ['reenvio@empresa.test'] });
    expect(otra.body.resultado).toBe('solicitada');
    expect(emailsDePrueba.slice(antes).map((m) => m.to)).toContain('reenvio@empresa.test');
    expect((await detalle(r.solicitud.id)).autorizaciones).toHaveLength(2);
  });

  test('una solicitud que no requiere autorización no dispara ni permite enviar correo', async () => {
    const r = await radicar(A.a5);
    expect((await ag.asesor.post(`/api/creditos/${r.solicitud.id}/autorizacion/enviar`).send({})).status).toBe(409);
    expect((await autorizar(r.solicitud.id)).status).toBe(409);
  });
});

describe('Créditos — Resultado del correo cuando pasa por la cola', () => {
  const emailsUnicos = () => [`cola-${crypto.randomBytes(4).toString('hex')}@empresa.test`];
  const rondaYCola = async (id) => {
    const ronda = (await detalle(id)).autorizaciones[0];
    const { rows: [cola] } = await pool.query(`SELECT * FROM email_cola WHERE referencia_tipo = 'credito_autorizacion' AND referencia_id = $1`, [ronda.id]);
    return { ronda, cola };
  };
  const yaToca = (cid, extra = '') => pool.query(`UPDATE email_cola SET proximo_intento = NOW() - INTERVAL '1 second' ${extra} WHERE id = $1`, [cid]);
  afterEach(() => { simulacionDePrueba.fallar = false; });

  test('si el canal falla el correo queda en cola con el Reply-To del asesor y la solicitud sigue como "solicitada"', async () => {
    simulacionDePrueba.fallar = true;
    const [to] = emailsUnicos();
    const r = await radicar(A.a3, { emails_autorizacion: [to] });
    expect(r.correo.resultado).toBe('solicitada');
    const { ronda, cola } = await rondaYCola(r.solicitud.id);
    expect(ronda.estado).toBe('solicitada');
    expect(cola).toMatchObject({ destinatario: to, reply_to: usuarios.asesor.email, estado: 'pendiente' });
  });

  test('cuando el correo en cola sale, queda registrado en la línea de tiempo', async () => {
    simulacionDePrueba.fallar = true;
    const r = await radicar(A.a3, { emails_autorizacion: emailsUnicos() });
    const { cola } = await rondaYCola(r.solicitud.id);
    simulacionDePrueba.fallar = false;
    await yaToca(cola.id);
    const antes = emailsDePrueba.length;
    expect((await procesarCola({ ids: [cola.id] })).enviados).toBe(1);
    expect(emailsDePrueba[antes]).toMatchObject({ to: cola.destinatario, replyTo: usuarios.asesor.email });
    const d = await detalle(r.solicitud.id);
    expect(d.eventos.map((e) => e.tipo)).toContain('correo_enviado');
    expect(d.pistas.autorizacion_estado).toBe('solicitada');
  });

  test('si se agotan los intentos: evento, la ronda pasa a "sin destinatario" y se avisa al asesor', async () => {
    simulacionDePrueba.fallar = true;
    const r = await radicar(A.a3, { emails_autorizacion: emailsUnicos() });
    const { cola } = await rondaYCola(r.solicitud.id);
    await pool.query('DELETE FROM notificaciones WHERE usuario_uuid = $1', [usuarios.asesor.id]);
    await yaToca(cola.id, `, intentos = ${MAX_INTENTOS - 1}`);
    expect((await procesarCola({ ids: [cola.id] })).fallidos).toBe(1);
    const d = await detalle(r.solicitud.id);
    expect(d.eventos.find((e) => e.tipo === 'correo_fallido').detalle.mensaje).toMatch(/tras \d+ intentos/);
    expect(d.pistas.autorizacion_estado).toBe('sin_destinatario');
    expect(d.faltantes.join(' ')).toMatch(/Falta el correo de la empresa/);
    const { rows } = await pool.query('SELECT mensaje FROM notificaciones WHERE usuario_uuid = $1', [usuarios.asesor.id]);
    expect(rows.some((n) => /No se pudo enviar el correo de autorización/.test(n.mensaje) && n.mensaje.includes(r.solicitud.radicado))).toBe(true);
  });

  test('si la dirección se suprime mientras esperaba en cola: evento y "sin destinatario"', async () => {
    simulacionDePrueba.fallar = true;
    const [to] = emailsUnicos();
    const r = await radicar(A.a3, { emails_autorizacion: [to] });
    const { cola } = await rondaYCola(r.solicitud.id);
    await pool.query(`INSERT INTO email_supresiones (email, motivo) VALUES ($1, 'rebote')`, [to]);
    simulacionDePrueba.fallar = false;
    await yaToca(cola.id);
    expect((await procesarCola({ ids: [cola.id] })).suprimidos).toBe(1);
    const d = await detalle(r.solicitud.id);
    expect(d.eventos.map((e) => e.tipo)).toContain('correo_suprimido');
    expect(d.pistas.autorizacion_estado).toBe('sin_destinatario');
  });

  test('si la dirección ya estaba suprimida al radicar, no se encola: queda "sin destinatario" de inmediato', async () => {
    const [to] = emailsUnicos();
    await pool.query(`INSERT INTO email_supresiones (email, motivo) VALUES ($1, 'rebote')`, [to]);
    const r = await radicar(A.a3, { emails_autorizacion: [to] });
    expect(r.correo.resultado).toBe('sin_destinatario');
    expect((await detalle(r.solicitud.id)).pistas.autorizacion_estado).toBe('sin_destinatario');
    expect((await pool.query(`SELECT count(*)::int AS n FROM email_cola WHERE destinatario = $1`, [to])).rows[0].n).toBe(0);
  });

  test('con varias direcciones, basta que una salga para que la ronda siga "solicitada"', async () => {
    const [bueno] = emailsUnicos(); const [malo] = emailsUnicos();
    await pool.query(`INSERT INTO email_supresiones (email, motivo) VALUES ($1, 'rebote')`, [malo]);
    const antes = emailsDePrueba.length;
    const r = await radicar(A.a3, { emails_autorizacion: [bueno, malo] });
    expect(r.correo.resultado).toBe('solicitada');
    expect(emailsDePrueba.slice(antes).map((m) => m.to)).toEqual([bueno]);
  });
});

describe('Créditos — Integridad y archivos protegidos', () => {
  let id; let radicado; let firmadoDoc; let evidenciaDoc;

  test('prepara un expediente entregado', async () => {
    const r = await radicar(A.a1);
    id = r.solicitud.id; radicado = r.solicitud.radicado;
    const { doc } = await subirBorrador(id, 'pagare');
    const f = await firmarExterna(id, doc.id);
    expect(f.status).toBe(201);
    expect((await autorizar(id)).status).toBe(201);
    expect((await subirAdjunto(id, 'desprendible_nomina')).status).toBe(201);
    expect((await ag.asesor.post(`/api/creditos/${id}/entregar`)).status).toBe(200);
    const d = await detalle(id);
    firmadoDoc = d.documentos.find((x) => x.clase === 'firmado');
    evidenciaDoc = d.documentos.find((x) => x.clase === 'evidencia_externa');
    expect(firmadoDoc && evidenciaDoc).toBeTruthy();
  });

  test('los archivos de firma, evidencia y autorización son evidencia protegida: no se pueden eliminar', async () => {
    const d = await detalle(id);
    for (const archivoId of [firmadoDoc.archivo_id, evidenciaDoc.archivo_id, d.autorizaciones[0].archivo_id]) {
      await expect(eliminarArchivo(archivoId, { omitirS3: true })).rejects.toMatchObject({ code: 'ARCHIVO_PROTEGIDO' });
    }
    const { rows } = await pool.query('SELECT entidad_tipo FROM archivos WHERE id = ANY($1)', [[firmadoDoc.archivo_id, evidenciaDoc.archivo_id, d.autorizaciones[0].archivo_id]]);
    expect(rows.map((r) => r.entidad_tipo).sort()).toEqual(['credito_autorizacion', 'credito_evidencia', 'credito_firmado']);
  });

  test('si un archivo guardado se altera, la verificación lo detecta y el resumen del ZIP lo marca', async () => {
    const bien = (await ag.cartera.get(`/api/cartera/${id}/integridad`)).body;
    expect(bien.length).toBeGreaterThanOrEqual(2);
    expect(bien.every((x) => x.integro)).toBe(true);

    const { rows: [a] } = await pool.query('SELECT s3_key FROM archivos WHERE id = $1', [firmadoDoc.archivo_id]);
    colocarObjetoDePrueba(a.s3_key, Buffer.from('%PDF-1.4\ncontenido alterado después de firmar'));
    const mal = (await ag.cartera.get(`/api/cartera/${id}/integridad`)).body;
    expect(mal.find((x) => x.id === firmadoDoc.id).integro).toBe(false);
    expect(mal.filter((x) => x.id !== firmadoDoc.id).every((x) => x.integro)).toBe(true);

    const binario = (r, cb) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); };
    const zip = await ag.cartera.get(`/api/cartera/${id}/expediente`).buffer(true).parse(binario);
    const { unzipSync, strFromU8 } = await import('fflate');
    const resumen = strFromU8(unzipSync(new Uint8Array(zip.body))['0_resumen.txt']);
    expect(resumen).toContain('¡NO COINCIDE CON EL REGISTRO!');
    expect(resumen).toContain(radicado);
  });

  test('si el archivo desaparece del almacenamiento, el resumen lo dice en vez de fallar', async () => {
    const { rows: [a] } = await pool.query('SELECT s3_key FROM archivos WHERE id = $1', [evidenciaDoc.archivo_id]);
    // El almacenamiento de pruebas guarda en memoria: se sobrescribe con contenido vacío para simular un objeto perdido
    colocarObjetoDePrueba(a.s3_key, Buffer.alloc(0));
    const integ = (await ag.cartera.get(`/api/cartera/${id}/integridad`)).body;
    expect(integ.find((x) => x.id === firmadoDoc.id)).toBeTruthy();
  });

  test('el ZIP incluye el número de archivos descargados en el historial y es solo para entregadas o recibidas', async () => {
    const ev = (await detalle(id)).eventos.filter((e) => e.tipo === 'expediente_descargado');
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(ev[0].detalle.archivos).toBeGreaterThanOrEqual(2);
    const devuelta = (await ag.cartera.post(`/api/cartera/${id}/devolver`).send({ motivo: 'Para probar el estado devuelto' }));
    expect(devuelta.status).toBe(200);
    expect((await ag.cartera.get(`/api/cartera/${id}/expediente`)).status).toBe(409);   // devuelta: ya no está en manos de Cartera
  });
});

describe('Créditos — Listas, filtros y bandejas', () => {
  test('filtra por estado y por texto (radicado, cédula o nombre), y ignora búsquedas de un carácter', async () => {
    const r = await radicar(A.a3);
    const lista = async (q) => (await ag.asesor.get('/api/creditos').query(q)).body;
    expect((await lista({ q: r.solicitud.radicado })).map((x) => x.id)).toEqual([r.solicitud.id]);
    expect((await lista({ q: 'ZZCRT003' })).every((x) => x.asociado_codigo === A.a3)).toBe(true);
    expect((await lista({ q: 'CREDITOS ZZCRT003' })).length).toBeGreaterThan(0);
    expect((await lista({ q: 'noexisteningunoasi' }))).toEqual([]);
    expect((await lista({ q: 'x' })).length).toBeGreaterThan(1);   // un carácter no filtra
    const enTramite = await lista({ estado: 'en_tramite' });
    expect(enTramite.length).toBeGreaterThan(0);
    expect(enTramite.every((x) => x.estado === 'en_tramite')).toBe(true);
    expect((await lista({ estado: 'recibida' })).every((x) => x.estado === 'recibida')).toBe(true);
  });

  test('cada fila trae el semáforo del expediente y los días en trámite', async () => {
    const fila = (await ag.asesor.get('/api/creditos').query({ estado: 'en_tramite' })).body[0];
    for (const k of ['a_firmar', 'firmados', 'firma_completa', 'autorizacion_requerida', 'autorizacion_ok', 'documentos_ok', 'listo', 'expediente_completo', 'dias', 'categoria', 'empresa_nombre', 'asociado_nombre']) {
      expect(fila).toHaveProperty(k);
    }
    expect(Number(fila.dias)).toBeGreaterThanOrEqual(0);
  });

  test('las lista van de la más reciente a la más antigua', async () => {
    const fechas = (await ag.asesor.get('/api/creditos')).body.map((x) => new Date(x.created_at).getTime());
    expect(fechas).toEqual([...fechas].sort((a, b) => b - a));
  });

  test('"ver todas" solo tiene efecto para quien administra: un asesor sigue viendo lo suyo', async () => {
    const propia = await radicar(A.a3);
    const conTodas = (await ag.asesor2.get('/api/creditos').query({ todas: 1 })).body;
    expect(conTodas.some((x) => x.id === propia.solicitud.id)).toBe(false);
    expect((await ag.root.get('/api/creditos').query({ todas: 1 })).body.some((x) => x.id === propia.solicitud.id)).toBe(true);
  });

  test('la bandeja de Cartera filtra por texto y ordena lo entregado de más antiguo a más reciente', async () => {
    const entregar = async (asoc) => { const r = await radicar(asoc); await completar(r.solicitud.id); expect((await ag.asesor.post(`/api/creditos/${r.solicitud.id}/entregar`)).status).toBe(200); return r.solicitud; };
    const a = await entregar(A.a1); const b = await entregar(A.a1);
    const lista = (await ag.cartera.get('/api/cartera').query({ tab: 'entregadas' })).body;
    const iA = lista.findIndex((x) => x.id === a.id); const iB = lista.findIndex((x) => x.id === b.id);
    expect(iA).toBeGreaterThanOrEqual(0);
    expect(iA).toBeLessThan(iB);   // primero el que lleva más tiempo esperando
    expect((await ag.cartera.get('/api/cartera').query({ tab: 'entregadas', q: b.radicado })).body.map((x) => x.id)).toEqual([b.id]);
    expect((await ag.cartera.get('/api/cartera').query({ tab: 'entregadas', q: 'zzzz-no-existe' })).body).toEqual([]);
    expect((await ag.cartera.get('/api/cartera').query({ tab: 'recibidas' })).body.some((x) => x.id === a.id)).toBe(false);
    expect((await ag.cartera.get('/api/cartera')).body.every((x) => x.estado === 'entregada')).toBe(true);   // por defecto: por recibir
  });

  test('las solicitudes en trámite aparecen en la pestaña "por llegar" de Cartera, no en "por recibir"', async () => {
    const r = await radicar(A.a3);
    expect((await ag.cartera.get('/api/cartera').query({ tab: 'por_llegar' })).body.some((x) => x.id === r.solicitud.id)).toBe(true);
    expect((await ag.cartera.get('/api/cartera').query({ tab: 'entregadas' })).body.some((x) => x.id === r.solicitud.id)).toBe(false);
  });

  test('un identificador de solicitud mal formado responde con error controlado, no 500', async () => {
    const res = await ag.asesor.get('/api/creditos/no-es-uuid');
    expect(res.status).toBeLessThan(500);
    const cart = await ag.cartera.get('/api/cartera/no-es-uuid');
    expect(cart.status).toBeLessThan(500);
  });
});
