import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { s3 } from '../config/s3.js';
import { env } from '../config/env.js';
import pool from '../db/database.js';

const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE     = 15 * 1024 * 1024; // 15 MB

export const validarArchivo = ({ nombre, mime, size }) => {
  if (!nombre || !mime || !size)      return 'Faltan campos: nombre, mime, size';
  if (!ALLOWED_MIME.includes(mime))   return 'Tipo de archivo no permitido. Usa PDF, JPG o PNG.';
  if (Number(size) > MAX_SIZE)        return 'El archivo excede el límite de 15 MB';
  return null;
};

export const generarPresignedUpload = async (entidadTipo, entidadId, { nombre, mime, size }) => {
  const ext = nombre.split('.').pop().toLowerCase();
  const key = `kernel/${entidadTipo}s/${entidadId}/${randomUUID()}.${ext}`;
  const cmd = new PutObjectCommand({
    Bucket:        env.S3_BUCKET,
    Key:           key,
    ContentType:   mime,
    ContentLength: Number(size),
  });
  const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 900 });
  return { uploadUrl, key };
};

export const guardarArchivo = async (entidadTipo, entidadId, { key, nombre, mime, size }, subioPor) => {
  const { rows: [archivo] } = await pool.query(
    `INSERT INTO archivos (entidad_tipo, entidad_id, s3_key, nombre, mime_type, size_bytes, subido_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [entidadTipo, entidadId, key, nombre, mime, Number(size), subioPor]
  );
  return archivo;
};

export const listarArchivos = async (entidadTipo, entidadId) => {
  const { rows } = await pool.query(
    `SELECT a.*, u.nombre AS subido_por_nombre
     FROM archivos a
     LEFT JOIN global_usuarios u ON u.id = a.subido_por
     WHERE a.entidad_tipo = $1 AND a.entidad_id = $2
     ORDER BY a.created_at DESC`,
    [entidadTipo, entidadId]
  );
  return rows;
};

export const generarPresignedDescarga = async (archivoId) => {
  const { rows: [archivo] } = await pool.query(
    'SELECT * FROM archivos WHERE id = $1',
    [archivoId]
  );
  if (!archivo) return null;

  const cmd = new GetObjectCommand({
    Bucket:                     env.S3_BUCKET,
    Key:                        archivo.s3_key,
    ResponseContentType:        archivo.mime_type || 'application/octet-stream',
    ResponseContentDisposition: `inline; filename="${encodeURIComponent(archivo.nombre)}"`,
  });
  const url = await getSignedUrl(s3, cmd, { expiresIn: 900 });
  return { url, nombre: archivo.nombre, mime: archivo.mime_type, id: archivo.id };
};

export const eliminarArchivo = async (archivoId) => {
  const { rows: [archivo] } = await pool.query(
    'SELECT * FROM archivos WHERE id = $1',
    [archivoId]
  );
  if (!archivo) return false;

  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: archivo.s3_key }));
  await pool.query('DELETE FROM archivos WHERE id = $1', [archivoId]);
  return true;
};
