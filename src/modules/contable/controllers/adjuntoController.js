import pool from '../../../db/database.js';
import {
  validarArchivo,
  generarPresignedUpload,
  guardarArchivo,
  listarArchivos,
  generarPresignedDescarga,
  eliminarArchivo,
} from '../../../services/archivoService.js';

const EDITABLE_ESTADOS = ['pendiente_aprobacion', 'rechazada'];

// POST /contable/facturas/:id/adjunto — genera presigned PUT URL
export const solicitarUpload = async (req, res, next) => {
  try {
    const { id } = req.params;
    const error = validarArchivo(req.body);
    if (error) return res.status(400).json({ error });

    const { rows } = await pool.query('SELECT id FROM tesoreria_facturas WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Factura no encontrada' });

    const result = await generarPresignedUpload('factura', id, req.body);
    res.json(result);
  } catch (err) { next(err); }
};

// PATCH /contable/facturas/:id/adjunto — confirma upload y guarda en archivos
export const confirmarUpload = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { key, nombre, mime, size } = req.body;

    if (!key || !nombre) return res.status(400).json({ error: 'Faltan campos: key, nombre' });
    if (!key.startsWith(`kernel/facturas/${id}/`))
      return res.status(400).json({ error: 'Key inválida para esta factura' });

    await guardarArchivo('factura', id, { key, nombre, mime, size }, req.user.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
};

// GET /contable/facturas/:id/adjunto — lista archivos o descarga el primero
export const descargarAdjunto = async (req, res, next) => {
  try {
    const { id } = req.params;
    const archivos = await listarArchivos('factura', id);
    if (!archivos.length) return res.status(404).json({ error: 'Esta factura no tiene adjunto' });

    const result = await generarPresignedDescarga(archivos[0].id);
    res.json(result);
  } catch (err) { next(err); }
};

// GET /contable/facturas/:id/archivos — lista todos los archivos de la factura
export const listarAdjuntos = async (req, res, next) => {
  try {
    const archivos = await listarArchivos('factura', req.params.id);
    res.json(archivos);
  } catch (err) { next(err); }
};

// GET /contable/facturas/:id/archivos/:archivoId — presigned URL para un archivo específico
export const descargarArchivo = async (req, res, next) => {
  try {
    const result = await generarPresignedDescarga(req.params.archivoId);
    if (!result) return res.status(404).json({ error: 'Archivo no encontrado' });
    res.json(result);
  } catch (err) { next(err); }
};

// DELETE /contable/facturas/:id/adjunto — elimina el adjunto más reciente
export const eliminarAdjunto = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: [f] } = await pool.query(
      'SELECT estado FROM tesoreria_facturas WHERE id = $1', [id]
    );
    if (!f) return res.status(404).json({ error: 'Factura no encontrada' });
    if (!EDITABLE_ESTADOS.includes(f.estado))
      return res.status(409).json({ error: 'No se puede eliminar el adjunto de una factura en proceso' });

    const archivos = await listarArchivos('factura', id);
    if (!archivos.length) return res.status(404).json({ error: 'Sin adjunto' });

    await eliminarArchivo(archivos[0].id);
    res.json({ ok: true });
  } catch (err) { next(err); }
};

// DELETE /contable/facturas/:id/archivos/:archivoId — elimina un archivo específico
export const eliminarArchivoEspecifico = async (req, res, next) => {
  try {
    const { id, archivoId } = req.params;
    const { rows: [f] } = await pool.query(
      'SELECT estado FROM tesoreria_facturas WHERE id = $1', [id]
    );
    if (!f) return res.status(404).json({ error: 'Factura no encontrada' });
    if (!EDITABLE_ESTADOS.includes(f.estado))
      return res.status(409).json({ error: 'No se puede eliminar archivos de una factura en proceso' });

    const ok = await eliminarArchivo(archivoId);
    if (!ok) return res.status(404).json({ error: 'Archivo no encontrado' });
    res.json({ ok: true });
  } catch (err) { next(err); }
};
