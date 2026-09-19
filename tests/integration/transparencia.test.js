import request from 'supertest';
import bcrypt from 'bcrypt';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';

let app;
const pass = 'testpass123';
const usuarios = {
  editor: { email: 'transparencia-editor@kernel.test', permisos: ['READ', 'WRITE', 'DELETE'], id: null },
  lector: { email: 'transparencia-lector@kernel.test', permisos: ['READ'], id: null },
  sinPermiso: { email: 'transparencia-nada@kernel.test', permisos: [], id: null },
};
const login = async (quien) => {
  const ag = request.agent(app);
  await ag.post('/api/auth/login').send({ email: usuarios[quien].email, password: pass });
  return ag;
};
const meta = (extra = {}) => ({ nombre: 'informe.pdf', mime: 'application/pdf', size: 250000, ...extra });
const creados = [];

// Crea un documento y le "sube" un PDF (el navegador sube a S3 con la URL firmada; aquí solo se registra)
const conArchivo = async (ag, datos = {}, opciones = {}) => {
  const doc = await ag.post('/api/transparencia').send({ titulo: 'Informe de prueba', categoria: 'informe_gestion', anio: 2025, ...datos });
  creados.push(doc.body.id);
  const sol = await ag.post(`/api/transparencia/${doc.body.id}/archivo/solicitar`).send(meta());
  const conf = await ag.patch(`/api/transparencia/${doc.body.id}/archivo/confirmar`).send({ key: sol.body.key, ...meta(), ...opciones });
  return { id: doc.body.id, sol, conf };
};

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  for (const u of Object.values(usuarios)) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
       VALUES ('Transparencia Test', $1, $2, 'juridico', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true RETURNING id`, [u.email, hash]);
    u.id = r.id;
    if (u.permisos.length) {
      await pool.query(
        `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
         SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'transparencia' AND a.nombre = ANY($2) ON CONFLICT DO NOTHING`,
        [r.id, u.permisos]);
    }
  }
});

afterAll(async () => {
  const ids = Object.values(usuarios).map((u) => u.id);
  await pool.query(`DELETE FROM archivos WHERE entidad_tipo = 'transparencia_documento' AND entidad_id = ANY($1)`, [creados]);
  await pool.query(`DELETE FROM transparencia_documentos WHERE creado_por = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM permisos WHERE usuario_uuid = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM global_usuarios WHERE id = ANY($1)`, [ids]);
  await pool.end();
});

describe('Transparencia — permisos y validación', () => {
  test('sin sesión → 401; sin permiso → 403; el lector puede ver pero no escribir ni borrar', async () => {
    expect((await request(app).get('/api/transparencia')).status).toBe(401);
    expect((await (await login('sinPermiso')).get('/api/transparencia')).status).toBe(403);
    const lector = await login('lector');
    expect((await lector.get('/api/transparencia')).status).toBe(200);
    expect((await lector.post('/api/transparencia').send({ titulo: 'X', categoria: 'rut' })).status).toBe(403);
    expect((await lector.delete('/api/transparencia/00000000-0000-4000-8000-000000000000')).status).toBe(403);
  });

  test('POST — valida título, categoría, año y no acepta campos de más', async () => {
    const ag = await login('editor');
    const post = (b) => ag.post('/api/transparencia').send(b);
    expect((await post({})).status).toBe(400);
    expect((await post({ titulo: '', categoria: 'rut' })).status).toBe(400);
    expect((await post({ titulo: 'X', categoria: 'inventada' })).status).toBe(400);
    expect((await post({ titulo: 'X', categoria: 'rut', anio: 1800 })).status).toBe(400);
    expect((await post({ titulo: 'X', categoria: 'rut', publicado: true })).status).toBe(400); // no se publica al crear
  });
});

describe('Transparencia — ciclo del documento', () => {
  test('se crea en borrador, sin archivo, y no se puede publicar hasta subir el PDF', async () => {
    const ag = await login('editor');
    const res = await ag.post('/api/transparencia').send({ titulo: 'Acta de asamblea 2026', categoria: 'acta_asamblea', anio: '2026' });
    expect(res.status).toBe(201);
    creados.push(res.body.id);
    expect(res.body).toMatchObject({ titulo: 'Acta de asamblea 2026', categoria: 'acta_asamblea', anio: 2026, publicado: false, archivo_nombre: null });

    const pub = await ag.put(`/api/transparencia/${res.body.id}`).send({ publicado: true });
    expect(pub.status).toBe(400);
    expect(pub.body.error).toMatch(/PDF/);
  });

  test('solicitar archivo: solo PDF y de tamaño razonable', async () => {
    const ag = await login('editor');
    const { body: doc } = await ag.post('/api/transparencia').send({ titulo: 'Doc', categoria: 'otro' });
    creados.push(doc.id);
    const url = `/api/transparencia/${doc.id}/archivo/solicitar`;
    expect((await ag.post(url).send(meta({ mime: 'image/png', nombre: 'a.png' }))).status).toBe(400);
    expect((await ag.post(url).send(meta({ nombre: 'informe.jpg' }))).status).toBe(400);   // mime PDF pero extensión que no
    expect((await ag.post(url).send(meta({ size: 26 * 1024 * 1024 }))).status).toBe(400);
    expect((await ag.post(url).send({})).status).toBe(400);
    const ok = await ag.post(url).send(meta());
    expect(ok.status).toBe(200);
    expect(ok.body.uploadUrl).toContain('X-Amz-Signature');
    expect(ok.body.key).toMatch(new RegExp(`^kernel/transparencia_documentos/${doc.id}/.+\\.pdf$`));
  });

  test('confirmar: solo acepta una clave generada para ese documento', async () => {
    const ag = await login('editor');
    const { body: a } = await ag.post('/api/transparencia').send({ titulo: 'A', categoria: 'otro' });
    const { body: b } = await ag.post('/api/transparencia').send({ titulo: 'B', categoria: 'otro' });
    creados.push(a.id, b.id);
    const solA = await ag.post(`/api/transparencia/${a.id}/archivo/solicitar`).send(meta());
    // La clave de A no sirve para B, ni una inventada
    expect((await ag.patch(`/api/transparencia/${b.id}/archivo/confirmar`).send({ key: solA.body.key, ...meta() })).status).toBe(400);
    expect((await ag.patch(`/api/transparencia/${a.id}/archivo/confirmar`).send({ key: 'kernel/otra/cosa.pdf', ...meta() })).status).toBe(400);
    expect((await ag.patch(`/api/transparencia/${a.id}/archivo/confirmar`).send({ key: solA.body.key, ...meta({ mime: 'image/png' }) })).status).toBe(400);
  });

  test('con el PDF subido se puede publicar, aparece en la lista pública y se descarga con URL firmada', async () => {
    const ag = await login('editor');
    const { id, conf } = await conArchivo(ag, { titulo: 'Estados financieros 2025 (prueba)', categoria: 'estados_financieros', anio: 2025 });
    expect(conf.status).toBe(200);
    expect(conf.body.archivo_nombre).toBe('informe.pdf');

    // Sin publicar: no se ve en el sitio
    let lista = await request(app).get('/api/transparencia/pub');
    expect(lista.body.documentos.some((d) => d.id === id)).toBe(false);
    expect((await request(app).get(`/api/transparencia/pub/${id}/descargar`).redirects(0)).status).toBe(404);

    expect((await ag.put(`/api/transparencia/${id}`).send({ publicado: true })).status).toBe(200);
    lista = await request(app).get('/api/transparencia/pub');
    expect(lista.status).toBe(200);
    const d = lista.body.documentos.find((x) => x.id === id);
    expect(d).toMatchObject({ titulo: 'Estados financieros 2025 (prueba)', categoria: 'estados_financieros', anio: 2025, tamano: 250000 });
    expect(Object.keys(d).sort()).toEqual(['actualizado', 'anio', 'categoria', 'id', 'tamano', 'titulo']); // sin claves S3 ni datos internos
    expect(lista.body.categorias.estados_financieros).toBe('Estados financieros');
    expect(lista.headers['cache-control']).toMatch(/public/);

    const desc = await request(app).get(`/api/transparencia/pub/${id}/descargar`).redirects(0);
    expect(desc.status).toBe(302);
    expect(desc.headers.location).toContain('X-Amz-Signature');
    expect(desc.headers['cache-control']).toMatch(/no-store/);
  });

  test('despublicar y eliminar (borrado lógico) lo quitan del sitio; reemplazar el PDF no deja huérfanos', async () => {
    const ag = await login('editor');
    const { id } = await conArchivo(ag, { titulo: 'Acta (prueba)', categoria: 'acta_asamblea', anio: 2024 });
    await ag.put(`/api/transparencia/${id}`).send({ publicado: true });

    // Reemplazo del PDF
    const sol = await ag.post(`/api/transparencia/${id}/archivo/solicitar`).send(meta({ nombre: 'nuevo.pdf' }));
    const conf = await ag.patch(`/api/transparencia/${id}/archivo/confirmar`).send({ key: sol.body.key, ...meta({ nombre: 'nuevo.pdf' }) });
    expect(conf.body.archivo_nombre).toBe('nuevo.pdf');
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM archivos WHERE entidad_tipo = 'transparencia_documento' AND entidad_id = $1`, [id])).rows[0].n).toBe(1);

    expect((await ag.put(`/api/transparencia/${id}`).send({ publicado: false })).status).toBe(200);
    expect((await request(app).get('/api/transparencia/pub')).body.documentos.some((d) => d.id === id)).toBe(false);

    await ag.put(`/api/transparencia/${id}`).send({ publicado: true });
    expect((await ag.delete(`/api/transparencia/${id}`)).status).toBe(200);
    expect((await ag.delete(`/api/transparencia/${id}`)).status).toBe(404);
    expect((await request(app).get('/api/transparencia/pub')).body.documentos.some((d) => d.id === id)).toBe(false);
    expect((await ag.get('/api/transparencia')).body.documentos.some((d) => d.id === id)).toBe(false);
    const { rows: [fila] } = await pool.query('SELECT is_active, publicado FROM transparencia_documentos WHERE id = $1', [id]);
    expect(fila).toEqual({ is_active: false, publicado: false });   // sigue en la base
  });

  test('PUT actualiza título, categoría y año; un documento inexistente → 404', async () => {
    const ag = await login('editor');
    const { id } = await conArchivo(ag, { titulo: 'Titulo viejo', categoria: 'otro', anio: 2020 });
    const res = await ag.put(`/api/transparencia/${id}`).send({ titulo: 'Titulo nuevo', categoria: 'certificado', anio: null });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ titulo: 'Titulo nuevo', categoria: 'certificado', anio: null });
    expect((await ag.put(`/api/transparencia/${id}`).send({ archivo_id: 'x' })).status).toBe(400);
    expect((await ag.put('/api/transparencia/00000000-0000-4000-8000-000000000000').send({ titulo: 'X' })).status).toBe(404);
  });
});
