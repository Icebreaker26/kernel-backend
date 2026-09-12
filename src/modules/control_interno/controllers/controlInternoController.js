import pool from '../../../db/database.js';
import { aprobarFactura, rechazarFactura } from '../../tesoreria/controllers/tesoreriaController.js';

// Re-exporta las acciones de CI — la lógica vive en tesorería
export { aprobarFactura, rechazarFactura };

export const estadisticas = async (req, res, next) => {
  try {
    const [pipeline, tiempos, mensual, proveedores, porArea, alertas] = await Promise.all([

      // Pipeline: count + monto por estado
      pool.query(`
        SELECT estado,
               COUNT(*)::int        AS total,
               COALESCE(SUM(monto), 0)::numeric AS monto
        FROM tesoreria_facturas
        GROUP BY estado
        ORDER BY CASE estado
          WHEN 'pendiente_aprobacion' THEN 1
          WHEN 'aprobada'             THEN 2
          WHEN 'verificada'           THEN 3
          WHEN 'autorizada'           THEN 4
          WHEN 'pagada'               THEN 5
          WHEN 'rechazada'            THEN 6
        END
      `),

      // Tiempos promedio por etapa (horas), solo facturas pagadas con historial completo
      pool.query(`
        SELECT
          ROUND(AVG(EXTRACT(EPOCH FROM (aprobado_at  - created_at))   / 3600)::numeric, 1) AS pend_aprobada_h,
          ROUND(AVG(EXTRACT(EPOCH FROM (verificada_at - aprobado_at)) / 3600)::numeric, 1) AS aprobada_verificada_h,
          ROUND(AVG(EXTRACT(EPOCH FROM (autorizada_at - verificada_at)) / 3600)::numeric, 1) AS verificada_autorizada_h,
          ROUND(AVG(EXTRACT(EPOCH FROM (pagada_at    - autorizada_at)) / 3600)::numeric, 1) AS autorizada_pagada_h,
          ROUND(AVG(EXTRACT(EPOCH FROM (pagada_at    - created_at))   / 3600)::numeric, 1) AS total_h,
          COUNT(*)::int AS muestra
        FROM tesoreria_facturas
        WHERE estado = 'pagada'
          AND pagada_at IS NOT NULL
          AND aprobado_at IS NOT NULL
      `),

      // Volumen mensual — últimos 6 meses
      pool.query(`
        SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS mes,
               COUNT(*)::int               AS total,
               COALESCE(SUM(monto), 0)::numeric AS monto
        FROM tesoreria_facturas
        WHERE created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '5 months'
        GROUP BY mes
        ORDER BY mes
      `),

      // Top 5 proveedores por monto total facturado
      pool.query(`
        SELECT p.nombre,
               COUNT(*)::int               AS facturas,
               COALESCE(SUM(f.monto), 0)::numeric AS monto
        FROM tesoreria_facturas f
        JOIN tesoreria_proveedores p ON p.id = f.proveedor_id
        GROUP BY p.id, p.nombre
        ORDER BY monto DESC
        LIMIT 5
      `),

      // Distribución por área responsable
      pool.query(`
        SELECT COALESCE(area_responsable, 'Sin área') AS area,
               COUNT(*)::int               AS total,
               COALESCE(SUM(monto), 0)::numeric AS monto
        FROM tesoreria_facturas
        GROUP BY area
        ORDER BY monto DESC
      `),

      // Alertas: vencidas y próximas a vencer (en proceso)
      pool.query(`
        SELECT
          COUNT(*) FILTER (
            WHERE fecha_vencimiento < CURRENT_DATE
          )::int AS vencidas,
          COALESCE(SUM(monto) FILTER (
            WHERE fecha_vencimiento < CURRENT_DATE
          ), 0)::numeric AS monto_vencidas,
          COUNT(*) FILTER (
            WHERE fecha_vencimiento BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
          )::int AS proximas_7d,
          COUNT(*)::int AS total_en_proceso
        FROM tesoreria_facturas
        WHERE estado IN ('pendiente_aprobacion', 'aprobada', 'verificada', 'autorizada')
      `)
    ]);

    res.json({
      pipeline:    pipeline.rows,
      tiempos:     tiempos.rows[0],
      mensual:     mensual.rows,
      proveedores: proveedores.rows,
      por_area:    porArea.rows,
      alertas:     alertas.rows[0],
    });
  } catch (err) { next(err); }
};

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
