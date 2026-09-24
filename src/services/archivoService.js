import { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { s3 } from '../config/s3.js';
import { env } from '../config/env.js';
import pool from '../db/database.js';

const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE     = 15 * 1024 * 1024; // 15 MB

// F-08: extensión debe coincidir con el mime declarado — evita renombrar .exe como .pdf
const EXT_TO_MIME = {
  pdf:  'application/pdf',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  png:  'image/png',
  webp: 'image/webp',
};

export const validarArchivo = ({ nombre, mime, size }) => {
  if (!nombre || !mime || !size) return 'Faltan campos: nombre, mime, size';
  if (!ALLOWED_MIME.includes(mime))  return 'Tipo de archivo no permitido. Usa PDF, JPG o PNG.';
  if (Number(size) > MAX_SIZE)       return 'El archivo excede el límite de 15 MB';

  const ext = (nombre.split('.').pop() || '').toLowerCase();
  const expectedMime = EXT_TO_MIME[ext];
  if (!expectedMime || expectedMime !== mime)
    return 'La extensión del archivo no coincide con el tipo declarado.';

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
  const url = await getSignedUrl(s3, cmd, { expiresIn: 300 });
  return { url, nombre: archivo.nombre, mime: archivo.mime_type, id: archivo.id };
};

// Evidencia que nunca se borra por el flujo normal (conservación mínima de 5 a 10 años, Circular Básica Jurídica Título V).
// Solo la retira un proceso de depuración explícito (`permitirEvidencia`) y con el plazo legal cumplido.
const ENTIDADES_PROTEGIDAS = ['captacion_formato', 'captacion_firma_fisica', 'captacion_consulta_listas', 'captacion_consulta_adjunto', 'listas_snapshot',
  'credito_firmado', 'credito_autorizacion', 'credito_evidencia'];

// `omitirS3`: solo borra la fila (tests, o cuando el objeto ya no existe en el bucket).
export const eliminarArchivo = async (archivoId, { omitirS3 = false, permitirEvidencia = false } = {}) => {
  const { rows: [archivo] } = await pool.query(
    'SELECT * FROM archivos WHERE id = $1',
    [archivoId]
  );
  if (!archivo) return false;
  if (!permitirEvidencia && ENTIDADES_PROTEGIDAS.includes(archivo.entidad_tipo)) {
    throw Object.assign(new Error('Este archivo es evidencia de una firma y no se puede eliminar'), { code: 'ARCHIVO_PROTEGIDO' });
  }

  if (!omitirS3) await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: archivo.s3_key }));
  await pool.query('DELETE FROM archivos WHERE id = $1', [archivoId]);
  return true;
};

// ── Archivos generados por el servidor (p. ej. PDF sellado al firmar) ─────────
// En tests no se toca S3: los objetos viven en memoria (mismo contrato, sin red).
const memoriaTest = env.NODE_ENV === 'test' ? new Map() : null;

// Retención (Object Lock) para la evidencia de firma. Solo si el bucket ya lo tiene activo y S3_RETENCION_EVIDENCIA_ANIOS está definida.
const retencionEvidencia = (entidadTipo) => {
  if (!ENTIDADES_PROTEGIDAS.includes(entidadTipo) || !env.S3_RETENCION_EVIDENCIA_ANIOS) return {};
  const hasta = new Date();
  hasta.setFullYear(hasta.getFullYear() + env.S3_RETENCION_EVIDENCIA_ANIOS);
  return { ObjectLockMode: env.S3_RETENCION_MODO, ObjectLockRetainUntilDate: hasta };
};

export const subirBuffer = async (entidadTipo, entidadId, buffer, { nombre, mime }, subioPor = null) => {
  const ext = nombre.split('.').pop().toLowerCase();
  const key = `kernel/${entidadTipo}s/${entidadId}/${randomUUID()}.${ext}`;
  if (memoriaTest) memoriaTest.set(key, Buffer.from(buffer));
  else await s3.send(new PutObjectCommand({
    Bucket: env.S3_BUCKET, Key: key, Body: buffer, ContentType: mime,
    ServerSideEncryption: 'AES256',            // cifrado en reposo
    ChecksumAlgorithm: 'SHA256',               // S3 verifica que lo guardado es exactamente lo enviado
    ...retencionEvidencia(entidadTipo),        // Object Lock: nadie lo borra ni sobrescribe hasta cumplir el plazo
  }));
  return guardarArchivo(entidadTipo, entidadId, { key, nombre, mime, size: buffer.length }, subioPor);
};

// Lee un objeto recién subido con URL prefirmada (aún no tiene fila en `archivos`) para comprobar qué es realmente antes de aceptarlo
export const leerPorKey = async (key) => {
  if (memoriaTest) return memoriaTest.get(key) ?? null;
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return Buffer.from(await out.Body.transformToByteArray());
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
};

// Solo para pruebas: deja un objeto en la memoria que sustituye a S3 (equivale a que el navegador ya hizo el PUT)
export const colocarObjetoDePrueba = (key, buffer) => {
  if (!memoriaTest) throw new Error('Solo disponible en pruebas');
  memoriaTest.set(key, Buffer.from(buffer));
};

export const leerBuffer = async (archivoId) => {
  const { rows: [archivo] } = await pool.query('SELECT s3_key FROM archivos WHERE id = $1', [archivoId]);
  if (!archivo) return null;
  if (memoriaTest) return memoriaTest.get(archivo.s3_key) ?? null;
  const out = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: archivo.s3_key }));
  return Buffer.from(await out.Body.transformToByteArray());
};
