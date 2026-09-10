import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { s3 } from '../../../config/s3.js';
import { env } from '../../../config/env.js';
import pool from '../../../db/database.js';

const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE     = 15 * 1024 * 1024; // 15 MB

// POST /contable/facturas/:id/adjunto — genera presigned PUT URL
export const solicitarUpload = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { nombre, mime, size } = req.body;

    if (!nombre || !mime || !size)
      return res.status(400).json({ error: 'Faltan campos: nombre, mime, size' });
    if (!ALLOWED_MIME.includes(mime))
      return res.status(400).json({ error: 'Tipo de archivo no permitido. Usa PDF, JPG o PNG.' });
    if (Number(size) > MAX_SIZE)
      return res.status(400).json({ error: 'El archivo excede el límite de 15 MB' });

    // Verificar que la factura existe
    const { rows } = await pool.query('SELECT id FROM tesoreria_facturas WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Factura no encontrada' });

    const ext = nombre.split('.').pop().toLowerCase();
    const key = `kernel/facturas/${id}/${randomUUID()}.${ext}`;

    const cmd = new PutObjectCommand({
      Bucket:        env.S3_BUCKET,
      Key:           key,
      ContentType:   mime,
      ContentLength: Number(size),
    });

    const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 900 }); // 15 min
    res.json({ uploadUrl, key });
  } catch (err) { next(err); }
};

// PATCH /contable/facturas/:id/adjunto — confirma upload y guarda key en DB
export const confirmarUpload = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { key, nombre, mime, size } = req.body;

    if (!key || !nombre)
      return res.status(400).json({ error: 'Faltan campos: key, nombre' });

    // Validar que la key pertenece a esta factura
    if (!key.startsWith(`kernel/facturas/${id}/`))
      return res.status(400).json({ error: 'Key inválida para esta factura' });

    await pool.query(
      `UPDATE tesoreria_facturas
       SET adjunto_key=$1, adjunto_nombre=$2, adjunto_mime=$3, adjunto_size=$4
       WHERE id=$5`,
      [key, nombre, mime, Number(size), id]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
};

// GET /contable/facturas/:id/adjunto — genera presigned GET URL para descarga
export const descargarAdjunto = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      'SELECT adjunto_key, adjunto_nombre, adjunto_mime FROM tesoreria_facturas WHERE id=$1',
      [id]
    );
    if (!rows[0]?.adjunto_key)
      return res.status(404).json({ error: 'Esta factura no tiene adjunto' });

    const { adjunto_key, adjunto_nombre, adjunto_mime } = rows[0];

    const cmd = new GetObjectCommand({
      Bucket:                     env.S3_BUCKET,
      Key:                        adjunto_key,
      ResponseContentType:        adjunto_mime || 'application/octet-stream',
      ResponseContentDisposition: `inline; filename="${encodeURIComponent(adjunto_nombre)}"`,
    });

    const url = await getSignedUrl(s3, cmd, { expiresIn: 900 });
    res.json({ url, nombre: adjunto_nombre, mime: adjunto_mime });
  } catch (err) { next(err); }
};

// DELETE /contable/facturas/:id/adjunto — elimina adjunto (solo si la factura aún es pendiente)
export const eliminarAdjunto = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      'SELECT adjunto_key, estado FROM tesoreria_facturas WHERE id=$1',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Factura no encontrada' });
    if (!rows[0].adjunto_key) return res.status(404).json({ error: 'Sin adjunto' });

    const estados_editables = ['pendiente_aprobacion', 'rechazada'];
    if (!estados_editables.includes(rows[0].estado))
      return res.status(409).json({ error: 'No se puede eliminar el adjunto de una factura en proceso' });

    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: rows[0].adjunto_key }));

    await pool.query(
      'UPDATE tesoreria_facturas SET adjunto_key=NULL, adjunto_nombre=NULL, adjunto_mime=NULL, adjunto_size=NULL WHERE id=$1',
      [id]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
};
