import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';

let app;
const pass = 'testpass123';
const usuarios = {
  lector:     { email: 'analitica-lector@kernel.test', permisos: ['READ'], id: null },
  sinPermiso: { email: 'analitica-nada@kernel.test',   permisos: [], id: null },
};
const login = async (quien) => {
  const ag = request.agent(app);
  await ag.post('/api/auth/login').send({ email: usuarios[quien].email, password: pass });
  return ag;
};

const UA_ESCRITORIO = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const UA_MOVIL      = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const UA_BOT        = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// Cada prueba usa una ruta única: así no depende de lo que haya en la tabla
const RUTA = `/prueba-analitica-${Date.now()}`;
const enviar = (cuerpo, ua = UA_ESCRITORIO, cabeceras = {}) =>
  request(app).post('/api/analitica/pub/evento').set('X-Requested-With', 'XMLHttpRequest').set('User-Agent', ua).set(cabeceras).send(cuerpo);
const cuenta = async (where = 'true', params = []) =>
  (await pool.query(`SELECT COUNT(*)::int AS n FROM analitica_eventos WHERE ruta LIKE '/prueba-analitica-%' AND ${where}`, params)).rows[0].n;

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  for (const u of Object.values(usuarios)) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
       VALUES ('Analitica Test', $1, $2, 'juridico', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true RETURNING id`, [u.email, hash]);
    u.id = r.id;
    if (u.permisos.length) {
      await pool.query(
        `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
         SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'analitica' AND a.nombre = ANY($2) ON CONFLICT DO NOTHING`,
        [r.id, u.permisos]);
    }
  }
});

afterAll(async () => {
  const ids = Object.values(usuarios).map((u) => u.id);
  await pool.query(`DELETE FROM analitica_eventos WHERE ruta LIKE '/prueba-analitica-%'`);
  await pool.query(`DELETE FROM permisos WHERE usuario_uuid = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM global_usuarios WHERE id = ANY($1)`, [ids]);
  await pool.end();
});

describe('Analítica — registro de eventos (público)', () => {
  test('una vista se guarda sin datos personales (ni IP ni agente de usuario)', async () => {
    const res = await enviar({ tipo: 'vista', ruta: `${RUTA}/uno`, ref: 'https://www.google.com/search?q=progresemos' });
    expect(res.status).toBe(204);
    const { rows: [f] } = await pool.query(`SELECT * FROM analitica_eventos WHERE ruta = $1`, [`${RUTA}/uno`]);
    expect(f).toMatchObject({ tipo: 'vista', origen: 'google.com', dispositivo: 'escritorio', evento: null });
    expect(f.visitante).toMatch(/^[0-9a-f]{16}$/);
    // La fila no contiene la IP ni el agente de usuario en ningún campo
    expect(JSON.stringify(f)).not.toMatch(/Mozilla|Chrome|127\.0\.0\.1|::1/);
  });

  test('el mismo visitante el mismo día tiene el mismo hash; otro dispositivo, otro hash', async () => {
    await enviar({ tipo: 'vista', ruta: `${RUTA}/hash` });
    await enviar({ tipo: 'vista', ruta: `${RUTA}/hash` });
    await enviar({ tipo: 'vista', ruta: `${RUTA}/hash` }, UA_MOVIL);
    const { rows } = await pool.query(`SELECT visitante, dispositivo FROM analitica_eventos WHERE ruta = $1 ORDER BY created_at`, [`${RUTA}/hash`]);
    expect(rows).toHaveLength(3);
    expect(rows[0].visitante).toBe(rows[1].visitante);
    expect(rows[2].visitante).not.toBe(rows[0].visitante);
    expect(rows[2].dispositivo).toBe('movil');
  });

  test('la navegación interna no cuenta como origen; la ruta se normaliza (sin barra final)', async () => {
    await enviar({ tipo: 'vista', ruta: `${RUTA}/interna/`, ref: 'https://www.cooperativaprogresemos.coop/servicios' });
    const { rows: [f] } = await pool.query(`SELECT ruta, origen FROM analitica_eventos WHERE ruta LIKE $1`, [`${RUTA}/interna%`]);
    expect(f).toEqual({ ruta: `${RUTA}/interna`, origen: null });
  });

  test('un clic necesita el nombre del evento y solo acepta los conocidos', async () => {
    expect((await enviar({ tipo: 'clic', ruta: `${RUTA}/clic` })).status).toBe(400);
    expect((await enviar({ tipo: 'clic', ruta: `${RUTA}/clic`, evento: 'inventado' })).status).toBe(400);
    expect((await enviar({ tipo: 'clic', ruta: `${RUTA}/clic`, evento: 'asociarme' })).status).toBe(204);
    expect(await cuenta(`tipo = 'clic' AND evento = 'asociarme' AND ruta = $1`, [`${RUTA}/clic`])).toBe(1);
  });

  test('valida la entrada: tipo, ruta sin consulta ni caracteres raros y sin campos de más', async () => {
    expect((await enviar({})).status).toBe(400);
    expect((await enviar({ tipo: 'otro', ruta: '/x' })).status).toBe(400);
    expect((await enviar({ tipo: 'vista', ruta: 'sin-barra' })).status).toBe(400);
    expect((await enviar({ tipo: 'vista', ruta: '/x?token=abc' })).status).toBe(400);
    expect((await enviar({ tipo: 'vista', ruta: '/x y' })).status).toBe(400);
    expect((await enviar({ tipo: 'vista', ruta: '/x', ip: '1.2.3.4' })).status).toBe(400);
    expect((await enviar({ tipo: 'vista', ruta: '/x'.padEnd(250, 'a') })).status).toBe(400);
  });

  test('los bots y las peticiones sin agente de usuario se descartan en silencio', async () => {
    const antes = await cuenta();
    expect((await enviar({ tipo: 'vista', ruta: `${RUTA}/bot` }, UA_BOT)).status).toBe(204);
    expect((await enviar({ tipo: 'vista', ruta: `${RUTA}/bot` }, 'curl/8.4.0')).status).toBe(204);
    expect((await enviar({ tipo: 'vista', ruta: `${RUTA}/bot` }, '')).status).toBe(204);
    expect(await cuenta()).toBe(antes);
  });
});

describe('Analítica — panel', () => {
  test('sin sesión → 401; sin permiso → 403; con permiso de lectura → 200', async () => {
    expect((await request(app).get('/api/analitica/resumen')).status).toBe(401);
    expect((await (await login('sinPermiso')).get('/api/analitica/resumen')).status).toBe(403);
    expect((await (await login('lector')).get('/api/analitica/resumen')).status).toBe(200);
  });

  test('el resumen cuenta vistas, visitantes distintos por día, páginas, orígenes, dispositivos y clics', async () => {
    const R = `${RUTA}/panel`;
    await pool.query(`DELETE FROM analitica_eventos WHERE ruta LIKE $1`, [`${R}%`]);
    // 2 visitantes de escritorio y 1 móvil; el primero abre 2 páginas
    await enviar({ tipo: 'vista', ruta: `${R}/a`, ref: 'https://www.facebook.com/' });
    await enviar({ tipo: 'vista', ruta: `${R}/b` });
    await enviar({ tipo: 'vista', ruta: `${R}/a` }, UA_MOVIL);
    await enviar({ tipo: 'clic', ruta: `${R}/a`, evento: 'whatsapp' });
    await enviar({ tipo: 'clic', ruta: `${R}/a`, evento: 'whatsapp' }, UA_MOVIL);

    const ag = await login('lector');
    const { status, body } = await ag.get('/api/analitica/resumen?dias=7');
    expect(status).toBe(200);
    expect(body.rango.dias).toBe(7);
    expect(body.serie).toHaveLength(7);
    const hoy = body.serie[6];
    expect(hoy.vistas).toBeGreaterThanOrEqual(3);
    expect(hoy.visitantes).toBeGreaterThanOrEqual(2);
    expect(body.totales.vistas).toBeGreaterThanOrEqual(3);
    expect(body.totales.clics).toBeGreaterThanOrEqual(2);
    expect(body.totales).toHaveProperty('anterior.vistas');
    expect(body.paginas.find((p) => p.ruta === `${R}/a`)).toMatchObject({ vistas: 2, visitantes: 2 });
    expect(body.origenes.some((o) => o.origen === 'facebook.com')).toBe(true);
    expect(body.dispositivos.map((d) => d.dispositivo)).toEqual(expect.arrayContaining(['escritorio', 'movil']));
    expect(body.clics.find((c) => c.evento === 'whatsapp')).toMatchObject({ nombre: 'WhatsApp' });
    expect(body.clics.find((c) => c.evento === 'whatsapp').total).toBeGreaterThanOrEqual(2);
    // Sin cabecera de caché pública: son datos internos
    expect((await ag.get('/api/analitica/resumen')).headers['cache-control']).toMatch(/no-store/);
  });

  test('acepta un rango de fechas y rechaza uno inválido', async () => {
    const ag = await login('lector');
    const hoy = new Date().toISOString().slice(0, 10);
    const ok = await ag.get(`/api/analitica/resumen?desde=${hoy}&hasta=${hoy}`);
    expect(ok.status).toBe(200);
    expect(ok.body.serie).toHaveLength(1);
    expect((await ag.get('/api/analitica/resumen?desde=2020-01-01&hasta=2026-01-01')).status).toBe(400);   // más de 2 años
    expect((await ag.get(`/api/analitica/resumen?desde=${hoy}&hasta=2000-01-01`)).status).toBe(400);      // al revés
    expect((await ag.get('/api/analitica/resumen?dias=abc')).status).toBe(400);
    expect((await ag.get('/api/analitica/resumen?desde=hoy')).status).toBe(400);
  });
});
