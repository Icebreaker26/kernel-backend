import pool from '../../../db/database.js';
import { generarPresignedDescarga, listarArchivos } from '../../../services/archivoService.js';

const facturaBase = `
  SELECT f.*,
         p.nombre      AS proveedor_nombre,
         p.nit         AS proveedor_nit,
         p.email       AS proveedor_email,
         p.telefono    AS proveedor_telefono,
         p.tipo_pago   AS proveedor_tipo,
         p.categoria   AS proveedor_categoria,
         ur.nombre     AS registrado_por_nombre,
         ur.avatar_url AS registrado_por_avatar_url,
         ua.nombre     AS aprobado_por_nombre,
         CASE WHEN f.fecha_vencimiento < CURRENT_DATE THEN true ELSE false END AS vencida,
         (SELECT row_to_json(a) FROM archivos a
          WHERE a.entidad_tipo = 'factura' AND a.entidad_id = f.id
          ORDER BY a.created_at DESC LIMIT 1) AS adjunto
    FROM tesoreria_facturas f
    JOIN tesoreria_proveedores p ON p.id = f.proveedor_id
    LEFT JOIN global_usuarios ur ON ur.id = f.registrado_por
    LEFT JOIN global_usuarios ua ON ua.id = f.aprobado_por
`;

export const misFacturas = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `${facturaBase}
       WHERE f.responsable_id = $1 AND f.estado = 'pendiente_aprobacion'
       ORDER BY f.fecha_vencimiento ASC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
};

export const contarPendientes = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM tesoreria_facturas
        WHERE responsable_id = $1 AND estado = 'pendiente_aprobacion'`,
      [req.user.id]
    );
    res.json({ total: rows[0].total });
  } catch (err) { next(err); }
};

export const listarUsuarios = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nombre, rol FROM global_usuarios
        WHERE is_active = true AND is_approved = true
        ORDER BY nombre ASC`
    );
    res.json(rows);
  } catch (err) { next(err); }
};

export const getDetalle = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `${facturaBase} WHERE f.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Factura no encontrada' });
    res.json(rows[0]);
  } catch (err) { next(err); }
};

export const historial = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `${facturaBase}
       WHERE f.responsable_id = $1
       ORDER BY f.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
};

export const rechazar = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { motivo } = req.body;
    if (!motivo?.trim()) return res.status(400).json({ error: 'El motivo de rechazo es obligatorio' });

    const { rows } = await pool.query(
      `SELECT estado, responsable_id FROM tesoreria_facturas WHERE id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Factura no encontrada' });
    const f = rows[0];
    if (f.estado !== 'pendiente_aprobacion')
      return res.status(400).json({ error: 'Solo se pueden rechazar facturas pendientes de aprobación' });
    if (f.responsable_id && f.responsable_id !== req.user.id)
      return res.status(403).json({ error: 'No tienes permiso para rechazar esta factura' });

    const { rows: updated } = await pool.query(
      `UPDATE tesoreria_facturas
          SET estado = 'rechazada', rechazo_motivo = $1
        WHERE id = $2
        RETURNING *`,
      [motivo.trim(), id]
    );
    res.json(updated[0]);
  } catch (err) { next(err); }
};

export const aprobar = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT estado, responsable_id FROM tesoreria_facturas WHERE id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Factura no encontrada' });
    const f = rows[0];
    if (f.estado !== 'pendiente_aprobacion')
      return res.status(400).json({ error: 'La factura no está pendiente de aprobación' });
    if (f.responsable_id && f.responsable_id !== req.user.id)
      return res.status(403).json({ error: 'No tienes permiso para aprobar esta factura' });

    const { rows: updated } = await pool.query(
      `UPDATE tesoreria_facturas
          SET estado = 'aprobada', aprobado_por = $1, aprobado_at = NOW()
        WHERE id = $2
        RETURNING *`,
      [req.user.id, id]
    );
    res.json(updated[0]);
  } catch (err) { next(err); }
};

export const verAdjunto = async (req, res, next) => {
  try {
    const archivos = await listarArchivos('factura', req.params.id);
    if (!archivos.length) return res.status(404).json({ error: 'Sin adjunto' });
    const result = await generarPresignedDescarga(archivos[0].id);
    res.json(result);
  } catch (err) { next(err); }
};
