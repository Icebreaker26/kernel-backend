import { z } from 'zod';
import pool from '../../../db/database.js';
import { generarPresignedUpload, guardarArchivo, generarPresignedDescarga, eliminarArchivo, validarArchivo } from '../../../services/archivoService.js';
import { sanitizarContenido, textoPlano } from '../../../services/sanitizarHtml.js';
import {
  crearEntradaSchema, actualizarEntradaSchema, crearCategoriaSchema, IMAGEN_MIMES, MAX_PORTADA, POR_PAGINA,
} from '../schemas/blogSchema.js';

const ENTIDAD = 'blog_entrada';
const esUuid = (v) => z.string().uuid().safeParse(v).success;

const slugificar = (texto) => String(texto)
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'entrada';

// Slug único entre las entradas activas (agrega -2, -3... si ya existe)
const slugUnico = async (titulo, idExcluir = null) => {
  const base = slugificar(titulo);
  for (let n = 1; n < 500; n += 1) {
    const candidato = n === 1 ? base : `${base}-${n}`;
    const { rowCount } = await pool.query(
      `SELECT 1 FROM blog_entradas WHERE slug = $1 AND is_active AND ($2::uuid IS NULL OR id <> $2)`, [candidato, idExcluir]);
    if (!rowCount) return candidato;
  }
  return `${base}-${Date.now()}`;
};

// Resumen automático a partir del contenido cuando no se escribió uno
const resumenAuto = (html) => {
  const t = textoPlano(html);
  if (t.length <= 200) return t;
  const corte = t.slice(0, 200);
  return `${corte.slice(0, Math.max(corte.lastIndexOf(' '), 120))}…`;
};

const sqlEntrada = (conContenido = false) => `
  SELECT e.id, e.titulo,${conContenido ? ' e.contenido,' : ''} e.slug, e.resumen, e.estado, e.publicado_at, e.created_at, e.updated_at,
         e.categoria_id, c.nombre AS categoria_nombre, c.slug AS categoria_slug,
         (e.portada_archivo_id IS NOT NULL) AS tiene_portada,
         u.nombre AS autor_nombre
    FROM blog_entradas e
    LEFT JOIN blog_categorias c ON c.id = e.categoria_id
    LEFT JOIN global_usuarios u ON u.id = e.autor_id`;
const SQL_ENTRADA = sqlEntrada();

// ── Público (sin sesión) ──────────────────────────────────────────────────────

const publica = (e, conContenido = false) => ({
  slug: e.slug, titulo: e.titulo, resumen: e.resumen, publicado_at: e.publicado_at,
  categoria: e.categoria_slug ? { slug: e.categoria_slug, nombre: e.categoria_nombre } : null,
  tiene_portada: e.tiene_portada,
  ...(conContenido ? { contenido: e.contenido } : {}),
});

export const pubListar = async (req, res, next) => {
  try {
    const pagina = Math.max(1, parseInt(req.query.pagina, 10) || 1);
    const categoria = typeof req.query.categoria === 'string' ? req.query.categoria.slice(0, 80) : null;
    const filtro = `e.is_active AND e.estado = 'publicado' AND ($1::text IS NULL OR c.slug = $1)`;

    const { rows: [{ total }] } = await pool.query(
      `SELECT COUNT(*)::int AS total FROM blog_entradas e LEFT JOIN blog_categorias c ON c.id = e.categoria_id WHERE ${filtro}`, [categoria]);
    const { rows } = await pool.query(
      `${SQL_ENTRADA} WHERE ${filtro} ORDER BY e.publicado_at DESC, e.id LIMIT ${POR_PAGINA} OFFSET $2`,
      [categoria, (pagina - 1) * POR_PAGINA]);
    const { rows: categorias } = await pool.query(
      `SELECT c.slug, c.nombre, COUNT(e.id)::int AS total
         FROM blog_categorias c
         JOIN blog_entradas e ON e.categoria_id = c.id AND e.is_active AND e.estado = 'publicado'
        WHERE c.is_active GROUP BY c.id ORDER BY c.nombre`);

    res.set('Cache-Control', 'public, max-age=60');
    res.json({ entradas: rows.map((e) => publica(e)), categorias, total, pagina, paginas: Math.max(1, Math.ceil(total / POR_PAGINA)) });
  } catch (err) { next(err); }
};

export const pubDetalle = async (req, res, next) => {
  try {
    const { rows: [e] } = await pool.query(
      `${sqlEntrada(true)} WHERE e.slug = $1 AND e.is_active AND e.estado = 'publicado'`, [req.params.slug]);
    if (!e) return res.status(404).json({ error: 'Entrada no encontrada' });
    res.set('Cache-Control', 'public, max-age=60');
    res.json(publica(e, true));
  } catch (err) { next(err); }
};

// Redirige a una URL firmada de corta duración: el bucket no es público
export const pubPortada = async (req, res, next) => {
  try {
    const { rows: [e] } = await pool.query(
      `SELECT portada_archivo_id FROM blog_entradas
        WHERE slug = $1 AND is_active AND estado = 'publicado' AND portada_archivo_id IS NOT NULL`, [req.params.slug]);
    if (!e) return res.status(404).json({ error: 'Imagen no encontrada' });
    const f = await generarPresignedDescarga(e.portada_archivo_id);
    if (!f) return res.status(404).json({ error: 'Imagen no encontrada' });
    res.set('Cache-Control', 'public, max-age=120');
    // helmet manda `Cross-Origin-Resource-Policy: same-origin`, y con eso el navegador bloquea la imagen cuando la pide el sitio
    // (otro dominio) con <img>. Esta ruta solo sirve portadas de entradas YA publicadas, así que puede cargarse desde cualquier sitio.
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.redirect(302, f.url);
  } catch (err) { next(err); }
};

// ── Gestión (desde Kernel) ────────────────────────────────────────────────────

export const listar = async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`${SQL_ENTRADA} WHERE e.is_active ORDER BY e.updated_at DESC`);
    res.json(rows);
  } catch (err) { next(err); }
};

export const listarCategorias = async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT id, nombre, slug FROM blog_categorias WHERE is_active ORDER BY nombre`);
    res.json(rows);
  } catch (err) { next(err); }
};

export const crearCategoria = async (req, res, next) => {
  try {
    const { nombre } = crearCategoriaSchema.parse(req.body);
    const slug = slugificar(nombre);
    const { rows: [existente] } = await pool.query(`SELECT id FROM blog_categorias WHERE slug = $1`, [slug]);
    if (existente) return res.status(409).json({ error: 'Ya existe una categoría con ese nombre' });
    const { rows: [c] } = await pool.query(`INSERT INTO blog_categorias (nombre, slug) VALUES ($1, $2) RETURNING id, nombre, slug`, [nombre, slug]);
    res.status(201).json(c);
  } catch (err) { next(err); }
};

export const obtener = async (req, res, next) => {
  try {
    if (!esUuid(req.params.id)) return res.status(404).json({ error: 'Entrada no encontrada' });
    const { rows: [e] } = await pool.query(`${sqlEntrada(true)} WHERE e.id = $1 AND e.is_active`, [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Entrada no encontrada' });
    res.json(e);
  } catch (err) { next(err); }
};

const validarCategoria = async (categoriaId) => {
  if (!categoriaId) return true;
  const { rowCount } = await pool.query(`SELECT 1 FROM blog_categorias WHERE id = $1 AND is_active`, [categoriaId]);
  return rowCount > 0;
};

export const crear = async (req, res, next) => {
  try {
    const data = crearEntradaSchema.parse(req.body);
    if (!(await validarCategoria(data.categoria_id))) return res.status(400).json({ error: 'La categoría no existe' });
    const slug = await slugUnico(data.titulo);
    const { rows: [e] } = await pool.query(
      `INSERT INTO blog_entradas (titulo, slug, resumen, contenido, categoria_id, autor_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [data.titulo, slug, data.resumen || null, sanitizarContenido(data.contenido), data.categoria_id ?? null, req.user.id]);
    req.params.id = e.id;
    res.status(201);
    return obtener(req, res, next);
  } catch (err) { return next(err); }
};

export const actualizar = async (req, res, next) => {
  try {
    if (!esUuid(req.params.id)) return res.status(404).json({ error: 'Entrada no encontrada' });
    const data = actualizarEntradaSchema.parse(req.body);
    const { rows: [actual] } = await pool.query(
      `SELECT id, titulo, resumen, contenido, publicado_at, estado FROM blog_entradas WHERE id = $1 AND is_active`, [req.params.id]);
    if (!actual) return res.status(404).json({ error: 'Entrada no encontrada' });
    if (data.categoria_id !== undefined && !(await validarCategoria(data.categoria_id))) {
      return res.status(400).json({ error: 'La categoría no existe' });
    }

    const sets = []; const vals = [req.params.id];
    const poner = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

    const contenido = data.contenido !== undefined ? sanitizarContenido(data.contenido) : actual.contenido;
    if (data.contenido !== undefined) poner('contenido', contenido);
    if (data.resumen !== undefined)   poner('resumen', data.resumen || null);
    if (data.categoria_id !== undefined) poner('categoria_id', data.categoria_id);
    if (data.titulo !== undefined) {
      poner('titulo', data.titulo);
      // El slug solo cambia mientras la entrada nunca se ha publicado: una URL publicada no se rompe
      if (!actual.publicado_at && data.titulo !== actual.titulo) poner('slug', await slugUnico(data.titulo, actual.id));
    }
    if (data.estado !== undefined) {
      if (data.estado === 'publicado') {
        const tituloFinal = data.titulo ?? actual.titulo;
        if (!tituloFinal || !textoPlano(contenido)) {
          return res.status(400).json({ error: 'Escribe el título y el contenido antes de publicar la entrada' });
        }
        poner('estado', 'publicado');
        if (!actual.publicado_at) sets.push('publicado_at = NOW()');
        const resumenFinal = data.resumen !== undefined ? data.resumen : actual.resumen;
        if (!resumenFinal) poner('resumen', resumenAuto(contenido));
      } else {
        poner('estado', 'borrador');
      }
    }
    if (sets.length) await pool.query(`UPDATE blog_entradas SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, vals);
    return obtener(req, res, next);
  } catch (err) { return next(err); }
};

// Borrado lógico: deja de verse en el sitio; la portada y el texto se conservan
export const eliminar = async (req, res, next) => {
  try {
    if (!esUuid(req.params.id)) return res.status(404).json({ error: 'Entrada no encontrada' });
    const { rowCount } = await pool.query(
      `UPDATE blog_entradas SET is_active = false, estado = 'borrador', updated_at = NOW() WHERE id = $1 AND is_active`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Entrada no encontrada' });
    res.json({ ok: true });
  } catch (err) { next(err); }
};

// ── Portada (imagen en S3) ────────────────────────────────────────────────────

const validarImagen = ({ nombre, mime, size }) => {
  const error = validarArchivo({ nombre, mime, size });
  if (error) return error;
  if (!IMAGEN_MIMES.includes(mime)) return 'La portada debe ser una imagen JPG, PNG o WebP';
  if (Number(size) > MAX_PORTADA) return 'La portada no puede pesar más de 5 MB';
  return null;
};

export const solicitarPortada = async (req, res, next) => {
  try {
    if (!esUuid(req.params.id)) return res.status(404).json({ error: 'Entrada no encontrada' });
    const error = validarImagen(req.body || {});
    if (error) return res.status(400).json({ error });
    const { rows: [e] } = await pool.query(`SELECT id FROM blog_entradas WHERE id = $1 AND is_active`, [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Entrada no encontrada' });
    res.json(await generarPresignedUpload(ENTIDAD, e.id, req.body));
  } catch (err) { next(err); }
};

export const confirmarPortada = async (req, res, next) => {
  try {
    if (!esUuid(req.params.id)) return res.status(404).json({ error: 'Entrada no encontrada' });
    const { key, nombre, mime, size } = req.body || {};
    const error = validarImagen({ nombre, mime, size });
    if (error) return res.status(400).json({ error });
    const { rows: [e] } = await pool.query(`SELECT id, portada_archivo_id FROM blog_entradas WHERE id = $1 AND is_active`, [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Entrada no encontrada' });
    // La clave debe ser de ESTA entrada (la generó solicitarPortada): evita apuntar a archivos ajenos
    if (typeof key !== 'string' || !key.startsWith(`kernel/${ENTIDAD}s/${e.id}/`)) {
      return res.status(400).json({ error: 'El archivo no corresponde a esta entrada' });
    }
    const archivo = await guardarArchivo(ENTIDAD, e.id, { key, nombre, mime, size }, req.user.id);
    await pool.query(`UPDATE blog_entradas SET portada_archivo_id = $1, updated_at = NOW() WHERE id = $2`, [archivo.id, e.id]);
    // Reemplazo: la portada anterior deja de ocupar espacio
    if (e.portada_archivo_id) await eliminarArchivo(e.portada_archivo_id, { omitirS3: process.env.NODE_ENV === 'test' }).catch(() => {});
    return obtener(req, res, next);
  } catch (err) { return next(err); }
};

// Vista de la portada para el editor de Kernel (incluye borradores)
export const verPortada = async (req, res, next) => {
  try {
    if (!esUuid(req.params.id)) return res.status(404).json({ error: 'Entrada no encontrada' });
    const { rows: [e] } = await pool.query(`SELECT portada_archivo_id FROM blog_entradas WHERE id = $1 AND is_active AND portada_archivo_id IS NOT NULL`, [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Imagen no encontrada' });
    const f = await generarPresignedDescarga(e.portada_archivo_id);
    if (!f) return res.status(404).json({ error: 'Imagen no encontrada' });
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ url: f.url });
  } catch (err) { next(err); }
};

export const quitarPortada = async (req, res, next) => {
  try {
    if (!esUuid(req.params.id)) return res.status(404).json({ error: 'Entrada no encontrada' });
    const { rows: [e] } = await pool.query(`SELECT id, portada_archivo_id FROM blog_entradas WHERE id = $1 AND is_active`, [req.params.id]);
    if (!e) return res.status(404).json({ error: 'Entrada no encontrada' });
    await pool.query(`UPDATE blog_entradas SET portada_archivo_id = NULL, updated_at = NOW() WHERE id = $1`, [e.id]);
    if (e.portada_archivo_id) await eliminarArchivo(e.portada_archivo_id, { omitirS3: process.env.NODE_ENV === 'test' }).catch(() => {});
    return obtener(req, res, next);
  } catch (err) { return next(err); }
};
