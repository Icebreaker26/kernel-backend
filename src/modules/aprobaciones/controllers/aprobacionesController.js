import pool from '../../../db/database.js';

const facturaBase = `
  SELECT f.*,
         p.nombre      AS proveedor_nombre,
         p.tipo_pago   AS proveedor_tipo,
         p.categoria   AS proveedor_categoria,
         ur.nombre     AS registrado_por_nombre,
         CASE WHEN f.fecha_vencimiento < CURRENT_DATE THEN true ELSE false END AS vencida
    FROM tesoreria_facturas f
    JOIN tesoreria_proveedores p ON p.id = f.proveedor_id
    LEFT JOIN global_usuarios ur ON ur.id = f.registrado_por
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
