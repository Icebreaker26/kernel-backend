import pool from '../../../db/database.js';
import { aprobarFactura, rechazarFactura } from '../../tesoreria/controllers/tesoreriaController.js';

// Re-exporta las acciones de CI — la lógica vive en tesorería
export { aprobarFactura, rechazarFactura };

// Vista de facturas listas para verificar (aprobadas por el área responsable)
export const listarPendientes = async (req, res, next) => {
  try {
    const { estado = 'aprobada', proveedor_id, vence_antes } = req.query;
    const conds = [`f.estado = $1`];
    const vals  = [estado];
    let i = 2;
    if (proveedor_id) { conds.push(`f.proveedor_id = $${i++}`); vals.push(proveedor_id); }
    if (vence_antes)  { conds.push(`f.fecha_vencimiento <= $${i++}`); vals.push(vence_antes); }

    const { rows } = await pool.query(`
      SELECT f.*,
             p.nombre      AS proveedor_nombre,
             p.tipo_pago   AS proveedor_tipo,
             p.frecuencia  AS proveedor_frecuencia,
             p.categoria   AS proveedor_categoria,
             ur.nombre     AS registrado_por_nombre,
             ua.nombre     AS aprobado_por_nombre,
             uresp.nombre  AS responsable_nombre,
             CASE WHEN f.fecha_vencimiento < CURRENT_DATE THEN true ELSE false END AS vencida
        FROM tesoreria_facturas f
        JOIN tesoreria_proveedores p    ON p.id    = f.proveedor_id
        LEFT JOIN global_usuarios ur    ON ur.id   = f.registrado_por
        LEFT JOIN global_usuarios ua    ON ua.id   = f.aprobado_por
        LEFT JOIN global_usuarios uresp ON uresp.id = f.responsable_id
       WHERE ${conds.join(' AND ')}
       ORDER BY f.fecha_vencimiento ASC
    `, vals);
    res.json(rows);
  } catch (err) { next(err); }
};
