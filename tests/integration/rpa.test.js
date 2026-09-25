import request from 'supertest';
import bcrypt from 'bcrypt';
import { jest } from '@jest/globals';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';

jest.setTimeout(30000);

let app;
const pass = 'testpass123';
const EMPRESA = 'EMP-RPA-TEST';
const CED = { a: '88801001', b: '88801002', c: '88801003', asesor: '88809999' };
const u = {
  admin : { email: 'rpa-test@icebreaker.com',  permisos: ['READ', 'WRITE', 'APROBAR', 'ADMIN'], id: null },
  lector: { email: 'rpa-lector@icebreaker.com', permisos: ['READ'], id: null },
  asesor: { email: 'rpa-asesor@icebreaker.com', permisos: [], id: null },
};
const e = { vinc: {}, agenteId: null, token: null };
const PNG_B64 = Buffer.alloc(300, 7).toString('base64'); // contenido cualquiera: solo se prueba el guardado
const captura = { etiqueta: 'pagina1', mime: 'image/jpeg', base64: PNG_B64 };

const login = async (quien) => {
  const ag = request.agent(app);
  await ag.post('/api/auth/login').send({ email: u[quien].email, password: pass });
  return ag;
};
let admin; let lector;
const agente = (metodo, ruta, body) => request(app)[metodo](`/api/rpa/agente${ruta}`).set('Authorization', `Bearer ${e.token}`).send(body);

const limpiar = async () => {
  await pool.query(`DELETE FROM rpa_jobs WHERE cedula LIKE '888010%'`);
  await pool.query(`DELETE FROM rpa_agentes WHERE nombre LIKE 'agente-test-%'`);
  await pool.query(`DELETE FROM rpa_equivalencias WHERE creado_por = ANY($1)`, [[u.admin.id].filter(Boolean)]);
  await pool.query(`DELETE FROM asociados WHERE codigo LIKE '888010%'`);
  await pool.query(`DELETE FROM captacion_vinculaciones WHERE prospecto_id IN (SELECT id FROM captacion_prospectos WHERE cedula LIKE '888010%')`);
  await pool.query(`DELETE FROM captacion_prospectos WHERE cedula LIKE '888010%'`);
};

const nuevaVinculacion = async (cedula, extra = {}) => {
  const { rows: [p] } = await pool.query(
    `INSERT INTO captacion_prospectos (empresa_codigo, asesor_uuid, nombres, apellidos, cedula, celular, correo, token_hash)
     VALUES ($1, $2, 'Ana', 'Prueba Rpa', $3::varchar, '3100000000', 'ana.rpa@example.com', md5(random()::text) || md5($3::text)) RETURNING id`,
    [EMPRESA, u.asesor.id, cedula]);
  const { rows: [v] } = await pool.query(
    `INSERT INTO captacion_vinculaciones
       (prospecto_id, estado, tipo_documento, ciudad_expedicion, fecha_expedicion, fecha_nacimiento, ciudad_nacimiento, departamento_nacimiento,
        direccion_residencia, ciudad_residencia, departamento_residencia, genero, estado_civil, estrato, profesion, cargo,
        ciudad_trabajo, departamento_trabajo, fecha_ingreso, ingresos_mensuales, egresos_mensuales, total_pasivos, total_activos, periodicidad_descuento, valor_aporte)
     VALUES ($1, $2, 'CC', 'Pereira', '2010-01-01', '1990-02-03', 'Pereira', 'Risaralda',
        'Calle 1 # 2-3', 'Pereira', 'Risaralda', 'F', 'soltero', 3, 'Operario RPA', 'Auxiliar',
        'Pereira', 'Risaralda', '2020-01-01', 2000000, 1000000, 200000, 3000000, 'mensual', 80000) RETURNING id`,
    [p.id, extra.estado ?? 'entregada']);
  return v.id;
};

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  for (const x of Object.values(u)) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
       VALUES ('Rpa Test', $1, $2, 'asesor', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true RETURNING id`, [x.email, hash]);
    x.id = r.id;
    await pool.query(`DELETE FROM permisos WHERE usuario_uuid = $1`, [x.id]);
    if (x.permisos.length) {
      await pool.query(
        `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
         SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'rpa' AND a.nombre = ANY($2) ON CONFLICT DO NOTHING`, [x.id, x.permisos]);
    }
  }
  await pool.query(`UPDATE global_usuarios SET cedula = NULL WHERE cedula = $1`, [CED.asesor]);
  await pool.query(`UPDATE global_usuarios SET cedula = $2, nombre = 'Asesora Prueba Rpa' WHERE id = $1`, [u.asesor.id, CED.asesor]);
  await pool.query(`INSERT INTO empresas (codigo, nombre) VALUES ($1, 'Empresa Rpa Test') ON CONFLICT (codigo) DO UPDATE SET is_active = true`, [EMPRESA]);
  await limpiar();
  admin = await login('admin');
  lector = await login('lector');
  e.vinc.a = await nuevaVinculacion(CED.a);
  e.vinc.b = await nuevaVinculacion(CED.b);
  e.vinc.borrador = await nuevaVinculacion(CED.c, { estado: 'borrador' });
});

afterAll(async () => {
  await limpiar();
  await pool.query(`DELETE FROM rpa_equivalencias WHERE texto_original IN ('Pereira, Risaralda','Operario RPA') OR texto_norm = $1`, [EMPRESA.toLowerCase()]);
  await pool.query(`DELETE FROM permisos WHERE usuario_uuid = ANY($1)`, [Object.values(u).map((x) => x.id)]);
  await pool.query(`UPDATE global_usuarios SET cedula = NULL WHERE id = $1`, [u.asesor.id]);
  await pool.query(`DELETE FROM global_usuarios WHERE email LIKE 'rpa-%@icebreaker.com'`);
  await pool.query(`DELETE FROM empresas WHERE codigo = $1`, [EMPRESA]);
  await pool.end();
});

describe('RPA — Auth', () => {
  test('sin cookie las rutas de empleados dan 401', async () => {
    expect((await request(app).get('/api/rpa/jobs')).status).toBe(401);
  });
  test('sin token de agente las rutas del agente dan 401', async () => {
    expect((await request(app).post('/api/rpa/agente/reclamar').send({})).status).toBe(401);
    expect((await request(app).post('/api/rpa/agente/reclamar').set('Authorization', 'Bearer rpa_tokeninventado_1234567890').send({})).status).toBe(401);
  });
  test('un lector no puede encolar, aprobar ni administrar', async () => {
    expect((await lector.post('/api/rpa/jobs').send({ vinculacion_id: e.vinc.a })).status).toBe(403);
    expect((await lector.post('/api/rpa/agentes').send({ nombre: 'agente-test-x' })).status).toBe(403);
    expect((await lector.put(`/api/rpa/usuarios/${u.asesor.id}/cedula`).send({ cedula: '123456' })).status).toBe(403);
  });
  test('el token de un empleado no sirve como token de agente', async () => {
    const r = await request(app).post('/api/rpa/agente/reclamar').set('Authorization', 'Bearer rpa_' + 'a'.repeat(40)).send({});
    expect(r.status).toBe(401);
  });
});

describe('RPA — Validación', () => {
  test('encolar exige un uuid', async () => {
    expect((await admin.post('/api/rpa/jobs').send({ vinculacion_id: 'x' })).status).toBe(400);
    expect((await admin.post('/api/rpa/jobs').send({})).status).toBe(400);
  });
  test('la cédula del usuario solo admite dígitos', async () => {
    expect((await admin.put(`/api/rpa/usuarios/${u.asesor.id}/cedula`).send({ cedula: '12ab' })).status).toBe(400);
  });
  test('equivalencia con catálogo desconocido o campos extra → 400', async () => {
    expect((await admin.post('/api/rpa/equivalencias').send({ catalogo: 'planeta', texto: 'x', codigo_solido: '1' })).status).toBe(400);
    expect((await admin.post('/api/rpa/equivalencias').send({ catalogo: 'cargo', texto: 'x', codigo_solido: '1', extra: 1 })).status).toBe(400);
  });
  test('una vinculación en borrador no se puede encolar', async () => {
    const r = await admin.post('/api/rpa/jobs').send({ vinculacion_id: e.vinc.borrador });
    expect(r.status).toBe(409);
  });
});

describe('RPA — Cédula de los asesores', () => {
  test('sugiere por nombre a partir del padrón y no asigna nada por sí sola', async () => {
    await pool.query(
      `INSERT INTO asociados (codigo, apellido, nombre, password_hash) VALUES ('888010777', 'PRUEBA RPA', 'ASESORA', 'x') ON CONFLICT (codigo) DO NOTHING`);
    await pool.query(`UPDATE global_usuarios SET cedula = NULL WHERE id = $1`, [u.asesor.id]);
    const r = await admin.get('/api/rpa/asesores/cedulas-sugeridas');
    expect(r.status).toBe(200);
    const fila = r.body.find((x) => x.usuario_id === u.asesor.id);
    expect(fila.candidatos.map((c) => c.codigo)).toContain('888010777');
    expect(['exacta', 'parcial', 'multiple']).toContain(fila.coincidencia);
    const { rows: [db] } = await pool.query(`SELECT cedula FROM global_usuarios WHERE id = $1`, [u.asesor.id]);
    expect(db.cedula).toBeNull();
  });
  test('asignar la cédula avisa si no está en el padrón', async () => {
    const r = await admin.put(`/api/rpa/usuarios/${u.asesor.id}/cedula`).send({ cedula: CED.asesor });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ cedula: CED.asesor, en_padron: false });
  });
});

describe('RPA — Cola y equivalencias', () => {
  test('sin equivalencias el job queda en requiere_datos y lista qué falta', async () => {
    const r = await admin.post('/api/rpa/jobs').send({ vinculacion_id: e.vinc.a });
    expect(r.status).toBe(201);
    expect(r.body.estado).toBe('requiere_datos');
    e.jobA = r.body.id;
    const campos = r.body.faltantes.map((f) => f.campo);
    expect(campos).toContain('ciudad');
    expect(campos).not.toContain('empresa');    // sin equivalencia cae a 0010 Particulares
    expect(campos).not.toContain('profesion');  // ya no se mapea
    const { rows: [v] } = await pool.query(`SELECT solido_estado FROM captacion_vinculaciones WHERE id = $1`, [e.vinc.a]);
    expect(v.solido_estado).toBe('en_cola');
  });

  test('no se puede encolar dos veces la misma vinculación', async () => {
    const r = await admin.post('/api/rpa/jobs').send({ vinculacion_id: e.vinc.a });
    expect(r.status).toBe(409);
  });

  test('crear equivalencias y reevaluar deja el job pendiente', async () => {
    for (const eqv of [
      { catalogo: 'ciudad', texto: 'Pereira', departamento: 'Risaralda', codigo_solido: '66001' },
      { catalogo: 'empresa', texto: EMPRESA, codigo_solido: '0101' },
    ]) {
      const r = await admin.post('/api/rpa/equivalencias').send(eqv);
      expect(r.status).toBe(201);
    }
    const r = await admin.post(`/api/rpa/jobs/${e.jobA}/reevaluar`);
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('pendiente');
    expect(r.body.faltantes).toBeNull();
  });

  test('una equivalencia repetida se actualiza en vez de duplicarse', async () => {
    const r = await admin.post('/api/rpa/equivalencias').send({ catalogo: 'profesion', texto: 'operario  rpa', codigo_solido: '713' });
    expect(r.status).toBe(201);
    const l = await admin.get('/api/rpa/equivalencias?catalogo=profesion');
    expect(l.body.filter((x) => x.texto_norm === 'operario rpa')).toHaveLength(1);
  });

  test('una cédula que ya está en el padrón se marca ya_existe sin llegar al agente', async () => {
    await pool.query(`INSERT INTO asociados (codigo, apellido, nombre, password_hash) VALUES ($1, 'YA', 'EXISTE', 'x') ON CONFLICT (codigo) DO NOTHING`, [CED.b]);
    const r = await admin.post('/api/rpa/jobs').send({ vinculacion_id: e.vinc.b });
    expect(r.status).toBe(201);
    expect(r.body.estado).toBe('ya_existe');
    const { rows: [v] } = await pool.query(`SELECT solido_estado FROM captacion_vinculaciones WHERE id = $1`, [e.vinc.b]);
    expect(v.solido_estado).toBe('ya_existe');
    await pool.query(`DELETE FROM asociados WHERE codigo = $1`, [CED.b]);
  });
});

describe('RPA — Ciclo del agente', () => {
  test('crear agente devuelve el token una sola vez y en la base solo queda su hash', async () => {
    const r = await admin.post('/api/rpa/agentes').send({ nombre: 'agente-test-1' });
    expect(r.status).toBe(201);
    expect(r.body.token).toMatch(/^rpa_/);
    e.agenteId = r.body.id; e.token = r.body.token;
    const { rows: [a] } = await pool.query(`SELECT token_hash, permite_guardar FROM rpa_agentes WHERE id = $1`, [e.agenteId]);
    expect(a.token_hash).not.toContain(e.token);
    expect(a.permite_guardar).toBe(false);
    const l = await admin.get('/api/rpa/agentes');
    expect(JSON.stringify(l.body)).not.toContain(e.token);
  });

  test('latido registra la versión', async () => {
    const r = await agente('post', '/latido', { version: '0.1.0', huella_ui: 'abc' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ pausado: false, permite_guardar: false });
  });

  test('reclamar entrega el payload con las reglas fijas y pasa el job a llenando', async () => {
    const r = await agente('post', '/reclamar', {});
    expect(r.status).toBe(200);
    expect(r.body.job).toMatchObject({ id: e.jobA, fase: 'llenar', cedula: CED.a });
    const p = r.body.job.payload;
    expect(p.pagina1).toMatchObject({ tipo_correo: 'EXTERNO', ciiu: '10', pais_nacimiento: '54', asesor: CED.asesor, ciudad: '66001', empresa: '0101', clase_dscto: 'Nomina', periodo_dcto: 'Mensual' });
    expect(p.pagina1.ciudad_envio).toBeNull();
    expect(p.pagina2).toMatchObject({ tipo_salario: '2- ley 50', codigo_interno: CED.a, jornada_laboral: 'Total', profesion: null, cargo: null });
    expect(p.pagina3).toEqual({ egresos: 1000000, deudas_terceros: 200000 });
    expect(p.pagina4.segmento).toBe('001');
    const { rows: [j] } = await pool.query(`SELECT estado, intentos FROM rpa_jobs WHERE id = $1`, [e.jobA]);
    expect(j).toMatchObject({ estado: 'llenando', intentos: 1 });
  });

  test('con un job en proceso, otro reclamo no entrega nada más', async () => {
    const r = await agente('post', '/reclamar', {});
    // el mismo agente que reclama de nuevo deja el job anterior por abandonado: vuelve a pendiente y se le entrega otra vez
    expect(r.status).toBe(200);
    expect(r.body.job.id).toBe(e.jobA);
    expect(r.body.job.fase).toBe('llenar');
  });

  test('resultado incoherente con la fase → 409', async () => {
    const r = await agente('post', `/jobs/${e.jobA}/resultado`, { resultado: 'guardado_ok' });
    expect(r.status).toBe(409);
  });

  test('llenado_ok guarda capturas y deja el job esperando aprobación', async () => {
    const r = await agente('post', `/jobs/${e.jobA}/resultado`, { resultado: 'llenado_ok', capturas: [captura, { ...captura, etiqueta: 'pagina2' }] });
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('listo_para_aprobar');
    const d = await admin.get(`/api/rpa/jobs/${e.jobA}`);
    expect(d.body.capturas).toHaveLength(2);
    expect(d.body.payload.pagina4.segmento).toBe('001');
    const img = await admin.get(`/api/rpa/capturas/${d.body.capturas[0].id}`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.headers['cache-control']).toContain('no-store');
  });

  test('otro agente no puede reportar sobre un job ajeno', async () => {
    const otro = await admin.post('/api/rpa/agentes').send({ nombre: 'agente-test-2' });
    const r = await request(app).post(`/api/rpa/agente/jobs/${e.jobA}/resultado`).set('Authorization', `Bearer ${otro.body.token}`).send({ resultado: 'fallido' });
    expect(r.status).toBe(404);
  });

  test('solo se aprueba un job ya llenado; el lector no aprueba', async () => {
    expect((await lector.post(`/api/rpa/jobs/${e.jobA}/aprobar`)).status).toBe(403);
    const r = await admin.post(`/api/rpa/jobs/${e.jobA}/aprobar`);
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('aprobado');
    expect((await admin.post(`/api/rpa/jobs/${e.jobA}/aprobar`)).status).toBe(409);
  });

  test('aprobado NO se entrega mientras el agente no tenga permite_guardar', async () => {
    const r = await agente('post', '/reclamar', {});
    expect(r.body.job).toBeNull();
    const { rows: [j] } = await pool.query(`SELECT estado FROM rpa_jobs WHERE id = $1`, [e.jobA]);
    expect(j.estado).toBe('aprobado');
  });

  test('con permite_guardar se entrega en fase guardar', async () => {
    const p = await admin.put(`/api/rpa/agentes/${e.agenteId}`).send({ permite_guardar: true });
    expect(p.body.permite_guardar).toBe(true);
    const r = await agente('post', '/reclamar', {});
    expect(r.body.job).toMatchObject({ id: e.jobA, fase: 'guardar' });
    const { rows: [j] } = await pool.query(`SELECT estado, guardar_iniciado_at FROM rpa_jobs WHERE id = $1`, [e.jobA]);
    expect(j.estado).toBe('guardando');
    expect(j.guardar_iniciado_at).not.toBeNull();
  });

  test('guardado_ok deja el job cargado y marca la vinculación', async () => {
    const r = await agente('post', `/jobs/${e.jobA}/resultado`, { resultado: 'guardado_ok', detalle: { relectura: 'sin diferencias' } });
    expect(r.body.estado).toBe('cargado');
    const { rows: [v] } = await pool.query(`SELECT solido_estado, solido_cargado_at FROM captacion_vinculaciones WHERE id = $1`, [e.vinc.a]);
    expect(v.solido_estado).toBe('cargado');
    expect(v.solido_cargado_at).not.toBeNull();
  });

  test('un job cargado no se cancela ni se reabre', async () => {
    expect((await admin.post(`/api/rpa/jobs/${e.jobA}/cancelar`)).status).toBe(409);
    expect((await admin.post(`/api/rpa/jobs/${e.jobA}/reevaluar`)).status).toBe(409);
  });
});

describe('RPA — Fallos y seguridad ante duplicados', () => {
  let vinc; let jobId;
  beforeAll(async () => {
    await pool.query(`DELETE FROM asociados WHERE codigo = $1`, [CED.b]);
    await pool.query(`DELETE FROM rpa_jobs WHERE vinculacion_id = $1`, [e.vinc.b]);
    vinc = e.vinc.b;
  });

  test('un fallo reintentable antes de guardar vuelve a pendiente; el que no lo es, queda fallido', async () => {
    const enc = await admin.post('/api/rpa/jobs').send({ vinculacion_id: vinc });
    jobId = enc.body.id;
    expect(enc.body.estado).toBe('pendiente');
    let r = await agente('post', '/reclamar', {});
    expect(r.body.job.id).toBe(jobId);
    r = await agente('post', `/jobs/${jobId}/resultado`, { resultado: 'fallido', error: 'timeout', reintentable: true });
    expect(r.body.estado).toBe('pendiente');
    await agente('post', '/reclamar', {});
    r = await agente('post', `/jobs/${jobId}/resultado`, { resultado: 'fallido', error: 'ventana no encontrada' });
    expect(r.body.estado).toBe('fallido');
  });

  test('un error fatal pausa al agente y no se le entrega nada', async () => {
    await admin.post(`/api/rpa/jobs/${jobId}/reevaluar`);
    await agente('post', '/reclamar', {});
    const r = await agente('post', `/jobs/${jobId}/resultado`, { resultado: 'fallido', error: 'diálogo desconocido', fatal: true, capturas: [captura] });
    expect(r.status).toBe(200);
    const l = await admin.get('/api/rpa/agentes');
    expect(l.body.find((a) => a.id === e.agenteId).pausado).toBe(true);
    await admin.post(`/api/rpa/jobs/${jobId}/reevaluar`);
    expect((await agente('post', '/reclamar', {})).body.job).toBeNull();
    await admin.put(`/api/rpa/agentes/${e.agenteId}`).send({ pausado: false });
  });

  test('tras Guardar, un fallo o una caída NUNCA se reintenta solo: pasa a revisión humana', async () => {
    let r = await agente('post', '/reclamar', {});
    expect(r.body.job.fase).toBe('llenar');
    await agente('post', `/jobs/${jobId}/resultado`, { resultado: 'llenado_ok' });
    await admin.post(`/api/rpa/jobs/${jobId}/aprobar`);
    r = await agente('post', '/reclamar', {});
    expect(r.body.job.fase).toBe('guardar');
    // el agente "se cae" y al arrancar vuelve a pedir trabajo
    r = await agente('post', '/reclamar', {});
    expect(r.body.job).toBeNull();
    const { rows: [j] } = await pool.query(`SELECT estado, error FROM rpa_jobs WHERE id = $1`, [jobId]);
    expect(j.estado).toBe('revision_humana');
    expect(j.error).toMatch(/verifica en SOLIDO/);
    const { rows: [v] } = await pool.query(`SELECT solido_estado FROM captacion_vinculaciones WHERE id = $1`, [vinc]);
    expect(v.solido_estado).toBe('revision');
  });

  test('un job en revisión bloquea un nuevo intento sobre la misma vinculación', async () => {
    expect((await admin.post('/api/rpa/jobs').send({ vinculacion_id: vinc })).status).toBe(409);
  });

  test('una persona lo resuelve tras mirar SOLIDO: exige nota y actualiza la vinculación', async () => {
    expect((await admin.post(`/api/rpa/jobs/${jobId}/resolver`).send({ resultado: 'cargado', nota: 'x' })).status).toBe(400);
    const r = await admin.post(`/api/rpa/jobs/${jobId}/resolver`).send({ resultado: 'no_cargado', nota: 'Verifiqué en SOLIDO: no existe' });
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('cancelado');
    const { rows: [v] } = await pool.query(`SELECT solido_estado FROM captacion_vinculaciones WHERE id = $1`, [vinc]);
    expect(v.solido_estado).toBeNull();
  });

  test('guardado con diferencias también va a revisión', async () => {
    const enc = await admin.post('/api/rpa/jobs').send({ vinculacion_id: vinc });
    await agente('post', '/reclamar', {});
    await agente('post', `/jobs/${enc.body.id}/resultado`, { resultado: 'llenado_ok' });
    await admin.post(`/api/rpa/jobs/${enc.body.id}/aprobar`);
    await agente('post', '/reclamar', {});
    const r = await agente('post', `/jobs/${enc.body.id}/resultado`, { resultado: 'guardado_con_diferencias', detalle: { diferencias: [{ campo: 'direccion' }] } });
    expect(r.body.estado).toBe('revision_humana');
  });

  test('las capturas se purgan a los 30 días', async () => {
    await pool.query(`UPDATE rpa_capturas SET created_at = NOW() - INTERVAL '31 days' WHERE job_id = $1`, [e.jobA]);
    await agente('post', '/latido', {});
    const { rowCount } = await pool.query(`SELECT 1 FROM rpa_capturas WHERE job_id = $1`, [e.jobA]);
    expect(rowCount).toBe(0);
  });
});
