import pool from '../../../db/database.js';

export const resumen = async (req, res, next) => {
  try {
    // ── Asociados + adopción portal ─────────────────────────────────────────
    const { rows: [asociados] } = await pool.query(`
      SELECT
        (COUNT(*) FILTER (WHERE is_active = true))::int                          AS activos,
        COUNT(*)::int                                                             AS total,
        (COUNT(*) FILTER (WHERE portal_activo = true AND is_active = true))::int AS con_portal
      FROM asociados
    `);

    // Serie diaria de adopción — últimos 90 días
    const { rows: [{ base: adopcionBase }] } = await pool.query(`
      SELECT COUNT(*)::int AS base
      FROM asociados
      WHERE portal_activado_at IS NOT NULL
        AND is_active = true
        AND portal_activado_at < NOW() - INTERVAL '90 days'
    `);

    const { rows: adopcionSerie } = await pool.query(`
      SELECT
        TO_CHAR(DATE(portal_activado_at AT TIME ZONE 'America/Bogota'), 'YYYY-MM-DD') AS dia,
        COUNT(*)::int AS nuevos
      FROM asociados
      WHERE portal_activado_at IS NOT NULL
        AND is_active = true
        AND portal_activado_at >= NOW() - INTERVAL '90 days'
      GROUP BY DATE(portal_activado_at AT TIME ZONE 'America/Bogota')
      ORDER BY DATE(portal_activado_at AT TIME ZONE 'America/Bogota')
    `);

    // Acumulado partiendo desde la base anterior a la ventana
    let acum = adopcionBase;
    const adopcionAcumulada = adopcionSerie.map(row => {
      acum += row.nuevos;
      return { dia: row.dia, nuevos: row.nuevos, acumulado: acum };
    });

    // ── Sorteos activos ──────────────────────────────────────────────────────
    const { rows: sorteos } = await pool.query(`
      SELECT
        s.id, s.nombre, s.estado, s.precio_boleto,
        (COUNT(b.numero) FILTER (WHERE b.estado IN ('asignado','pendiente_retiro')))::int   AS boletos_asignados,
        COUNT(b.numero)::int                                                               AS boletos_total,
        (COUNT(b.numero) FILTER (WHERE b.estado = 'pendiente_adquisicion'))::int          AS boletos_pendientes,
        (COUNT(b.numero) FILTER (WHERE b.estado IN ('asignado','pendiente_retiro')))
          * s.precio_boleto                                                                AS ingreso_mensual,
        (SELECT COUNT(*)::int FROM solicitudes_bono
         WHERE sorteo_id = s.id AND estado = 'pendiente')                                 AS solicitudes_pendientes
      FROM sorteos s
      LEFT JOIN boletos   b ON b.sorteo_id = s.id
      LEFT JOIN asociados a ON a.codigo = b.asociado_codigo
      WHERE s.estado IN ('activo', 'pausado')
      GROUP BY s.id, s.nombre, s.estado, s.precio_boleto
      ORDER BY s.created_at
    `);

    // Serie últimos 30 días (adquisiciones acumuladas por sorteo)
    const { rows: sorteosSerie } = await pool.query(`
      SELECT
        DATE(sl.created_at AT TIME ZONE 'America/Bogota') AS fecha,
        sl.sorteo_id,
        SUM(CASE WHEN sl.accion IN ('COMPRA_DIRECTA','APROBACION') THEN 1 ELSE 0 END)::int               AS adquisiciones,
        SUM(CASE WHEN sl.accion IN ('ANULACION_DIRECTA','APROBACION_RETIRO','LIBERACION_POR_RETIRO_CSV')
                 THEN 1 ELSE 0 END)::int                                                                  AS liberaciones
      FROM sorteo_logs sl
      JOIN sorteos s ON s.id = sl.sorteo_id AND s.estado IN ('activo','pausado')
      WHERE sl.created_at >= NOW() - INTERVAL '30 days'
        AND sl.accion IN ('COMPRA_DIRECTA','APROBACION','ANULACION_DIRECTA','APROBACION_RETIRO','LIBERACION_POR_RETIRO_CSV')
      GROUP BY DATE(sl.created_at AT TIME ZONE 'America/Bogota'), sl.sorteo_id
      ORDER BY fecha
    `);

    // ── Patronales ───────────────────────────────────────────────────────────
    const { rows: [patronales] } = await pool.query(`
      SELECT
        COALESCE(SUM(f.monto_total), 0)::bigint                                               AS total_causado,
        COALESCE(SUM(p.pagado), 0)::bigint                                                    AS total_cobrado,
        COALESCE(SUM(CASE WHEN f.estado = 'vencida'
                     THEN f.monto_total - COALESCE(p.pagado, 0) ELSE 0 END), 0)::bigint      AS total_mora,
        COUNT(DISTINCT CASE WHEN f.estado IN ('pendiente','pago_parcial','vencida')
                       THEN f.empresa_codigo END)::int                                         AS empresas_en_deuda
      FROM patronales_facturas f
      LEFT JOIN (
        SELECT factura_id, SUM(monto) AS pagado FROM patronales_pagos GROUP BY factura_id
      ) p ON p.factura_id = f.id
      WHERE f.estado <> 'anulada'
    `);

    // Top empresas en mora
    const { rows: topMora } = await pool.query(`
      SELECT
        f.empresa_codigo AS codigo,
        e.nombre,
        COALESCE(SUM(CASE WHEN f.estado = 'vencida'
                     THEN f.monto_total - COALESCE(p.pagado, 0) ELSE 0 END), 0)::bigint AS mora
      FROM patronales_facturas f
      JOIN empresas e ON e.codigo = f.empresa_codigo
      LEFT JOIN (
        SELECT factura_id, SUM(monto) AS pagado FROM patronales_pagos GROUP BY factura_id
      ) p ON p.factura_id = f.id
      WHERE f.estado = 'vencida'
      GROUP BY f.empresa_codigo, e.nombre
      HAVING SUM(CASE WHEN f.estado = 'vencida'
                 THEN f.monto_total - COALESCE(p.pagado, 0) ELSE 0 END) > 0
      ORDER BY mora DESC
      LIMIT 5
    `);

    // ── Actividad reciente (admin_logs) ──────────────────────────────────────
    const { rows: logs } = await pool.query(`
      SELECT al.accion, al.detalle, al.created_at,
             gu.nombre AS usuario_nombre
      FROM admin_logs al
      LEFT JOIN global_usuarios gu ON gu.id = al.usuario_uuid
      ORDER BY al.created_at DESC
      LIMIT 10
    `);

    // ── Cartera de créditos ──────────────────────────────────────────────────
    const { rows: [cartera] } = await pool.query(`
      SELECT
        COUNT(ad.id)::int                                                                    AS creditos_activos,
        COALESCE(SUM(ad.saldo_credito), 0)::bigint                                          AS cartera_total,
        COALESCE(SUM(ad.valor_obligacion), 0)::bigint                                       AS obligacion_total,
        COALESCE(SUM(ad.saldo_credito * COALESCE(ad.tasa_interes, 0) / 100), 0)::numeric(16,2) AS intereses_mensual,
        CASE WHEN SUM(ad.saldo_credito) > 0
          THEN ROUND(
            SUM(ad.saldo_credito * COALESCE(ad.tasa_interes, 0)) / SUM(ad.saldo_credito)
          , 4)
          ELSE 0
        END                                                                                    AS tasa_promedio_ponderada
      FROM asociado_descuentos ad
      JOIN asociados a ON a.codigo = ad.asociado_codigo AND a.is_active = true
      WHERE ad.saldo_credito IS NOT NULL AND ad.saldo_credito > 0
    `);

    // Flujo de vencimientos — próximos 12 meses
    const { rows: carteraVencimientos } = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', ad.fecha_vencimiento), 'YYYY-MM') AS mes,
        COUNT(ad.id)::int                                              AS creditos,
        SUM(ad.saldo_credito)::bigint                                  AS capital
      FROM asociado_descuentos ad
      JOIN asociados a ON a.codigo = ad.asociado_codigo AND a.is_active = true
      WHERE ad.saldo_credito > 0
        AND ad.fecha_vencimiento IS NOT NULL
        AND ad.fecha_vencimiento >= DATE_TRUNC('month', NOW())
        AND ad.fecha_vencimiento < DATE_TRUNC('month', NOW()) + INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', ad.fecha_vencimiento)
      ORDER BY DATE_TRUNC('month', ad.fecha_vencimiento)
    `);

    const { rows: carteraDistribucion } = await pool.query(`
      SELECT
        CASE
          WHEN ad.saldo_credito < 1000000   THEN 1
          WHEN ad.saldo_credito < 5000000   THEN 2
          WHEN ad.saldo_credito < 10000000  THEN 3
          WHEN ad.saldo_credito < 20000000  THEN 4
          ELSE 5
        END AS rango_id,
        CASE
          WHEN ad.saldo_credito < 1000000   THEN '< $1M'
          WHEN ad.saldo_credito < 5000000   THEN '$1M–$5M'
          WHEN ad.saldo_credito < 10000000  THEN '$5M–$10M'
          WHEN ad.saldo_credito < 20000000  THEN '$10M–$20M'
          ELSE '> $20M'
        END AS rango,
        COUNT(*)::int AS cantidad,
        SUM(ad.saldo_credito)::bigint AS subtotal
      FROM asociado_descuentos ad
      JOIN asociados a ON a.codigo = ad.asociado_codigo AND a.is_active = true
      WHERE ad.saldo_credito > 0
      GROUP BY rango_id, rango
      ORDER BY rango_id
    `);

    // ── Solicitudes pendientes totales ───────────────────────────────────────
    const { rows: [pendientes] } = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM solicitudes_bono WHERE estado = 'pendiente')          AS bonos,
        (SELECT COUNT(*)::int FROM asociados WHERE solicitud_portal_at IS NOT NULL)      AS portal
    `);

    res.json({
      asociados: {
        ...asociados,
        adopcion_pct: asociados.activos > 0
          ? Number(((asociados.con_portal / asociados.activos) * 100).toFixed(1))
          : 0,
        adopcion_serie: adopcionAcumulada,
      },
      sorteos,
      sorteos_serie: sorteosSerie,
      patronales: { ...patronales, top_mora: topMora },
      cartera: { ...cartera, distribucion: carteraDistribucion, vencimientos: carteraVencimientos },
      logs,
      pendientes,
    });
  } catch (err) { next(err); }
};

export const cobertura = async (req, res, next) => {
  try {
    const { sorteoId } = req.params;
    // Verificar que el sorteo existe y está en estado visible antes de devolver datos
    const { rows: [sorteo] } = await pool.query(
      `SELECT id FROM sorteos WHERE id = $1 AND estado IN ('activo', 'pausado')`,
      [sorteoId]
    );
    if (!sorteo) return res.json([]);

    const { rows } = await pool.query(
      `SELECT
         e.codigo, e.nombre,
         COUNT(DISTINCT a.codigo)::int                                          AS asociados_activos,
         COUNT(DISTINCT b.numero) FILTER (WHERE b.sorteo_id = $1
           AND b.estado = 'asignado')::int                                      AS bonos_asignados
       FROM empresas e
       JOIN asociados a ON a.empresa_dsto = e.codigo AND a.is_active = true
       LEFT JOIN boletos b ON b.asociado_codigo = a.codigo
       WHERE e.is_active = true
       GROUP BY e.codigo, e.nombre
       HAVING COUNT(DISTINCT a.codigo) > 0
       ORDER BY
         (COUNT(DISTINCT b.numero) FILTER (WHERE b.sorteo_id = $1 AND b.estado = 'asignado')::numeric
          / NULLIF(COUNT(DISTINCT a.codigo), 0)) ASC,
         e.nombre`,
      [sorteoId]
    );
    res.json(rows);
  } catch (err) { next(err); }
};
