import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import { emailsDePrueba, simulacionDePrueba } from '../../src/services/emailService.js';

let app;
const pass = 'testpass123';
const usuarios = {
  gestor: { email: 'pqrs-gestor@kernel.test', permisos: ['READ', 'WRITE'], id: null },
  lector: { email: 'pqrs-lector@kernel.test', permisos: ['READ'], id: null },
  otro:   { email: 'pqrs-otro@kernel.test',   permisos: ['READ', 'WRITE'], id: null },
  nada:   { email: 'pqrs-nada@kernel.test',   permisos: [], id: null },
};
const CORREO = 'ciudadano-pqrs@ejemplo.test';
const login = async (quien) => {
  const ag = request.agent(app);
  await ag.post('/api/auth/login').send({ email: usuarios[quien].email, password: pass });
  return ag;
};
const valida = (extra = {}) => ({
  tipo: 'reclamo', nombre: 'María Pérez', email: CORREO, telefono: '3001234567', empresa: 'Empresa X',
  asunto: 'Descuento repetido', mensaje: 'Me descontaron dos veces la cuota de este mes.',
  acepta_habeas_data: true, version_habeas_data: 'pqrs-hd-v1.0', ...extra,
});
const radicar = async (extra) => (await request(app).post('/api/pqrs/pub').send(valida(extra)));
const ids = [];

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  for (const u of Object.values(usuarios)) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
       VALUES ('PQRS Test', $1, $2, 'juridico', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true RETURNING id`, [u.email, hash]);
    u.id = r.id;
    if (u.permisos.length) {
      await pool.query(
        `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
         SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'pqrs' AND a.nombre = ANY($2) ON CONFLICT DO NOTHING`, [r.id, u.permisos]);
    }
  }
});

afterAll(async () => {
  const uids = Object.values(usuarios).map((u) => u.id);
  await pool.query(`DELETE FROM pqrs WHERE email = $1`, [CORREO]);                 // los eventos caen por cascada
  await pool.query(`DELETE FROM email_supresiones WHERE lower(email) = $1`, [CORREO]);
  await pool.query(`DELETE FROM email_logs WHERE destinatario = $1`, [CORREO]);
  await pool.query(`DELETE FROM notificaciones WHERE usuario_uuid = ANY($1)`, [uids]);
  await pool.query(`DELETE FROM permisos WHERE usuario_uuid = ANY($1)`, [uids]);
  await pool.query(`DELETE FROM global_usuarios WHERE id = ANY($1)`, [uids]);
  await pool.end();
});

describe('PQRS — radicación pública', () => {
  test('GET /pub/config devuelve los tipos, la versión del texto de datos y el plazo', async () => {
    const res = await request(app).get('/api/pqrs/pub/config');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.tipos).sort()).toEqual(['felicitacion', 'peticion', 'queja', 'reclamo', 'sugerencia']);
    expect(res.body.version_habeas_data).toBe('pqrs-hd-v1.0');
  });

  test('valida tipo, nombre, correo, mensaje y la autorización de datos; no acepta campos de más', async () => {
    const malos = [
      { tipo: 'insulto' }, { nombre: 'A' }, { email: 'no-es-correo' }, { telefono: 'abc' }, { asunto: '' },
      { mensaje: 'corto' }, { acepta_habeas_data: false }, { campo_extra: 1 },
    ];
    for (const m of malos) expect((await radicar(m)).status).toBe(400);
    expect((await request(app).post('/api/pqrs/pub').send({})).status).toBe(400);
  });

  test('un texto de autorización viejo se rechaza', async () => {
    const res = await radicar({ version_habeas_data: 'pqrs-hd-v0.1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('HABEAS_VERSION');
  });

  test('radica: devuelve radicado y código, guarda solo el hash, fija fecha límite y envía el correo de confirmación', async () => {
    const antes = emailsDePrueba.length;
    const res = await radicar();
    expect(res.status).toBe(201);
    expect(res.body.radicado).toMatch(/^PQRS-\d{4}-\d{6}$/);
    expect(res.body.codigo).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);   // sin 0, 1, I, O
    expect(res.body.correo_enviado).toBe(true);

    const { rows: [p] } = await pool.query('SELECT * FROM pqrs WHERE radicado = $1', [res.body.radicado]);
    ids.push(p.id);
    expect(p).toMatchObject({ tipo: 'reclamo', estado: 'recibida', email: CORREO, acepta_habeas_data: true, habeas_data_version: 'pqrs-hd-v1.0' });
    expect(p.codigo_hash).toHaveLength(64);
    expect(p.codigo_hash).not.toContain(res.body.codigo);
    expect(p.ip).toBeTruthy();
    const vence = new Date(p.vence_at); const dia = vence.getUTCDay();
    expect([0, 6]).not.toContain(dia);                           // el plazo vence en día hábil
    expect((vence - new Date()) / 86400000).toBeGreaterThan(14); // ~15 días hábiles = 21 corridos
    expect((await pool.query(`SELECT tipo FROM pqrs_eventos WHERE pqrs_id = $1`, [p.id])).rows.map((e) => e.tipo)).toEqual(['creada']);

    expect(emailsDePrueba.length).toBe(antes + 1);
    const correo = emailsDePrueba.at(-1);
    expect(correo.to).toBe(CORREO);
    expect(correo.text).toContain(res.body.radicado);
    expect(correo.text).toContain(res.body.codigo);
  });

  test('los radicados son consecutivos y únicos', async () => {
    const a = (await radicar({ asunto: 'Consecutivo A' })).body.radicado;
    const b = (await radicar({ asunto: 'Consecutivo B' })).body.radicado;
    expect(Number(b.slice(-6)) - Number(a.slice(-6))).toBe(1);
  });

  test('si el correo falla, la solicitud igual queda radicada y el código se entrega en la respuesta', async () => {
    simulacionDePrueba.fallar = true;
    let res;
    try { res = await radicar({ asunto: 'Sin correo' }); } finally { simulacionDePrueba.fallar = false; }
    expect(res.status).toBe(201);
    expect(res.body.correo_enviado).toBe(false);
    expect(res.body.codigo).toMatch(/^[A-Z2-9]{8}$/);
    expect((await pool.query('SELECT 1 FROM pqrs WHERE radicado = $1', [res.body.radicado])).rowCount).toBe(1);
  });

  test('un robot (campo trampa lleno) recibe respuesta normal pero no se guarda nada', async () => {
    const antes = (await pool.query('SELECT COUNT(*)::int AS n FROM pqrs WHERE email = $1', [CORREO])).rows[0].n;
    const res = await radicar({ sitio_web: 'http://spam.example', asunto: 'Soy un robot' });
    expect(res.status).toBe(201);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM pqrs WHERE email = $1', [CORREO])).rows[0].n).toBe(antes);
  });

  test('avisa a quienes tienen permiso sobre PQRS, sin datos personales en el mensaje', async () => {
    await pool.query('DELETE FROM notificaciones WHERE usuario_uuid = ANY($1)', [[usuarios.gestor.id, usuarios.nada.id]]);
    const { body } = await radicar({ tipo: 'queja', nombre: 'Persona Secreta Nombre', asunto: 'Aviso interno' });
    await new Promise((r) => setTimeout(r, 400));   // el aviso se envía sin bloquear la respuesta
    const { rows } = await pool.query(`SELECT usuario_uuid, mensaje, modulo FROM notificaciones WHERE usuario_uuid = ANY($1)`, [[usuarios.gestor.id, usuarios.nada.id]]);
    expect(rows.map((r) => r.usuario_uuid)).toEqual([usuarios.gestor.id]);   // quien no tiene permiso no recibe nada
    expect(rows[0].mensaje).toContain(body.radicado);
    expect(rows[0].mensaje).not.toContain('Secreta');
  });
});

describe('PQRS — consulta pública con radicado y código', () => {
  let radicado; let codigo;
  beforeAll(async () => { ({ body: { radicado, codigo } } = await radicar({ asunto: 'Para consultar' })); });
  const consultar = (b) => request(app).post('/api/pqrs/pub/consulta').send(b);

  test('con el código correcto muestra estado y fechas, y nada de datos personales', async () => {
    const res = await consultar({ radicado, codigo });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ radicado, tipo: 'reclamo', estado: 'recibida', asunto: 'Para consultar', respuesta: null });
    expect(JSON.stringify(res.body)).not.toMatch(/María|ejemplo\.test|3001234567/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    // No distingue mayúsculas ni espacios
    expect((await consultar({ radicado: ` ${radicado.toLowerCase()} `, codigo: codigo.toLowerCase() })).status).toBe(200);
  });

  test('código incorrecto o radicado inexistente dan la misma respuesta (404); el formato inválido, 400', async () => {
    const malo = await consultar({ radicado, codigo: codigo === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA' });
    const nada = await consultar({ radicado: 'PQRS-2026-999999', codigo });
    expect(malo.status).toBe(404);
    expect(nada.status).toBe(404);
    expect(malo.body).toEqual(nada.body);
    expect((await consultar({ radicado: 'xx', codigo })).status).toBe(400);
    expect((await consultar({ radicado })).status).toBe(400);
  });
});

describe('PQRS — gestión (Control Interno)', () => {
  let id; let radicado; let codigo;
  beforeAll(async () => {
    ({ body: { radicado, codigo } } = await radicar({ asunto: 'Gestión completa' }));
    id = (await pool.query('SELECT id FROM pqrs WHERE radicado = $1', [radicado])).rows[0].id;
  });

  test('permisos: sin sesión 401, sin permiso 403, el lector puede ver pero no gestionar', async () => {
    expect((await request(app).get('/api/pqrs')).status).toBe(401);
    expect((await (await login('nada')).get('/api/pqrs')).status).toBe(403);
    const lector = await login('lector');
    expect((await lector.get('/api/pqrs')).status).toBe(200);
    expect((await lector.get(`/api/pqrs/${id}`)).status).toBe(200);
    for (const [m, u, b] of [['put', 'estado', { estado: 'en_revision' }], ['put', 'asignar', { usuario_uuid: null }], ['post', 'notas', { nota: 'x' }], ['post', 'responder', { respuesta: 'Respuesta larga suficiente' }]]) {
      expect((await lector[m](`/api/pqrs/${id}/${u}`).send(b)).status).toBe(403);
    }
  });

  test('la lista trae contadores y filtros, sin el mensaje completo; el detalle sí lo trae con su historial', async () => {
    const ag = await login('gestor');
    const lista = await ag.get('/api/pqrs?q=Gesti%C3%B3n%20completa');
    expect(lista.status).toBe(200);
    expect(lista.body.items.map((x) => x.radicado)).toEqual([radicado]);
    expect(lista.body.items[0]).not.toHaveProperty('mensaje');
    expect(lista.body.resumen).toEqual(expect.objectContaining({ recibida: expect.any(Number), en_revision: expect.any(Number), vencidas: expect.any(Number) }));
    expect((await ag.get('/api/pqrs?tipo=felicitacion&q=Gesti%C3%B3n')).body.items).toHaveLength(0);
    expect((await ag.get('/api/pqrs?estado=cerrada&q=Gesti%C3%B3n')).body.items).toHaveLength(0);

    const det = await ag.get(`/api/pqrs/${id}`);
    expect(det.body).toMatchObject({ radicado, mensaje: 'Me descontaron dos veces la cuota de este mes.', email: CORREO, tipo_nombre: 'Reclamo' });
    expect(det.body).not.toHaveProperty('codigo_hash');
    expect(det.body.eventos.map((e) => e.tipo)).toEqual(['creada']);
    expect((await ag.get('/api/pqrs/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  test('asignar: solo a usuarios que gestionan PQRS; al asignar pasa a revisión y queda en el historial', async () => {
    const ag = await login('gestor');
    const cand = (await ag.get('/api/pqrs/asignables')).body.map((u) => u.id);
    expect(cand).toContain(usuarios.gestor.id);
    expect(cand).not.toContain(usuarios.lector.id);
    expect(cand).not.toContain(usuarios.nada.id);

    expect((await ag.put(`/api/pqrs/${id}/asignar`).send({ usuario_uuid: usuarios.lector.id })).status).toBe(400);
    expect((await ag.put(`/api/pqrs/${id}/asignar`).send({ usuario_uuid: 'no-uuid' })).status).toBe(400);
    expect((await ag.put(`/api/pqrs/${id}/asignar`).send({ usuario_uuid: usuarios.otro.id })).status).toBe(200);

    const det = (await ag.get(`/api/pqrs/${id}`)).body;
    expect(det).toMatchObject({ estado: 'en_revision', asignado_a: usuarios.otro.id });
    expect(det.eventos.map((e) => e.tipo)).toEqual(['creada', 'asignada']);
    expect((await ag.get('/api/pqrs?asignado=sin&q=Gesti%C3%B3n')).body.items).toHaveLength(0);
  });

  test('notas internas quedan en el historial y no se ven en la consulta pública', async () => {
    const ag = await login('gestor');
    expect((await ag.post(`/api/pqrs/${id}/notas`).send({ nota: '' })).status).toBe(400);
    expect((await ag.post(`/api/pqrs/${id}/notas`).send({ nota: 'Se verificó con tesorería: el descuento sí se duplicó.' })).status).toBe(201);
    const det = (await ag.get(`/api/pqrs/${id}`)).body;
    expect(det.eventos.at(-1)).toMatchObject({ tipo: 'nota', detalle: 'Se verificó con tesorería: el descuento sí se duplicó.' });
    const pub = await request(app).post('/api/pqrs/pub/consulta').send({ radicado, codigo });
    expect(JSON.stringify(pub.body)).not.toContain('tesorería');
  });

  test('no se puede cerrar una queja o reclamo sin responderla', async () => {
    const ag = await login('gestor');
    const res = await ag.put(`/api/pqrs/${id}/estado`).send({ estado: 'cerrada' });
    expect(res.status).toBe(400);
    expect((await ag.put(`/api/pqrs/${id}/estado`).send({ estado: 'respondida' })).status).toBe(400);   // solo se llega respondiendo
  });

  test('responder: guarda la respuesta, envía el correo y la consulta pública ya la muestra', async () => {
    const ag = await login('gestor');
    expect((await ag.post(`/api/pqrs/${id}/responder`).send({ respuesta: 'corta' })).status).toBe(400);
    const antes = emailsDePrueba.length;
    const res = await ag.post(`/api/pqrs/${id}/responder`).send({ respuesta: 'Ya reversamos el descuento duplicado; lo verás en tu próxima nómina.' });
    expect(res.status).toBe(200);
    expect(res.body.correo_enviado).toBe(true);
    expect(emailsDePrueba.length).toBe(antes + 1);
    expect(emailsDePrueba.at(-1)).toMatchObject({ to: CORREO });
    expect(emailsDePrueba.at(-1).text).toContain('reversamos el descuento');

    const det = (await ag.get(`/api/pqrs/${id}`)).body;
    expect(det).toMatchObject({ estado: 'respondida', respondida_por_nombre: 'PQRS Test' });
    expect(det.respondida_at).toBeTruthy();

    const pub = await request(app).post('/api/pqrs/pub/consulta').send({ radicado, codigo });
    expect(pub.body).toMatchObject({ estado: 'respondida', respuesta: 'Ya reversamos el descuento duplicado; lo verás en tu próxima nómina.' });
  });

  test('cerrar tras responder; una vez cerrada no se responde ni se cierra de nuevo, pero se puede reabrir', async () => {
    const ag = await login('gestor');
    expect((await ag.put(`/api/pqrs/${id}/estado`).send({ estado: 'cerrada' })).status).toBe(200);
    expect((await ag.get(`/api/pqrs/${id}`)).body.estado).toBe('cerrada');
    expect((await ag.post(`/api/pqrs/${id}/responder`).send({ respuesta: 'Otra respuesta cualquiera' })).status).toBe(400);
    expect((await ag.put(`/api/pqrs/${id}/estado`).send({ estado: 'cerrada' })).status).toBe(400);
    expect((await ag.put(`/api/pqrs/${id}/estado`).send({ estado: 'en_revision' })).status).toBe(200);
    expect((await ag.post(`/api/pqrs/${id}/responder`).send({ respuesta: 'Respuesta corregida tras reabrir.' })).status).toBe(200);
  });

  test('una sugerencia o felicitación se puede cerrar sin respuesta', async () => {
    const ag = await login('gestor');
    const { body } = await radicar({ tipo: 'felicitacion', asunto: 'Buen servicio', mensaje: 'Gracias por la atención del equipo.' });
    const fid = (await pool.query('SELECT id FROM pqrs WHERE radicado = $1', [body.radicado])).rows[0].id;
    expect((await ag.put(`/api/pqrs/${fid}/estado`).send({ estado: 'cerrada' })).status).toBe(200);
  });

  test('si el correo de quien radicó rebotó antes, la respuesta se guarda y se avisa que no salió el correo', async () => {
    const ag = await login('gestor');
    const { body } = await radicar({ asunto: 'Correo suprimido' });
    const sid = (await pool.query('SELECT id FROM pqrs WHERE radicado = $1', [body.radicado])).rows[0].id;
    await pool.query(`INSERT INTO email_supresiones (email, motivo) VALUES ($1, 'rebote') ON CONFLICT (lower(email)) DO UPDATE SET is_active = true`, [CORREO]);
    const res = await ag.post(`/api/pqrs/${sid}/responder`).send({ respuesta: 'Respuesta que no podrá llegar por correo.' });
    expect(res.status).toBe(200);
    expect(res.body.correo_enviado).toBe(false);
    const det = (await ag.get(`/api/pqrs/${sid}`)).body;
    expect(det.estado).toBe('respondida');
    expect(det.eventos.map((e) => e.tipo)).toContain('respuesta_sin_correo');
    await pool.query(`DELETE FROM email_supresiones WHERE lower(email) = $1`, [CORREO]);
  });
});
