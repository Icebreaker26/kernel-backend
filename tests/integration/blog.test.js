import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';

let app;
const pass = 'testpass123';
const usuarios = {
  editor:     { email: 'blog-editor@kernel.test', permisos: ['READ', 'WRITE', 'DELETE'], id: null },
  lector:     { email: 'blog-lector@kernel.test', permisos: ['READ'], id: null },
  sinPermiso: { email: 'blog-nada@kernel.test',   permisos: [], id: null },
};
const login = async (quien) => {
  const ag = request.agent(app);
  await ag.post('/api/auth/login').send({ email: usuarios[quien].email, password: pass });
  return ag;
};
const imagen = (extra = {}) => ({ nombre: 'portada.jpg', mime: 'image/jpeg', size: 300000, ...extra });
const NIL = '00000000-0000-4000-8000-000000000000';
const creadas = [];

const nueva = async (ag, datos = {}) => {
  const res = await ag.post('/api/blog').send({ titulo: 'Entrada de prueba', ...datos });
  if (res.body.id) creadas.push(res.body.id);
  return res;
};

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  for (const u of Object.values(usuarios)) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
       VALUES ('Blog Test', $1, $2, 'juridico', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true RETURNING id`, [u.email, hash]);
    u.id = r.id;
    if (u.permisos.length) {
      await pool.query(
        `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
         SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'blog' AND a.nombre = ANY($2) ON CONFLICT DO NOTHING`,
        [r.id, u.permisos]);
    }
  }
});

afterAll(async () => {
  const ids = Object.values(usuarios).map((u) => u.id);
  await pool.query(`DELETE FROM archivos WHERE entidad_tipo = 'blog_entrada' AND entidad_id = ANY($1)`, [creadas]);
  await pool.query(`DELETE FROM blog_entradas WHERE autor_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM blog_categorias WHERE slug LIKE 'cat-prueba-%'`);
  await pool.query(`DELETE FROM permisos WHERE usuario_uuid = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM global_usuarios WHERE id = ANY($1)`, [ids]);
  await pool.end();
});

describe('Blog — permisos y validación', () => {
  test('sin sesión → 401; sin permiso → 403; el lector ve pero no escribe ni borra', async () => {
    expect((await request(app).get('/api/blog')).status).toBe(401);
    expect((await (await login('sinPermiso')).get('/api/blog')).status).toBe(403);
    const lector = await login('lector');
    expect((await lector.get('/api/blog')).status).toBe(200);
    expect((await lector.post('/api/blog').send({ titulo: 'X' })).status).toBe(403);
    expect((await lector.put(`/api/blog/${NIL}`).send({ titulo: 'X' })).status).toBe(403);
    expect((await lector.delete(`/api/blog/${NIL}`)).status).toBe(403);
  });

  test('POST valida el título y no acepta campos de más (no se publica al crear)', async () => {
    const ag = await login('editor');
    const post = (b) => ag.post('/api/blog').send(b);
    expect((await post({})).status).toBe(400);
    expect((await post({ titulo: '' })).status).toBe(400);
    expect((await post({ titulo: 'X'.repeat(201) })).status).toBe(400);
    expect((await post({ titulo: 'X', estado: 'publicado' })).status).toBe(400);
    expect((await post({ titulo: 'X', categoria_id: '00000000-0000-4000-8000-0000000000aa' })).status).toBe(400);   // categoría inexistente
  });

  test('un id que no es UUID o que no existe → 404 (no 500)', async () => {
    const ag = await login('editor');
    expect((await ag.get('/api/blog/no-es-uuid')).status).toBe(404);
    expect((await ag.get(`/api/blog/${NIL}`)).status).toBe(404);
    expect((await ag.put(`/api/blog/${NIL}`).send({ titulo: 'X' })).status).toBe(404);
    expect((await ag.delete(`/api/blog/${NIL}`)).status).toBe(404);
  });
});

describe('Blog — borrador, publicación y sitio público', () => {
  test('nace en borrador y no aparece en el sitio; al publicar sí, con su resumen automático', async () => {
    const ag = await login('editor');
    const res = await nueva(ag, { titulo: 'Sorteo de una moto: ¡participa!', contenido: '<p>Este mes sorteamos una moto entre los asociados ahorradores.</p>' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ estado: 'borrador', slug: 'sorteo-de-una-moto-participa', publicado_at: null });

    expect((await request(app).get(`/api/blog/pub/${res.body.slug}`)).status).toBe(404);
    expect((await request(app).get('/api/blog/pub')).body.entradas.some((e) => e.slug === res.body.slug)).toBe(false);

    const pub = await ag.put(`/api/blog/${res.body.id}`).send({ estado: 'publicado' });
    expect(pub.status).toBe(200);
    expect(pub.body.estado).toBe('publicado');
    expect(pub.body.publicado_at).toBeTruthy();
    expect(pub.body.resumen).toContain('sorteamos una moto');

    const lista = await request(app).get('/api/blog/pub');
    expect(lista.status).toBe(200);
    expect(lista.body.entradas.some((e) => e.slug === res.body.slug)).toBe(true);
    const detalle = await request(app).get(`/api/blog/pub/${res.body.slug}`);
    expect(detalle.status).toBe(200);
    expect(detalle.body.contenido).toContain('sorteamos una moto');
    expect(detalle.body).not.toHaveProperty('autor_id');
  });

  test('no se puede publicar una entrada vacía', async () => {
    const ag = await login('editor');
    const { body } = await nueva(ag, { titulo: 'Sin contenido' });
    const res = await ag.put(`/api/blog/${body.id}`).send({ estado: 'publicado' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/contenido/i);
  });

  test('despublicar la oculta pero conserva la fecha original al volver a publicar', async () => {
    const ag = await login('editor');
    const { body } = await nueva(ag, { titulo: 'Fecha estable', contenido: '<p>Texto</p>' });
    const primera = (await ag.put(`/api/blog/${body.id}`).send({ estado: 'publicado' })).body.publicado_at;
    expect((await ag.put(`/api/blog/${body.id}`).send({ estado: 'borrador' })).body.estado).toBe('borrador');
    expect((await request(app).get(`/api/blog/pub/${body.slug}`)).status).toBe(404);
    const segunda = (await ag.put(`/api/blog/${body.id}`).send({ estado: 'publicado' })).body.publicado_at;
    expect(new Date(segunda).getTime()).toBe(new Date(primera).getTime());
  });

  test('el slug cambia con el título mientras es borrador, pero una entrada publicada no rompe su URL', async () => {
    const ag = await login('editor');
    const { body } = await nueva(ag, { titulo: 'Titulo provisional', contenido: '<p>Texto</p>' });
    const renombrada = await ag.put(`/api/blog/${body.id}`).send({ titulo: 'Titulo definitivo' });
    expect(renombrada.body.slug).toBe('titulo-definitivo');
    await ag.put(`/api/blog/${body.id}`).send({ estado: 'publicado' });
    const despues = await ag.put(`/api/blog/${body.id}`).send({ titulo: 'Otro titulo distinto' });
    expect(despues.body.slug).toBe('titulo-definitivo');   // no cambia
    expect(despues.body.titulo).toBe('Otro titulo distinto');
  });

  test('dos entradas con el mismo título obtienen slugs distintos', async () => {
    const ag = await login('editor');
    const a = await nueva(ag, { titulo: 'Titulo repetido' });
    const b = await nueva(ag, { titulo: 'Titulo repetido' });
    expect(a.body.slug).toBe('titulo-repetido');
    expect(b.body.slug).toBe('titulo-repetido-2');
  });

  test('el contenido se sanitiza en el servidor: sin scripts, eventos, estilos ni javascript:', async () => {
    const ag = await login('editor');
    const sucio = '<p onclick="robar()">Hola <script>alert(1)</script><strong>mundo</strong></p>'
      + '<img src=x onerror=alert(2)><iframe src="https://malo.example"></iframe><style>p{}</style>'
      + '<a href="javascript:alert(3)">malo</a><a href="https://ok.example/pagina">bueno</a><h1>Titulo</h1>';
    const { body } = await nueva(ag, { titulo: 'Sanitizar', contenido: sucio });
    const html = (await ag.get(`/api/blog/${body.id}`)).body.contenido;
    expect(html).not.toMatch(/script|onclick|onerror|iframe|<style|javascript:|<img/i);
    expect(html).toContain('<strong>mundo</strong>');
    expect(html).toContain('href="https://ok.example/pagina"');
    expect(html).toMatch(/rel="noopener noreferrer nofollow"/);
    expect(html).toContain('<h2>Titulo</h2>');   // el h1 baja a h2: el título de la página es el h1
  });

  test('los párrafos vacíos que deja el editor no se guardan', async () => {
    const ag = await login('editor');
    const { body } = await nueva(ag, { titulo: 'Sin huecos', contenido: '<p>Uno</p><p></p><p><br></p><p>&nbsp;</p><p>Dos</p><p></p>' });
    expect((await ag.get(`/api/blog/${body.id}`)).body.contenido).toBe('<p>Uno</p><p>Dos</p>');
  });

  test('categorías: se listan, se pueden crear (sin duplicar) y filtran el sitio público', async () => {
    const ag = await login('editor');
    const cats = (await ag.get('/api/blog/categorias')).body;
    expect(cats.map((c) => c.slug)).toEqual(expect.arrayContaining(['noticias', 'sorteos']));

    const nombre = `Cat Prueba ${Date.now()}`;
    const crear = await ag.post('/api/blog/categorias').send({ nombre });
    expect(crear.status).toBe(201);
    await pool.query(`UPDATE blog_categorias SET slug = 'cat-prueba-x' || floor(random()*100000)::text WHERE id = $1`, [crear.body.id]);   // para la limpieza
    expect((await ag.post('/api/blog/categorias').send({ nombre: 'Noticias' })).status).toBe(409);

    const { body } = await nueva(ag, { titulo: 'Con categoria', contenido: '<p>Texto</p>', categoria_id: crear.body.id });
    expect(body.categoria_id).toBe(crear.body.id);
    await ag.put(`/api/blog/${body.id}`).send({ estado: 'publicado' });
    const { rows: [c] } = await pool.query('SELECT slug FROM blog_categorias WHERE id = $1', [crear.body.id]);
    const filtrada = await request(app).get(`/api/blog/pub?categoria=${c.slug}`);
    expect(filtrada.body.entradas.map((e) => e.slug)).toEqual([body.slug]);
    expect(filtrada.body.categorias.some((x) => x.slug === c.slug && x.total === 1)).toBe(true);
    expect((await request(app).get('/api/blog/pub?categoria=no-existe')).body.entradas).toHaveLength(0);
  });

  test('eliminar es lógico: deja de verse y de listarse pero sigue en la base', async () => {
    const ag = await login('editor');
    const { body } = await nueva(ag, { titulo: 'Para borrar', contenido: '<p>Texto</p>' });
    await ag.put(`/api/blog/${body.id}`).send({ estado: 'publicado' });
    expect((await ag.delete(`/api/blog/${body.id}`)).status).toBe(200);
    expect((await ag.delete(`/api/blog/${body.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/blog/pub/${body.slug}`)).status).toBe(404);
    expect((await ag.get('/api/blog')).body.some((e) => e.id === body.id)).toBe(false);
    expect((await pool.query('SELECT is_active, estado FROM blog_entradas WHERE id = $1', [body.id])).rows[0]).toEqual({ is_active: false, estado: 'borrador' });
    // El slug queda libre para otra entrada
    expect((await nueva(ag, { titulo: 'Para borrar' })).body.slug).toBe('para-borrar');
  });

  test('la lista pública pagina (9 por página)', async () => {
    const ag = await login('editor');
    for (let i = 0; i < 10; i += 1) {
      const { body } = await nueva(ag, { titulo: `Paginacion ${i}`, contenido: '<p>Texto</p>' });
      await ag.put(`/api/blog/${body.id}`).send({ estado: 'publicado' });
    }
    const p1 = (await request(app).get('/api/blog/pub')).body;
    expect(p1.entradas).toHaveLength(9);
    expect(p1.paginas).toBeGreaterThanOrEqual(2);
    expect((await request(app).get('/api/blog/pub?pagina=2')).body.entradas.length).toBeGreaterThanOrEqual(1);
    expect((await request(app).get('/api/blog/pub?pagina=abc')).status).toBe(200);
  });
});

describe('Blog — portada', () => {
  test('valida tipo y tamaño; registra la portada, se reemplaza sin acumular archivos y se puede quitar', async () => {
    const ag = await login('editor');
    const { body } = await nueva(ag, { titulo: 'Con portada', contenido: '<p>Texto</p>' });
    const url = (s) => `/api/blog/${body.id}/portada/${s}`;

    expect((await ag.post(url('solicitar')).send(imagen({ mime: 'application/pdf', nombre: 'a.pdf' }))).status).toBe(400);
    expect((await ag.post(url('solicitar')).send(imagen({ size: 6 * 1024 * 1024 }))).status).toBe(400);
    expect((await ag.post(url('solicitar')).send(imagen({ nombre: 'portada.png' }))).status).toBe(400);   // extensión ≠ tipo
    expect((await ag.post(url('solicitar')).send({})).status).toBe(400);

    const sol = await ag.post(url('solicitar')).send(imagen());
    expect(sol.status).toBe(200);
    expect(sol.body.key).toMatch(new RegExp(`^kernel/blog_entradas/${body.id}/`));
    // La clave debe ser de esta entrada
    expect((await ag.patch(url('confirmar')).send({ key: `kernel/blog_entradas/${NIL}/x.jpg`, ...imagen() })).status).toBe(400);

    const conf = await ag.patch(url('confirmar')).send({ key: sol.body.key, ...imagen() });
    expect(conf.status).toBe(200);
    expect(conf.body.tiene_portada).toBe(true);

    const sol2 = await ag.post(url('solicitar')).send(imagen({ nombre: 'nueva.webp', mime: 'image/webp' }));
    await ag.patch(url('confirmar')).send({ key: sol2.body.key, ...imagen({ nombre: 'nueva.webp', mime: 'image/webp' }) });
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM archivos WHERE entidad_tipo = 'blog_entrada' AND entidad_id = $1`, [body.id])).rows[0].n).toBe(1);

    const quitada = await ag.delete(`/api/blog/${body.id}/portada`);
    expect(quitada.status).toBe(200);
    expect(quitada.body.tiene_portada).toBe(false);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM archivos WHERE entidad_tipo = 'blog_entrada' AND entidad_id = $1`, [body.id])).rows[0].n).toBe(0);
  });

  test('la portada pública solo se sirve si la entrada está publicada', async () => {
    const ag = await login('editor');
    const { body } = await nueva(ag, { titulo: 'Portada publica', contenido: '<p>Texto</p>' });
    const sol = await ag.post(`/api/blog/${body.id}/portada/solicitar`).send(imagen());
    await ag.patch(`/api/blog/${body.id}/portada/confirmar`).send({ key: sol.body.key, ...imagen() });
    expect((await request(app).get(`/api/blog/pub/${body.slug}/portada`)).status).toBe(404);   // borrador
    await ag.put(`/api/blog/${body.id}`).send({ estado: 'publicado' });
    const res = await request(app).get(`/api/blog/pub/${body.slug}/portada`).redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https?:\/\//);
    // El sitio (otro dominio) la carga con <img>: sin esto el navegador la bloquea (helmet pone same-origin por defecto)
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
    // El resto de la API sigue con la política restrictiva
    expect((await request(app).get('/api/blog/pub')).headers['cross-origin-resource-policy']).toBe('same-origin');
    // El editor la ve aunque sea borrador
    expect((await ag.get(`/api/blog/${body.id}/portada`)).body.url).toMatch(/^https?:\/\//);
  });
});
