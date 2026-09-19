import pool from '../../../db/database.js';
import { generarPresignedUpload, guardarArchivo, generarPresignedDescarga, eliminarArchivo } from '../../../services/archivoService.js';
import { CATEGORIAS, crearDocumentoSchema, actualizarDocumentoSchema } from '../schemas/transparenciaSchema.js';

const ENTIDAD = 'transparencia_documento';
const MAX_PDF = 25 * 1024 * 1024;

// Solo PDF: son documentos para leer y descargar (validarArchivo del servicio también permite imágenes)
const validarPdf = ({ nombre, mime, size }) => {
  if (!nombre || !mime || !size) return 'Faltan campos: nombre, mime, size';
  if (mime !== 'application/pdf' || !/\.pdf$/i.test(nombre)) return 'Solo se admiten archivos PDF';
  if (Number(size) > MAX_PDF) return 'El PDF excede el límite de 25 MB';
  return null;
};

const SQL_DOC = `
  SELECT d.id, d.titulo, d.categoria, d.anio, d.publicado, d.created_at, d.updated_at,
         a.nombre AS archivo_nombre, a.size_bytes AS archivo_size
    FROM transparencia_documentos d
    LEFT JOIN archivos a ON a.id = d.archivo_id`;

// ── Público (sin sesión) ──────────────────────────────────────────────────────

export const pubListar = async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `${SQL_DOC} WHERE d.is_active AND d.publicado AND d.archivo_id IS NOT NULL
        ORDER BY d.categoria, d.anio DESC NULLS LAST, d.titulo`);
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      categorias: CATEGORIAS,
      documentos: rows.map((d) => ({
        id: d.id, titulo: d.titulo, categoria: d.categoria, anio: d.anio,
        tamano: d.archivo_size, actualizado: d.updated_at,
      })),
    });
  } catch (err) { next(err); }
};

// Redirige a una URL firmada de corta duración: el bucket no es público
export const pubDescargar = async (req, res, next) => {
  try {
    const { rows: [d] } = await pool.query(
      `SELECT archivo_id FROM transparencia_documentos
        WHERE id = $1 AND is_active AND publicado AND archivo_id IS NOT NULL`, [req.params.id]);
    if (!d) return res.status(404).json({ error: 'Documento no encontrado' });
    const f = await generarPresignedDescarga(d.archivo_id);
    if (!f) return res.status(404).json({ error: 'Documento no encontrado' });
    res.set('Cache-Control', 'no-store');
    res.redirect(302, f.url);
  } catch (err) { next(err); }
};

// ── Gestión (desde Kernel) ────────────────────────────────────────────────────

export const listar = async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`${SQL_DOC} WHERE d.is_active ORDER BY d.categoria, d.anio DESC NULLS LAST, d.titulo`);
    res.json({ categorias: CATEGORIAS, documentos: rows });
  } catch (err) { next(err); }
};

export const crear = async (req, res, next) => {
  try {
    const data = crearDocumentoSchema.parse(req.body);
    // Un documento sin archivo no se puede publicar: se crea en borrador y se publica al subir el PDF
    const { rows: [d] } = await pool.query(
      `INSERT INTO transparencia_documentos (titulo, categoria, anio, publicado, creado_por)
       VALUES ($1,$2,$3,false,$4) RETURNING id`, [data.titulo, data.categoria, data.anio, req.user.id]);
    const { rows: [fila] } = await pool.query(`${SQL_DOC} WHERE d.id = $1`, [d.id]);
    res.status(201).json(fila);
  } catch (err) { next(err); }
};

export const actualizar = async (req, res, next) => {
  try {
    const data = actualizarDocumentoSchema.parse(req.body);
    const { rows: [actual] } = await pool.query(
      `SELECT id, archivo_id FROM transparencia_documentos WHERE id = $1 AND is_active`, [req.params.id]);
    if (!actual) return res.status(404).json({ error: 'Documento no encontrado' });
    if (data.publicado === true && !actual.archivo_id) {
      return res.status(400).json({ error: 'Sube el PDF antes de publicar el documento' });
    }
    const campos = Object.keys(data);
    if (campos.length) {
      const sets = campos.map((k, i) => `${k} = $${i + 2}`);
      await pool.query(`UPDATE transparencia_documentos SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`,
        [req.params.id, ...campos.map((k) => data[k])]);
    }
    const { rows: [fila] } = await pool.query(`${SQL_DOC} WHERE d.id = $1`, [req.params.id]);
    res.json(fila);
  } catch (err) { next(err); }
};

// Borrado lógico: deja de verse y de listarse; el PDF se conserva por si hay que recuperarlo
export const eliminar = async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE transparencia_documentos SET is_active = false, publicado = false, updated_at = NOW()
        WHERE id = $1 AND is_active`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Documento no encontrado' });
    res.json({ ok: true });
  } catch (err) { next(err); }
};

export const solicitarArchivo = async (req, res, next) => {
  try {
    const error = validarPdf(req.body || {});
    if (error) return res.status(400).json({ error });
    const { rows: [d] } = await pool.query(`SELECT id FROM transparencia_documentos WHERE id = $1 AND is_active`, [req.params.id]);
    if (!d) return res.status(404).json({ error: 'Documento no encontrado' });
    res.json(await generarPresignedUpload(ENTIDAD, d.id, req.body));
  } catch (err) { next(err); }
};

export const confirmarArchivo = async (req, res, next) => {
  try {
    const { key, nombre, mime, size } = req.body || {};
    const error = validarPdf({ nombre, mime, size });
    if (error) return res.status(400).json({ error });
    const { rows: [d] } = await pool.query(
      `SELECT id, archivo_id FROM transparencia_documentos WHERE id = $1 AND is_active`, [req.params.id]);
    if (!d) return res.status(404).json({ error: 'Documento no encontrado' });
    // La clave debe ser de ESTE documento (la generó solicitarArchivo): evita apuntar a archivos ajenos
    if (typeof key !== 'string' || !key.startsWith(`kernel/${ENTIDAD}s/${d.id}/`)) {
      return res.status(400).json({ error: 'El archivo no corresponde a este documento' });
    }
    const archivo = await guardarArchivo(ENTIDAD, d.id, { key, nombre, mime, size }, req.user.id);
    await pool.query(`UPDATE transparencia_documentos SET archivo_id = $1, updated_at = NOW() WHERE id = $2`, [archivo.id, d.id]);
    // Reemplazo: el PDF anterior deja de ocupar espacio (la fila y, si existe, el objeto en S3)
    if (d.archivo_id) await eliminarArchivo(d.archivo_id, { omitirS3: process.env.NODE_ENV === 'test' }).catch(() => {});
    const { rows: [fila] } = await pool.query(`${SQL_DOC} WHERE d.id = $1`, [d.id]);
    res.json(fila);
  } catch (err) { next(err); }
};
