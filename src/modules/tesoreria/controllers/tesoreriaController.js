import pool from '../../../db/database.js';
import ExcelJS from 'exceljs';
import iconv from 'iconv-lite';
import {
  crearCuentaSchema, actualizarCuentaSchema, desactivarCuentaSchema,
  crearCategoriaSchema, actualizarCategoriaSchema,
  crearPeriodoSchema,
  crearMovimientoSchema,
  crearProveedorSchema, actualizarProveedorSchema,
  crearFacturaSchema, aprobarAreaSchema, autorizarPagoSchema, rechazarFacturaSchema,
  crearUmbralSchema, actualizarUmbralSchema,
  confirmarExtractoSchema, conciliarSchema,
} from '../schemas/tesoreriaSchema.js';
import { parseBancolombiaPwxl } from '../services/bancolombiaPwxlParser.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

// C-3: UNION ALL en lugar de OR para evitar doble conteo cuando un movimiento
// de tipo ingreso/egreso tiene cuenta_destino_id relleno indebidamente.
const saldoActual = `
  COALESCE((
    SELECT SUM(val) FROM (
      SELECT CASE WHEN tipo = 'ingreso' THEN monto ELSE -monto END AS val
        FROM tesoreria_movimientos
       WHERE cuenta_id = c.id AND tipo IN ('ingreso', 'egreso')
      UNION ALL
      SELECT -monto AS val
        FROM tesoreria_movimientos
       WHERE cuenta_id = c.id AND tipo = 'traslado'
      UNION ALL
      SELECT monto AS val
        FROM tesoreria_movimientos
       WHERE cuenta_destino_id = c.id AND tipo = 'traslado'
    ) _saldo
  ), 0) + c.saldo_inicial
`;

// ── Cuentas ────────────────────────────────────────────────────────────────────

export const listarCuentas = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*,
             (${saldoActual}) AS saldo_actual
        FROM tesoreria_cuentas c
       WHERE c.is_active = true
       ORDER BY c.tipo, c.nombre
    `);
    res.json(rows);
  } catch (err) { next(err); }
};

export const getCuenta = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, (${saldoActual}) AS saldo_actual
        FROM tesoreria_cuentas c WHERE c.id = $1
    `, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Cuenta no encontrada' });
    res.json(rows[0]);
  } catch (err) { next(err); }
};

export const crearCuenta = async (req, res, next) => {
  try {
    const data = crearCuentaSchema.parse(req.body);
    const { rows } = await pool.query(`
      INSERT INTO tesoreria_cuentas (nombre, tipo, entidad, numero, saldo_inicial, moneda)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
    `, [data.nombre, data.tipo, data.entidad || null, data.numero || null, data.saldo_inicial, data.moneda]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
};

export const actualizarCuenta = async (req, res, next) => {
  try {
    const data = actualizarCuentaSchema.parse(req.body);
    const sets = [];
    const vals = [];
    let i = 1;
    if (data.nombre  !== undefined) { sets.push(`nombre = $${i++}`);  vals.push(data.nombre); }
    if (data.entidad !== undefined) { sets.push(`entidad = $${i++}`); vals.push(data.entidad || null); }
    if (data.numero  !== undefined) { sets.push(`numero = $${i++}`);  vals.push(data.numero || null); }
    if (!sets.length) return res.status(400).json({ error: 'Sin campos a actualizar' });
    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE tesoreria_cuentas SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'Cuenta no encontrada' });
    res.json(rows[0]);
  } catch (err) { next(err); }
};

export const desactivarCuenta = async (req, res, next) => {
  try {
    if (req.user?.rol !== 'admin') {
      return res.status(403).json({ error: 'Solo el administrador puede desactivar cuentas bancarias' });
    }
    desactivarCuentaSchema.parse(req.body);
    const { id } = req.params;

    const { rows: [cuenta] } = await pool.query(
      `SELECT id, nombre, is_active FROM tesoreria_cuentas WHERE id = $1`, [id]
    );
    if (!cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });
    if (!cuenta.is_active) return res.status(409).json({ error: 'La cuenta ya está inactiva' });

    const { rows: [{ total }] } = await pool.query(
      `SELECT COUNT(*) AS total FROM tesoreria_movimientos WHERE cuenta_id = $1 OR cuenta_destino_id = $1`,
      [id]
    );
    if (Number(total) > 0) {
      return res.status(409).json({
        error: `No es posible desactivar la cuenta "${cuenta.nombre}" porque tiene ${total} movimiento(s) registrado(s). Las cuentas con historial no pueden desactivarse.`,
        movimientos: Number(total),
      });
    }

    const { rows: [updated] } = await pool.query(
      `UPDATE tesoreria_cuentas SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    res.json(updated);
  } catch (err) { next(err); }
};

// ── Categorías ─────────────────────────────────────────────────────────────────

export const listarCategorias = async (req, res, next) => {
  try {
    const { tipo } = req.query;
    const where = tipo ? `WHERE tipo = $1 AND is_active = true` : `WHERE is_active = true`;
    const params = tipo ? [tipo] : [];
    const { rows } = await pool.query(
      `SELECT * FROM tesoreria_categorias ${where} ORDER BY tipo, nombre`, params
    );
    res.json(rows);
  } catch (err) { next(err); }
};

export const crearCategoria = async (req, res, next) => {
  try {
    const data = crearCategoriaSchema.parse(req.body);
    const { rows } = await pool.query(`
      INSERT INTO tesoreria_categorias (nombre, tipo, color) VALUES ($1, $2, $3) RETURNING *
    `, [data.nombre, data.tipo, data.color]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
};

export const actualizarCategoria = async (req, res, next) => {
  try {
    const data = actualizarCategoriaSchema.parse(req.body);
    const sets = [];
    const vals = [];
    let i = 1;
    if (data.nombre    !== undefined) { sets.push(`nombre = $${i++}`);    vals.push(data.nombre); }
    if (data.color     !== undefined) { sets.push(`color = $${i++}`);     vals.push(data.color); }
    if (data.is_active !== undefined) { sets.push(`is_active = $${i++}`); vals.push(data.is_active); }
    if (!sets.length) return res.status(400).json({ error: 'Sin campos a actualizar' });
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE tesoreria_categorias SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'Categoría no encontrada' });
    res.json(rows[0]);
  } catch (err) { next(err); }
};

// ── Períodos ───────────────────────────────────────────────────────────────────

export const listarPeriodos = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT p.*,
             u.nombre AS cerrado_por_nombre,
             (SELECT COUNT(*) FROM tesoreria_movimientos m WHERE m.periodo_id = p.id) AS total_movimientos
        FROM tesoreria_periodos p
        LEFT JOIN global_usuarios u ON u.id = p.cerrado_por
       ORDER BY p.fecha_inicio DESC
    `);
    res.json(rows);
  } catch (err) { next(err); }
};

export const crearPeriodo = async (req, res, next) => {
  try {
    const data = crearPeriodoSchema.parse(req.body);
    const { rows } = await pool.query(`
      INSERT INTO tesoreria_periodos (nombre, fecha_inicio, fecha_fin)
      VALUES ($1, $2, $3) RETURNING *
    `, [data.nombre, data.fecha_inicio, data.fecha_fin]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
};

export const cerrarPeriodo = async (req, res, next) => {
  try {
    const { rows: [periodo] } = await pool.query(
      `SELECT * FROM tesoreria_periodos WHERE id = $1`, [req.params.id]
    );
    if (!periodo) return res.status(404).json({ error: 'Período no encontrado' });
    if (periodo.estado === 'cerrado') return res.status(400).json({ error: 'El período ya está cerrado' });
    const { rows } = await pool.query(`
      UPDATE tesoreria_periodos
         SET estado = 'cerrado', cerrado_por = $1, cerrado_at = NOW()
       WHERE id = $2 RETURNING *
    `, [req.user.id, req.params.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
};

// ── Movimientos ────────────────────────────────────────────────────────────────

export const listarMovimientos = async (req, res, next) => {
  try {
    const { cuenta_id, periodo_id, tipo, categoria_id, desde, hasta, limit = 100, offset = 0 } = req.query;
    const conds = [];
    const vals  = [];
    let i = 1;
    if (cuenta_id)    { conds.push(`(m.cuenta_id = $${i} OR m.cuenta_destino_id = $${i})`); vals.push(cuenta_id); i++; }
    if (periodo_id)   { conds.push(`m.periodo_id = $${i++}`);   vals.push(periodo_id); }
    if (tipo)         { conds.push(`m.tipo = $${i++}`);          vals.push(tipo); }
    if (categoria_id) { conds.push(`m.categoria_id = $${i++}`);  vals.push(categoria_id); }
    if (desde)        { conds.push(`m.fecha >= $${i++}`);        vals.push(desde); }
    if (hasta)        { conds.push(`m.fecha <= $${i++}`);        vals.push(hasta); }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    vals.push(Number(limit), Number(offset));

    const { rows } = await pool.query(`
      SELECT m.*,
             c.nombre  AS cuenta_nombre,
             cd.nombre AS cuenta_destino_nombre,
             cat.nombre AS categoria_nombre,
             cat.color  AS categoria_color,
             p.nombre   AS periodo_nombre,
             u.nombre   AS registrado_por_nombre
        FROM tesoreria_movimientos m
        LEFT JOIN tesoreria_cuentas    c   ON c.id   = m.cuenta_id
        LEFT JOIN tesoreria_cuentas    cd  ON cd.id  = m.cuenta_destino_id
        LEFT JOIN tesoreria_categorias cat ON cat.id = m.categoria_id
        LEFT JOIN tesoreria_periodos   p   ON p.id   = m.periodo_id
        LEFT JOIN global_usuarios      u   ON u.id   = m.registrado_por
       ${where}
       ORDER BY m.fecha DESC, m.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}
    `, vals);

    const { rows: [{ total }] } = await pool.query(
      `SELECT COUNT(*) AS total FROM tesoreria_movimientos m ${where}`,
      vals.slice(0, -2)
    );

    res.json({ movimientos: rows, total: Number(total) });
  } catch (err) { next(err); }
};

export const exportarMovimientos = async (req, res, next) => {
  try {
    const { cuenta_id, periodo_id, tipo, categoria_id, desde, hasta } = req.query;
    const conds = [];
    const vals  = [];
    let i = 1;
    if (cuenta_id)    { conds.push(`(m.cuenta_id = $${i} OR m.cuenta_destino_id = $${i})`); vals.push(cuenta_id); i++; }
    if (periodo_id)   { conds.push(`m.periodo_id = $${i++}`);   vals.push(periodo_id); }
    if (tipo)         { conds.push(`m.tipo = $${i++}`);          vals.push(tipo); }
    if (categoria_id) { conds.push(`m.categoria_id = $${i++}`);  vals.push(categoria_id); }
    if (desde)        { conds.push(`m.fecha >= $${i++}`);        vals.push(desde); }
    if (hasta)        { conds.push(`m.fecha <= $${i++}`);        vals.push(hasta); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const { rows } = await pool.query(`
      SELECT m.fecha, m.tipo, m.monto, m.descripcion, m.referencia, m.tercero_nombre,
             c.nombre AS cuenta, cd.nombre AS cuenta_destino,
             cat.nombre AS categoria, p.nombre AS periodo,
             u.nombre AS registrado_por
        FROM tesoreria_movimientos m
        LEFT JOIN tesoreria_cuentas    c   ON c.id   = m.cuenta_id
        LEFT JOIN tesoreria_cuentas    cd  ON cd.id  = m.cuenta_destino_id
        LEFT JOIN tesoreria_categorias cat ON cat.id = m.categoria_id
        LEFT JOIN tesoreria_periodos   p   ON p.id   = m.periodo_id
        LEFT JOIN global_usuarios      u   ON u.id   = m.registrado_por
       ${where}
       ORDER BY m.fecha DESC, m.created_at DESC
    `, vals);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'Kernel — Tesorería';
    const ws = wb.addWorksheet('Movimientos');

    ws.columns = [
      { header: 'Fecha',          key: 'fecha',           width: 14 },
      { header: 'Tipo',           key: 'tipo',            width: 12 },
      { header: 'Monto (COP)',    key: 'monto',           width: 18 },
      { header: 'Tercero',        key: 'tercero_nombre',  width: 28 },
      { header: 'Descripción',    key: 'descripcion',     width: 35 },
      { header: 'Referencia',     key: 'referencia',      width: 20 },
      { header: 'Cuenta',         key: 'cuenta',          width: 22 },
      { header: 'Cuenta Destino', key: 'cuenta_destino',  width: 22 },
      { header: 'Categoría',      key: 'categoria',       width: 18 },
      { header: 'Período',        key: 'periodo',         width: 18 },
      { header: 'Registrado Por', key: 'registrado_por',  width: 22 },
    ];

    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F1B2E' } };
    ws.getRow(1).font = { bold: true, color: { argb: 'FF34D399' } };

    for (const r of rows) {
      ws.addRow({
        fecha:          r.fecha?.slice(0, 10) || '',
        tipo:           r.tipo,
        monto:          Number(r.monto),
        tercero_nombre: r.tercero_nombre || '',
        descripcion:    r.descripcion || '',
        referencia:     r.referencia || '',
        cuenta:         r.cuenta || '',
        cuenta_destino: r.cuenta_destino || '',
        categoria:      r.categoria || '',
        periodo:        r.periodo || '',
        registrado_por: r.registrado_por || '',
      });
    }

    const montoCol = ws.getColumn('monto');
    montoCol.numFmt = '#,##0';

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="movimientos_${new Date().toISOString().slice(0,10)}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
};

export const crearMovimiento = async (req, res, next) => {
  try {
    const data = crearMovimientoSchema.parse(req.body);

    // Verificar que el período esté abierto si se especificó
    if (data.periodo_id) {
      const { rows: [p] } = await pool.query(
        `SELECT estado FROM tesoreria_periodos WHERE id = $1`, [data.periodo_id]
      );
      if (!p) return res.status(400).json({ error: 'Período no encontrado' });
      if (p.estado === 'cerrado') return res.status(400).json({ error: 'El período está cerrado' });
    }

    const { rows } = await pool.query(`
      INSERT INTO tesoreria_movimientos
        (tipo, monto, fecha, descripcion, referencia, tercero_nombre, cuenta_id, cuenta_destino_id,
         categoria_id, periodo_id, registrado_por, corrige_movimiento_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [
      data.tipo, data.monto, data.fecha,
      data.descripcion || null, data.referencia || null,
      data.tercero_nombre || null,
      data.cuenta_id, data.cuenta_destino_id || null,
      data.categoria_id || null, data.periodo_id || null,
      req.user.id, data.corrige_movimiento_id || null,
    ]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
};

// ── Dashboard ──────────────────────────────────────────────────────────────────

const dashboardFacturas = async () => {
  // Estado + monto por estado
  const { rows: porEstado } = await pool.query(`
    SELECT estado,
           COUNT(*)::int                    AS cantidad,
           COALESCE(SUM(monto), 0)::numeric AS monto_total
      FROM tesoreria_facturas
     GROUP BY estado
  `);

  // Alertas: vencidas y urgentes (en cualquier estado previo a pagada)
  const { rows: [alertas] } = await pool.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE estado IN ('pendiente_aprobacion','aprobada','verificada')
          AND fecha_vencimiento < CURRENT_DATE
      )::int AS vencidas,
      COALESCE(SUM(monto) FILTER (
        WHERE estado IN ('pendiente_aprobacion','aprobada','verificada')
          AND fecha_vencimiento < CURRENT_DATE
      ), 0)::numeric AS monto_vencido,
      COUNT(*) FILTER (
        WHERE estado IN ('pendiente_aprobacion','aprobada','verificada')
          AND fecha_vencimiento >= CURRENT_DATE
          AND fecha_vencimiento <= CURRENT_DATE + INTERVAL '5 days'
      )::int AS urgentes,
      COALESCE(SUM(monto) FILTER (
        WHERE estado IN ('pendiente_aprobacion','aprobada','verificada')
      ), 0)::numeric AS monto_pendiente
    FROM tesoreria_facturas
  `);

  // Eficiencia: promedio de días por etapa + tasa de rechazo
  const { rows: [eficiencia] } = await pool.query(`
    SELECT
      ROUND(AVG(
        EXTRACT(DAY FROM (f.created_at - f.fecha_entrega_area::timestamptz))
      ) FILTER (WHERE f.fecha_entrega_area IS NOT NULL))::int   AS avg_dias_area_contable,
      ROUND(AVG(
        EXTRACT(DAY FROM (f.aprobado_at - f.created_at))
      ) FILTER (WHERE f.aprobado_at IS NOT NULL))::int           AS avg_dias_control_interno,
      ROUND(AVG(
        (mov.fecha - f.aprobado_at::date)
      ) FILTER (WHERE mov.fecha IS NOT NULL AND f.aprobado_at IS NOT NULL))::int AS avg_dias_tesoreria,
      COUNT(*) FILTER (WHERE f.estado = 'rechazada')::int       AS total_rechazadas,
      COUNT(*) FILTER (WHERE f.estado IN ('aprobada','pagada','rechazada'))::int AS total_procesadas
    FROM tesoreria_facturas f
    LEFT JOIN tesoreria_movimientos mov ON mov.id = f.movimiento_id
  `);

  // Top 5 proveedores por monto pagado (global, no filtrado por mes)
  const { rows: topProveedores } = await pool.query(`
    SELECT p.nombre, p.tipo_pago,
           COUNT(f.id)::int            AS total_facturas,
           COALESCE(SUM(f.monto), 0)  AS monto_total
      FROM tesoreria_facturas f
      JOIN tesoreria_proveedores p ON p.id = f.proveedor_id
     WHERE f.estado = 'pagada'
     GROUP BY p.id, p.nombre, p.tipo_pago
     ORDER BY monto_total DESC
     LIMIT 5
  `);

  // Monto pagado por mes — últimos 6 meses
  const { rows: tendencia } = await pool.query(`
    SELECT to_char(mov.fecha, 'YYYY-MM') AS mes,
           COUNT(f.id)::int              AS cantidad,
           COALESCE(SUM(f.monto), 0)    AS monto_total
      FROM tesoreria_facturas f
      JOIN tesoreria_movimientos mov ON mov.id = f.movimiento_id
     WHERE f.estado = 'pagada'
       AND mov.fecha >= date_trunc('month', CURRENT_DATE) - INTERVAL '5 months'
     GROUP BY mes
     ORDER BY mes
  `);

  // Monto comprometido por área (facturas activas)
  const { rows: porArea } = await pool.query(`
    SELECT area_responsable,
           COUNT(*)::int               AS cantidad,
           COALESCE(SUM(monto), 0)    AS monto_total
      FROM tesoreria_facturas
     WHERE estado IN ('pendiente_aprobacion','aprobada','verificada')
       AND area_responsable IS NOT NULL
     GROUP BY area_responsable
     ORDER BY monto_total DESC
  `);

  // Conciliación pendiente: facturas autorizadas sin movimiento + movimientos sin factura
  const { rows: [conciliacion] } = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int   FROM tesoreria_facturas     WHERE estado = 'autorizada' AND movimiento_id IS NULL)      AS facturas_pendientes,
      (SELECT COALESCE(SUM(monto - retencion_fuente - retencion_ica - retencion_iva), 0)
                               FROM tesoreria_facturas     WHERE estado = 'autorizada' AND movimiento_id IS NULL)      AS monto_facturas_pendientes,
      (SELECT COUNT(*)::int   FROM tesoreria_movimientos  WHERE tipo = 'egreso' AND factura_id IS NULL AND origen = 'extracto') AS movimientos_sin_vincular,
      (SELECT COALESCE(SUM(monto), 0)
                               FROM tesoreria_movimientos  WHERE tipo = 'egreso' AND factura_id IS NULL AND origen = 'extracto') AS monto_sin_vincular
  `);

  return { por_estado: porEstado, alertas, eficiencia, top_proveedores: topProveedores, tendencia, por_area: porArea, conciliacion };
};

export const dashboard = async (req, res, next) => {
  try {
    const hoy  = new Date();
    const mes  = req.query.mes || `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;

    const [
      { rows: cuentas },
      { rows: flujo },
      { rows: porCategoria },
      { rows: ultimosMovimientos },
      facturas,
    ] = await Promise.all([
      pool.query(`
        SELECT c.id, c.nombre, c.tipo, c.moneda,
               (${saldoActual}) AS saldo_actual
          FROM tesoreria_cuentas c
         WHERE c.is_active = true
         ORDER BY c.tipo, c.nombre
      `),
      pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END), 0) AS ingresos,
          COALESCE(SUM(CASE WHEN tipo = 'egreso'  THEN monto ELSE 0 END), 0) AS egresos
        FROM tesoreria_movimientos
        WHERE to_char(fecha, 'YYYY-MM') = $1
      `, [mes]),
      pool.query(`
        SELECT cat.nombre, cat.color, cat.tipo,
               COALESCE(SUM(m.monto), 0) AS total
          FROM tesoreria_movimientos m
          JOIN tesoreria_categorias cat ON cat.id = m.categoria_id
         WHERE to_char(m.fecha, 'YYYY-MM') = $1
           AND m.tipo IN ('ingreso', 'egreso')
         GROUP BY cat.id, cat.nombre, cat.color, cat.tipo
         ORDER BY total DESC
      `, [mes]),
      pool.query(`
        SELECT m.id, m.tipo, m.monto, m.fecha, m.descripcion,
               c.nombre AS cuenta_nombre,
               cat.nombre AS categoria_nombre, cat.color AS categoria_color
          FROM tesoreria_movimientos m
          LEFT JOIN tesoreria_cuentas c ON c.id = m.cuenta_id
          LEFT JOIN tesoreria_categorias cat ON cat.id = m.categoria_id
         ORDER BY m.fecha DESC, m.created_at DESC
         LIMIT 10
      `),
      dashboardFacturas(),
    ]);

    res.json({
      cuentas,
      flujo: flujo[0],
      por_categoria: porCategoria,
      ultimos_movimientos: ultimosMovimientos,
      facturas,
      mes,
    });
  } catch (err) { next(err); }
};

// ── Proveedores ────────────────────────────────────────────────────────────────

export const listarProveedores = async (req, res, next) => {
  try {
    const { tipo_pago, is_active = 'true' } = req.query;
    const conds = [`p.is_active = $1`];
    const vals  = [is_active === 'true'];
    let i = 2;
    if (tipo_pago) { conds.push(`p.tipo_pago = $${i++}`); vals.push(tipo_pago); }
    const { rows } = await pool.query(`
      SELECT p.*,
             COUNT(f.id) FILTER (WHERE f.estado = 'pendiente_aprobacion') AS facturas_pendientes,
             COUNT(f.id) FILTER (WHERE f.estado = 'aprobada')             AS facturas_aprobadas
        FROM tesoreria_proveedores p
        LEFT JOIN tesoreria_facturas f ON f.proveedor_id = p.id
       WHERE ${conds.join(' AND ')}
       GROUP BY p.id
       ORDER BY p.nombre
    `, vals);
    res.json(rows);
  } catch (err) { next(err); }
};

export const crearProveedor = async (req, res, next) => {
  try {
    const data = crearProveedorSchema.parse(req.body);
    const { rows } = await pool.query(`
      INSERT INTO tesoreria_proveedores
        (nombre, nit, email, telefono, tipo_pago, frecuencia, categoria, notas)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [
      data.nombre, data.nit || null, data.email || null, data.telefono || null,
      data.tipo_pago, data.frecuencia || null, data.categoria || null, data.notas || null,
    ]);
    await pool.query(
      `INSERT INTO tesoreria_proveedores_historial
         (proveedor_id, tipo_cambio, campos_despues, cambiado_por)
       VALUES ($1, 'creacion', $2, $3)`,
      [rows[0].id, JSON.stringify({
        nombre: rows[0].nombre, nit: rows[0].nit, email: rows[0].email,
        telefono: rows[0].telefono, tipo_pago: rows[0].tipo_pago,
        frecuencia: rows[0].frecuencia, categoria: rows[0].categoria, notas: rows[0].notas,
      }), req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
};

export const actualizarProveedor = async (req, res, next) => {
  try {
    const data = actualizarProveedorSchema.parse(req.body);
    const sets = [];
    const vals = [];
    let i = 1;
    const map = { nombre: 'nombre', nit: 'nit', email: 'email', telefono: 'telefono',
                  tipo_pago: 'tipo_pago', frecuencia: 'frecuencia', categoria: 'categoria',
                  notas: 'notas', is_active: 'is_active' };
    for (const [k, col] of Object.entries(map)) {
      if (data[k] !== undefined) {
        sets.push(`${col} = $${i++}`);
        vals.push(['nit','email','telefono','frecuencia','categoria','notas'].includes(k)
          ? (data[k] || null) : data[k]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Sin campos a actualizar' });

    const { rows: [antes] } = await pool.query(
      `SELECT nombre, nit, email, telefono, tipo_pago, frecuencia, categoria, notas, is_active
         FROM tesoreria_proveedores WHERE id = $1`,
      [req.params.id]
    );
    if (!antes) return res.status(404).json({ error: 'Proveedor no encontrado' });

    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE tesoreria_proveedores SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals
    );

    const camposCambiados = Object.keys(data).filter(k => map[k] !== undefined);
    const camposAntes  = Object.fromEntries(camposCambiados.map(k => [k, antes[k]]));
    const camposDespues = Object.fromEntries(camposCambiados.map(k => [k, rows[0][k]]));
    const tipoCambio = data.is_active === false ? 'desactivacion'
                     : !antes.is_active && data.is_active === true ? 'reactivacion'
                     : 'actualizacion';
    await pool.query(
      `INSERT INTO tesoreria_proveedores_historial
         (proveedor_id, tipo_cambio, campos_antes, campos_despues, cambiado_por)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, tipoCambio, JSON.stringify(camposAntes), JSON.stringify(camposDespues), req.user.id]
    );

    res.json(rows[0]);
  } catch (err) { next(err); }
};

export const historialProveedor = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      `SELECT h.*, u.nombre AS cambiado_por_nombre
         FROM tesoreria_proveedores_historial h
         LEFT JOIN global_usuarios u ON u.id = h.cambiado_por
        WHERE h.proveedor_id = $1
        ORDER BY h.cambiado_at DESC`,
      [id]
    );
    res.json(rows);
  } catch (err) { next(err); }
};

export const perfilProveedor = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: [p] } = await pool.query(
      `SELECT * FROM tesoreria_proveedores WHERE id = $1`, [id]
    );
    if (!p) return res.status(404).json({ error: 'Proveedor no encontrado' });

    const { rows: facturas } = await pool.query(`
      SELECT f.id, f.numero_factura, f.monto, f.monto_neto,
             f.retencion_fuente, f.retencion_ica, f.retencion_iva,
             f.estado, f.fecha_recibida, f.fecha_vencimiento, f.fecha_pago,
             f.descripcion, f.area_responsable, f.rechazo_motivo, f.created_at,
             f.aprobado_at, f.aprobado_por,
             ur.nombre AS registrado_por_nombre,
             CASE WHEN f.fecha_vencimiento < CURRENT_DATE THEN true ELSE false END AS vencida
        FROM tesoreria_facturas f
        LEFT JOIN global_usuarios ur ON ur.id = f.registrado_por
       WHERE f.proveedor_id = $1
       ORDER BY f.created_at DESC
    `, [id]);

    const ACTIVOS = ['pendiente_aprobacion', 'aprobada', 'verificada', 'autorizada'];
    const stats = {
      total_facturas:  facturas.length,
      total_pagado:    facturas.filter(f => f.estado === 'pagada')
                               .reduce((s, f) => s + Number(f.monto_neto ?? f.monto), 0),
      total_en_curso:  facturas.filter(f => ACTIVOS.includes(f.estado))
                               .reduce((s, f) => s + Number(f.monto), 0),
      por_estado: facturas.reduce((acc, f) => {
        acc[f.estado] = (acc[f.estado] || 0) + 1; return acc;
      }, {}),
    };

    res.json({ proveedor: p, stats, facturas });
  } catch (err) { next(err); }
};

// ── Facturas ───────────────────────────────────────────────────────────────────

const facturaBase = `
  SELECT f.*,
         p.nombre     AS proveedor_nombre,
         p.nit        AS proveedor_nit,
         p.tipo_pago  AS proveedor_tipo,
         p.frecuencia AS proveedor_frecuencia,
         p.categoria  AS proveedor_categoria,
         c.nombre     AS cuenta_pago_nombre,
         u.nombre     AS registrado_por_nombre,
         ur.nombre    AS responsable_nombre,
         ua.nombre    AS aprobado_por_nombre,
         uv.nombre    AS verificada_por_nombre,
         mov.fecha      AS fecha_movimiento,
         mov.referencia AS pago_referencia,
         CASE WHEN f.fecha_entrega_area IS NOT NULL
              THEN EXTRACT(DAY FROM (f.created_at - f.fecha_entrega_area::timestamptz))::int
         END AS dias_area_contable,
         CASE WHEN f.verificada_at IS NOT NULL
              THEN EXTRACT(DAY FROM (f.verificada_at - f.created_at))::int
         END AS dias_control_interno,
         CASE WHEN f.verificada_at IS NOT NULL AND mov.fecha IS NOT NULL
              THEN (mov.fecha - f.verificada_at::date)::int
         END AS dias_tesoreria,
         (SELECT row_to_json(a) FROM archivos a
          WHERE a.entidad_tipo = 'factura' AND a.entidad_id = f.id
          ORDER BY a.created_at DESC LIMIT 1) AS adjunto
    FROM tesoreria_facturas f
    JOIN tesoreria_proveedores p    ON p.id   = f.proveedor_id
    LEFT JOIN tesoreria_cuentas c   ON c.id   = f.cuenta_pago_id
    LEFT JOIN global_usuarios u     ON u.id   = f.registrado_por
    LEFT JOIN global_usuarios ur    ON ur.id  = f.responsable_id
    LEFT JOIN global_usuarios ua    ON ua.id  = f.aprobado_por
    LEFT JOIN global_usuarios uv    ON uv.id  = f.verificada_por
    LEFT JOIN tesoreria_movimientos mov ON mov.id = f.movimiento_id
`;

export const listarFacturas = async (req, res, next) => {
  try {
    const { estado, proveedor_id, desde, hasta, vence_antes } = req.query;
    const conds = [];
    const vals  = [];
    let i = 1;
    if (estado)       { conds.push(`f.estado = $${i++}`);                vals.push(estado); }
    if (proveedor_id) { conds.push(`f.proveedor_id = $${i++}`);          vals.push(proveedor_id); }
    if (desde)        { conds.push(`f.fecha_recibida >= $${i++}`);        vals.push(desde); }
    if (hasta)        { conds.push(`f.fecha_recibida <= $${i++}`);        vals.push(hasta); }
    if (vence_antes)  { conds.push(`f.fecha_vencimiento <= $${i++}`);    vals.push(vence_antes); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await pool.query(`${facturaBase} ${where} ORDER BY f.fecha_vencimiento ASC`, vals);
    res.json(rows);
  } catch (err) { next(err); }
};

export const getFactura = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`${facturaBase} WHERE f.id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Factura no encontrada' });
    res.json(rows[0]);
  } catch (err) { next(err); }
};

export const crearFactura = async (req, res, next) => {
  try {
    const data = crearFacturaSchema.parse(req.body);

    const { rows: [umbral] } = await pool.query(
      `SELECT monto_umbral FROM tesoreria_config_umbrales WHERE tipo_operacion = 'egreso_proveedor' LIMIT 1`
    );
    // A-1: Boolean() evita que requiereGerencia sea undefined/null cuando no hay umbral,
    // lo que enviaría NULL a una columna NOT NULL o haría que la factura evite Gerencia en silencio.
    const requiereGerencia = Boolean(umbral && data.monto > Number(umbral.monto_umbral));

    const { rows } = await pool.query(`
      INSERT INTO tesoreria_facturas
        (proveedor_id, monto, fecha_emision, fecha_recibida, fecha_vencimiento,
         area_responsable, responsable_id, fecha_entrega_area, descripcion, numero_factura,
         cuenta_pago_id, registrado_por, requiere_aprobacion_gerencia,
         retencion_fuente, retencion_ica, retencion_iva)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *
    `, [
      data.proveedor_id, data.monto,
      data.fecha_emision      || null,
      data.fecha_recibida,
      data.fecha_vencimiento,
      data.area_responsable   || null,
      data.responsable_id     || null,
      data.fecha_entrega_area || null,
      data.descripcion        || null,
      data.numero_factura     || null,
      data.cuenta_pago_id     || null,
      req.user.id,
      requiereGerencia,
      data.retencion_fuente,
      data.retencion_ica,
      data.retencion_iva,
    ]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
};

/**
 * PUT /facturas/:id/aprobar-area
 * El responsable asignado aprueba la factura: pendiente_aprobacion → aprobada.
 */
export const aprobarArea = async (req, res, next) => {
  try {
    aprobarAreaSchema.parse(req.body);
    const { rows: [factura] } = await pool.query(
      `SELECT id, estado, responsable_id, registrado_por FROM tesoreria_facturas WHERE id = $1`,
      [req.params.id]
    );
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
    if (factura.estado !== 'pendiente_aprobacion')
      return res.status(400).json({ error: `Estado actual: ${factura.estado}` });
    // C-1: quien registró la factura no puede aprobarla en su propia área
    if (req.user.rol !== 'admin' && factura.registrado_por === req.user.id)
      return res.status(403).json({ error: 'No puede aprobar una factura que usted mismo registró' });
    if (factura.responsable_id && factura.responsable_id !== req.user.id)
      return res.status(403).json({ error: 'Solo el responsable asignado puede aprobar esta factura' });

    const { rows: [updated] } = await pool.query(`
      UPDATE tesoreria_facturas
         SET estado     = 'aprobada',
             aprobado_por = $1,
             aprobado_at  = NOW(),
             updated_at   = NOW()
       WHERE id = $2
      RETURNING *
    `, [req.user.id, req.params.id]);
    res.json(updated);
  } catch (err) { next(err); }
};

/**
 * PUT /facturas/:id/autorizar
 * Tesorería autoriza el pago. La factura debe estar verificada (CI).
 * El vínculo con la transacción bancaria ocurre al confirmar el extracto XLS.
 */
export const autorizarPago = async (req, res, next) => {
  try {
    autorizarPagoSchema.parse(req.body);
    const { rows: [factura] } = await pool.query(
      `SELECT f.* FROM tesoreria_facturas f WHERE f.id = $1`,
      [req.params.id]
    );
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
    if (factura.estado !== 'verificada')
      return res.status(400).json({ error: 'La factura debe estar verificada por Control Interno para autorizar el pago' });
    if (factura.requiere_aprobacion_gerencia && !factura.aprobado_gerencia_at)
      return res.status(400).json({ error: 'Esta factura requiere aprobación de Gerencia antes de autorizar el pago' });
    if (factura.aprobacion_vence_at && new Date(factura.aprobacion_vence_at) < new Date())
      return res.status(400).json({ error: 'La verificación de Control Interno ha vencido — debe ser re-verificada' });
    // C-1: quien registró o aprobó en área no puede autorizar el pago
    if (req.user.rol !== 'admin' && [factura.registrado_por, factura.aprobado_por].includes(req.user.id))
      return res.status(403).json({ error: 'No puede autorizar el pago de una factura en la que ya participó' });

    // A-3: registrar quién autorizó para que anomalyDetector pueda detectar
    // que la misma persona ejecutó varias etapas del flujo.
    const { rows: [updated] } = await pool.query(`
      UPDATE tesoreria_facturas
         SET estado         = 'autorizada',
             autorizada_por = $2,
             autorizada_at  = NOW(),
             updated_at     = NOW()
       WHERE id = $1
      RETURNING *
    `, [req.params.id, req.user.id]);

    res.json(updated);
  } catch (err) { next(err); }
};

// ── Contable — reenvío tras rechazo ───────────────────────────────────────────

export const reenviarFactura = async (req, res, next) => {
  try {
    const { rows: [f] } = await pool.query(
      `SELECT estado, monto FROM tesoreria_facturas WHERE id = $1`, [req.params.id]
    );
    if (!f) return res.status(404).json({ error: 'Factura no encontrada' });
    if (f.estado !== 'rechazada') return res.status(400).json({ error: 'Solo se pueden reenviar facturas en estado rechazada' });

    const { rows: [umbral] } = await pool.query(
      `SELECT monto_umbral FROM tesoreria_config_umbrales WHERE tipo_operacion = 'egreso_proveedor' LIMIT 1`
    );
    const requiereGerencia = Boolean(umbral && Number(f.monto) > Number(umbral.monto_umbral));

    const { rows } = await pool.query(`
      UPDATE tesoreria_facturas
         SET estado                      = 'pendiente_aprobacion',
             rechazo_motivo              = NULL,
             aprobado_por                = NULL,
             aprobado_at                 = NULL,
             aprobacion_vence_at         = NULL,
             aprobado_gerencia_por       = NULL,
             aprobado_gerencia_at        = NULL,
             verificada_por              = NULL,
             verificada_at               = NULL,
             requiere_aprobacion_gerencia = $1,
             updated_at                  = NOW()
       WHERE id = $2
       RETURNING *
    `, [requiereGerencia, req.params.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
};

// ── Control Interno — verificación ────────────────────────────────────────────

export const aprobarFactura = async (req, res, next) => {
  try {
    const { rows: [f] } = await pool.query(
      `SELECT estado, registrado_por, aprobado_por FROM tesoreria_facturas WHERE id = $1`, [req.params.id]
    );
    if (!f) return res.status(404).json({ error: 'Factura no encontrada' });
    if (f.estado !== 'aprobada') return res.status(400).json({ error: `Estado actual: ${f.estado}` });
    // C-1: CI no puede verificar una factura que registró o aprobó en área
    if (req.user.rol !== 'admin' && [f.registrado_por, f.aprobado_por].includes(req.user.id))
      return res.status(403).json({ error: 'No puede verificar una factura en la que ya participó' });

    const { rows: [umbral] } = await pool.query(
      `SELECT dias_vencimiento FROM tesoreria_config_umbrales WHERE tipo_operacion = 'egreso_proveedor' LIMIT 1`
    );
    const dias = umbral?.dias_vencimiento ?? 7;

    const { rows } = await pool.query(`
      UPDATE tesoreria_facturas
         SET estado = 'verificada',
             verificada_por = $1, verificada_at = NOW(),
             aprobacion_vence_at = NOW() + ($2 || ' days')::interval,
             updated_at = NOW()
       WHERE id = $3 RETURNING *
    `, [req.user.id, dias, req.params.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
};

export const aprobarGerencia = async (req, res, next) => {
  try {
    const { rows: [f] } = await pool.query(
      `SELECT estado, requiere_aprobacion_gerencia, aprobado_gerencia_at, registrado_por, aprobado_por, verificada_por FROM tesoreria_facturas WHERE id = $1`,
      [req.params.id]
    );
    if (!f) return res.status(404).json({ error: 'Factura no encontrada' });
    if (!f.requiere_aprobacion_gerencia) return res.status(400).json({ error: 'Esta factura no requiere aprobación de Gerencia' });
    if (f.aprobado_gerencia_at) return res.status(400).json({ error: 'Ya fue aprobada por Gerencia' });
    if (f.estado !== 'verificada') return res.status(400).json({ error: 'La factura debe estar verificada por Control Interno primero' });
    // C-1: quien participó en etapas anteriores no puede aprobar en Gerencia
    if (req.user.rol !== 'admin' && [f.registrado_por, f.aprobado_por, f.verificada_por].includes(req.user.id))
      return res.status(403).json({ error: 'No puede aprobar en Gerencia una factura en la que ya participó' });
    const { rows } = await pool.query(`
      UPDATE tesoreria_facturas
         SET aprobado_gerencia_por = $1, aprobado_gerencia_at = NOW(), updated_at = NOW()
       WHERE id = $2 RETURNING *
    `, [req.user.id, req.params.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
};

export const rechazarGerencia = async (req, res, next) => {
  try {
    const { motivo } = req.body;
    if (!motivo?.trim()) return res.status(400).json({ error: 'El motivo de devolución es obligatorio' });
    const { rows: [f] } = await pool.query(
      `SELECT estado, requiere_aprobacion_gerencia FROM tesoreria_facturas WHERE id = $1`,
      [req.params.id]
    );
    if (!f) return res.status(404).json({ error: 'Factura no encontrada' });
    if (!f.requiere_aprobacion_gerencia) return res.status(400).json({ error: 'Esta factura no requiere aprobación de Gerencia' });
    if (f.estado !== 'verificada') return res.status(400).json({ error: 'La factura debe estar verificada por CI para ser devuelta por Gerencia' });
    // Devuelve a la cola de CI para re-verificación con la observación de Gerencia
    const { rows } = await pool.query(`
      UPDATE tesoreria_facturas
         SET estado              = 'aprobada',
             rechazo_motivo      = $1,
             verificada_por      = NULL,
             verificada_at       = NULL,
             aprobacion_vence_at = NULL,
             updated_at          = NOW()
       WHERE id = $2 RETURNING *
    `, [motivo.trim(), req.params.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
};

export const rechazarFactura = async (req, res, next) => {
  try {
    const { motivo } = rechazarFacturaSchema.parse(req.body);
    const { rows: [f] } = await pool.query(
      `SELECT estado FROM tesoreria_facturas WHERE id = $1`, [req.params.id]
    );
    if (!f) return res.status(404).json({ error: 'Factura no encontrada' });
    // CI puede rechazar desde 'aprobada' (área aprobó, pero CI observa problema)
    if (f.estado !== 'aprobada') return res.status(400).json({ error: `Estado actual: ${f.estado}` });
    const { rows } = await pool.query(`
      UPDATE tesoreria_facturas
         SET estado = 'rechazada', rechazo_motivo = $1, verificada_por = $2, verificada_at = NOW(), updated_at = NOW()
       WHERE id = $3 RETURNING *
    `, [motivo, req.user.id, req.params.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
};

// ── Usuarios disponibles (selector de responsable) ────────────────────────────

export const listarUsuariosDisponibles = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, nombre, rol FROM global_usuarios
       WHERE is_active = true AND is_approved = true
       ORDER BY nombre
    `);
    res.json(rows);
  } catch (err) { next(err); }
};

// ── Mis facturas pendientes de aprobación ──────────────────────────────────────

export const misFacturasPendientes = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      ${facturaBase}
       WHERE f.responsable_id = $1
         AND f.estado = 'pendiente_aprobacion'
       ORDER BY f.fecha_vencimiento ASC
    `, [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
};

// ── Umbrales de aprobación ─────────────────────────────────────────────────────

export const listarUmbrales = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM tesoreria_config_umbrales ORDER BY tipo_operacion`);
    res.json(rows);
  } catch (err) { next(err); }
};

export const crearUmbral = async (req, res, next) => {
  try {
    const data = crearUmbralSchema.parse(req.body);
    const { rows } = await pool.query(`
      INSERT INTO tesoreria_config_umbrales (tipo_operacion, monto_umbral, descripcion, dias_vencimiento)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [data.tipo_operacion, data.monto_umbral, data.descripcion || null, data.dias_vencimiento]);
    const nuevo = rows[0];
    // A-2: registrar creación en historial
    await pool.query(`
      INSERT INTO tesoreria_config_umbrales_historial
        (umbral_id, operacion, campos_antes, campos_despues, cambiado_por)
      VALUES ($1, 'crear', NULL, $2, $3)
    `, [nuevo.id, JSON.stringify(nuevo), req.user.id]);
    res.status(201).json(nuevo);
  } catch (err) { next(err); }
};

export const actualizarUmbral = async (req, res, next) => {
  try {
    const data = actualizarUmbralSchema.parse(req.body);
    const sets = [];
    const vals = [];
    let i = 1;
    if (data.monto_umbral     !== undefined) { sets.push(`monto_umbral = $${i++}`);     vals.push(data.monto_umbral); }
    if (data.descripcion      !== undefined) { sets.push(`descripcion = $${i++}`);      vals.push(data.descripcion || null); }
    if (data.dias_vencimiento !== undefined) { sets.push(`dias_vencimiento = $${i++}`); vals.push(data.dias_vencimiento); }
    if (!sets.length) return res.status(400).json({ error: 'Sin campos a actualizar' });

    // A-2: leer estado anterior antes de modificar
    const { rows: [anterior] } = await pool.query(
      `SELECT * FROM tesoreria_config_umbrales WHERE id = $1`, [req.params.id]
    );
    if (!anterior) return res.status(404).json({ error: 'Umbral no encontrado' });

    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE tesoreria_config_umbrales SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals
    );
    const nuevo = rows[0];
    // A-2: registrar cambio en historial
    await pool.query(`
      INSERT INTO tesoreria_config_umbrales_historial
        (umbral_id, operacion, campos_antes, campos_despues, cambiado_por)
      VALUES ($1, 'actualizar', $2, $3, $4)
    `, [nuevo.id, JSON.stringify(anterior), JSON.stringify(nuevo), req.user.id]);
    res.json(nuevo);
  } catch (err) { next(err); }
};

// ── Ingesta de extracto bancario ───────────────────────────────────────────────

/**
 * GET /tesoreria/coincidencias
 * Cruza movimientos de egreso sin factura_id contra facturas pendientes de pago.
 * Devuelve pares {factura, movimiento} listos para que la tesorera confirme el vínculo.
 */
export const buscarCoincidencias = async (req, res, next) => {
  try {
    const { rows: facturas } = await pool.query(`
      SELECT f.id, f.numero_factura, f.fecha_vencimiento, f.estado,
             (f.monto - f.retencion_fuente - f.retencion_ica - f.retencion_iva) AS monto_neto,
             p.nombre AS proveedor_nombre
        FROM tesoreria_facturas f
        JOIN tesoreria_proveedores p ON p.id = f.proveedor_id
       WHERE f.estado IN ('aprobada', 'verificada', 'autorizada')
         AND f.movimiento_id IS NULL
       ORDER BY f.fecha_vencimiento
    `);

    const { rows: movimientos } = await pool.query(`
      SELECT m.id, m.monto, m.fecha, m.descripcion, m.referencia_bancaria,
             c.nombre AS cuenta_nombre
        FROM tesoreria_movimientos m
        JOIN tesoreria_cuentas c ON c.id = m.cuenta_id
       WHERE m.tipo = 'egreso'
         AND m.factura_id IS NULL
         AND m.origen = 'extracto'
       ORDER BY m.fecha DESC
    `);

    const coincidencias = [];
    const usados = new Set();

    for (const f of facturas) {
      const match = movimientos.find(m => {
        if (usados.has(m.id)) return false;
        const montoOk = Math.abs(Number(m.monto) - Number(f.monto_neto)) < 1;
        const diasDif = Math.abs((new Date(m.fecha) - new Date(f.fecha_vencimiento)) / 86400000);
        return montoOk && diasDif <= 30;
      });
      if (match) {
        usados.add(match.id);
        coincidencias.push({ factura: f, movimiento: match });
      }
    }

    res.json({ coincidencias, total: coincidencias.length });
  } catch (err) { next(err); }
};

/**
 * POST /tesoreria/conciliar
 * Confirma vínculos manuales entre movimientos ya importados y facturas pendientes.
 * Marca la factura como pagada y asigna factura_id al movimiento.
 */
// C-2: cada vínculo se procesa en su propia transacción con FOR UPDATE para
// evitar que dos requests concurrentes vinculen el mismo movimiento o factura.
// Solo se acepta estado 'autorizada' (flujo completo) y se valida que el monto cuadre.
export const conciliarManual = async (req, res, next) => {
  let data;
  try {
    data = conciliarSchema.parse(req.body);
  } catch (err) {
    return next(err);
  }
  const resultados = [];

  for (const { factura_id, movimiento_id } of data.vinculos) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [mov] } = await client.query(
        `SELECT id, fecha, monto, tipo FROM tesoreria_movimientos WHERE id = $1 AND factura_id IS NULL FOR UPDATE`,
        [movimiento_id]
      );
      if (!mov) {
        await client.query('ROLLBACK');
        resultados.push({ factura_id, movimiento_id, ok: false, error: 'Movimiento no encontrado o ya vinculado' });
        continue;
      }
      if (mov.tipo !== 'egreso') {
        await client.query('ROLLBACK');
        resultados.push({ factura_id, movimiento_id, ok: false, error: 'Solo movimientos de tipo egreso pueden vincularse a una factura' });
        continue;
      }

      const { rows: [factura] } = await client.query(
        `SELECT id, estado, monto_neto, movimiento_id FROM tesoreria_facturas WHERE id = $1 FOR UPDATE`,
        [factura_id]
      );
      if (!factura || factura.estado !== 'autorizada' || factura.movimiento_id !== null) {
        await client.query('ROLLBACK');
        resultados.push({ factura_id, movimiento_id, ok: false, error: 'Factura no encontrada, no está autorizada, o ya tiene movimiento asignado' });
        continue;
      }

      const montoDif = Math.abs(Number(mov.monto) - Number(factura.monto_neto));
      if (montoDif > 1) {
        await client.query('ROLLBACK');
        resultados.push({ factura_id, movimiento_id, ok: false, error: `Diferencia de monto: movimiento $${Number(mov.monto).toFixed(2)} vs factura neta $${Number(factura.monto_neto).toFixed(2)}` });
        continue;
      }

      await client.query(
        `UPDATE tesoreria_facturas
            SET estado = 'pagada', movimiento_id = $1, fecha_pago = $2,
                pagada_por = $3, pagada_at = NOW(), updated_at = NOW()
          WHERE id = $4`,
        [movimiento_id, mov.fecha, req.user.id, factura_id]
      );
      await client.query(
        `UPDATE tesoreria_movimientos SET factura_id = $1 WHERE id = $2`,
        [factura_id, movimiento_id]
      );

      await client.query('COMMIT');
      resultados.push({ factura_id, movimiento_id, ok: true });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      resultados.push({ factura_id, movimiento_id, ok: false, error: err.message });
    } finally {
      client.release();
    }
  }

  const exitosos = resultados.filter(r => r.ok).length;
  res.json({ resultados, exitosos, total: resultados.length });
};

/**
 * POST /api/tesoreria/extracto/preview
 * Recibe el XLS de Bancolombia (multipart), lo parsea y devuelve el preview
 * marcando cada transacción como 'nuevo' o 'ya_registrado'.
 */
export const previewExtracto = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
    const { cuenta_id } = req.query;
    if (!cuenta_id) return res.status(400).json({ error: 'cuenta_id es requerido' });

    const { rows: [cuenta] } = await pool.query(
      `SELECT id, nombre FROM tesoreria_cuentas WHERE id = $1 AND is_active = true`,
      [cuenta_id]
    );
    if (!cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });

    const raw = iconv.decode(req.file.buffer, 'latin1');
    const { transacciones, saldos } = parseBancolombiaPwxl(raw);

    if (!transacciones.length) {
      return res.status(422).json({ error: 'El archivo no contiene transacciones válidas' });
    }

    // Buscar duplicados usando la clave compuesta (referencia + fecha + monto)
    // porque el banco puede reutilizar el mismo código de referencia en distintas
    // operaciones con diferente fecha o monto.
    const referencias = transacciones.map(t => t.referencia_bancaria).filter(Boolean);

    let yaRegistradas = new Set();
    if (referencias.length) {
      const { rows } = await pool.query(
        `SELECT referencia_bancaria || '|' || fecha::text || '|' || monto::text AS clave
           FROM tesoreria_movimientos
          WHERE cuenta_id = $1 AND referencia_bancaria = ANY($2)`,
        [cuenta_id, referencias]
      );
      yaRegistradas = new Set(rows.map(r => r.clave));
    }

    // PostgreSQL retorna NUMERIC(14,2) como '126000.00'; el parser devuelve 126000 (JS number).
    // Normalizamos a 2 decimales en ambos lados para que las claves coincidan.
    const claveDedup = (t) => `${t.referencia_bancaria}|${t.fecha}|${Number(t.monto).toFixed(2)}`;

    // Buscar facturas pendientes de pago (aprobada o autorizada) para sugerir vinculación.
    // No filtramos por cuenta porque el vínculo cuenta↔factura se cierra al confirmar el extracto.
    const { rows: facturasPendientes } = await pool.query(`
      SELECT f.id,
             f.fecha_vencimiento,
             f.numero_factura,
             (f.monto - f.retencion_fuente - f.retencion_ica - f.retencion_iva) AS monto_neto,
             p.nombre AS proveedor_nombre
        FROM tesoreria_facturas f
        JOIN tesoreria_proveedores p ON p.id = f.proveedor_id
       WHERE f.estado IN ('aprobada', 'verificada', 'autorizada')
    `);

    const preview = transacciones.map(t => {
      const yaReg = yaRegistradas.has(claveDedup(t));
      let sugerencia_factura = null;

      if (!yaReg && t.tipo_movimiento === 'egreso' && facturasPendientes.length) {
        const match = facturasPendientes.find(f => {
          const montoOk = Math.abs(Number(f.monto_neto) - t.monto) < 1;
          // La transacción debería ocurrir cerca de la fecha de vencimiento (±30 días)
          const diasDif = (new Date(t.fecha) - new Date(f.fecha_vencimiento)) / 86400000;
          return montoOk && diasDif >= -30 && diasDif <= 30;
        });
        if (match) {
          sugerencia_factura = {
            id:               match.id,
            proveedor_nombre: match.proveedor_nombre,
            monto_neto:       Number(match.monto_neto),
            numero_factura:   match.numero_factura,
            fecha_vencimiento: match.fecha_vencimiento,
          };
        }
      }

      return { ...t, estado: yaReg ? 'ya_registrado' : 'nuevo', sugerencia_factura };
    });

    const nuevas      = preview.filter(t => t.estado === 'nuevo').length;
    const duplicadas  = preview.filter(t => t.estado === 'ya_registrado').length;

    res.json({
      cuenta: { id: cuenta.id, nombre: cuenta.nombre },
      resumen: { total: preview.length, nuevas, duplicadas },
      saldos,
      transacciones: preview,
    });
  } catch (err) { next(err); }
};

/**
 * POST /api/tesoreria/extracto/confirmar
 * Importa las transacciones seleccionadas por la tesorera.
 * Procesa una por una para que un duplicado no aborte el lote completo.
 */
// C-4: múltiples correcciones:
// - JSON.parse protegido (SyntaxError → 400)
// - Selección por clave compuesta (ref|fecha|monto) en lugar de solo referencia
// - Validación de monto: el movimiento debe cuadrar con monto_neto de la factura
// - Verificación de rowCount al marcar factura pagada (inconsistencia silenciosa)
// - fecha_desde/hasta derivadas con fallback a NOW() para cumplir NOT NULL
export const confirmarExtracto = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

    let referencias, vinculos;
    try {
      referencias = JSON.parse(req.body.referencias || '[]');
      vinculos    = JSON.parse(req.body.vinculos    || '[]');
    } catch {
      return res.status(400).json({ error: 'referencias o vinculos no son JSON válido' });
    }

    const body = { ...req.body, referencias, vinculos };
    const data = confirmarExtractoSchema.parse(body);

    const { rows: [cuenta] } = await pool.query(
      `SELECT id FROM tesoreria_cuentas WHERE id = $1 AND is_active = true`,
      [data.cuenta_id]
    );
    if (!cuenta) return res.status(404).json({ error: 'Cuenta no encontrada' });

    const raw = iconv.decode(req.file.buffer, 'latin1');
    const { transacciones } = parseBancolombiaPwxl(raw);

    // Selección por clave compuesta para no importar dos transacciones con la
    // misma referencia pero distinto monto o fecha (el banco reutiliza referencias).
    const claveDedup = (t) => `${t.referencia_bancaria}|${t.fecha}|${Number(t.monto).toFixed(2)}`;
    const clavesSeleccionadas = new Set(data.referencias);
    const seleccionadas = transacciones.filter(
      t => t.referencia_bancaria && clavesSeleccionadas.has(claveDedup(t))
    );

    if (!seleccionadas.length) {
      return res.status(400).json({ error: 'Ninguna de las transacciones seleccionadas se encontró en el archivo' });
    }

    // Mapa clave_compuesta → factura_id para aplicar vínculos
    const vinculoMap = Object.fromEntries(
      data.vinculos.map(v => {
        const clave = `${v.referencia_bancaria}|${v.fecha}|${Number(v.monto).toFixed(2)}`;
        return [clave, v.factura_id];
      })
    );

    const importadas = [];
    const omitidas   = [];

    for (const tx of seleccionadas) {
      const clave = claveDedup(tx);
      try {
        const factura_id = vinculoMap[clave] || null;

        // Si hay vínculo, validar que el monto cuadre antes de insertar el movimiento
        if (factura_id) {
          const { rows: [fac] } = await pool.query(
            `SELECT monto_neto, estado FROM tesoreria_facturas WHERE id = $1`,
            [factura_id]
          );
          if (!fac || fac.estado !== 'autorizada') {
            omitidas.push({ referencia: tx.referencia_bancaria, razon: 'Factura no encontrada o no está autorizada' });
            continue;
          }
          if (Math.abs(Number(tx.monto) - Number(fac.monto_neto)) > 1) {
            omitidas.push({ referencia: tx.referencia_bancaria, razon: `Diferencia de monto: transacción $${tx.monto} vs factura neta $${Number(fac.monto_neto).toFixed(2)}` });
            continue;
          }
        }

        const { rows: [mov] } = await pool.query(`
          INSERT INTO tesoreria_movimientos
            (tipo, monto, fecha, descripcion, referencia_bancaria,
             tipo_bancario, oficina_bancaria, detalles_banco,
             cuenta_id, categoria_id, periodo_id, registrado_por, origen)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'extracto')
          RETURNING id
        `, [
          tx.tipo_movimiento,
          tx.monto,
          tx.fecha,
          tx.descripcion,
          tx.referencia_bancaria,
          tx.tipo_bancario    || null,
          tx.oficina_bancaria || null,
          tx.detalles_banco   || null,
          data.cuenta_id,
          data.categoria_id   || null,
          data.periodo_id     || null,
          req.user.id,
        ]);

        if (factura_id) {
          const { rowCount } = await pool.query(`
            UPDATE tesoreria_facturas
               SET estado        = 'pagada',
                   movimiento_id = $1,
                   fecha_pago    = $2,
                   pagada_por    = $3,
                   pagada_at     = NOW(),
                   updated_at    = NOW()
             WHERE id = $4 AND estado = 'autorizada' AND movimiento_id IS NULL
          `, [mov.id, tx.fecha, req.user.id, factura_id]);

          if (rowCount > 0) {
            await pool.query(
              `UPDATE tesoreria_movimientos SET factura_id = $1 WHERE id = $2`,
              [factura_id, mov.id]
            );
          }
        }

        importadas.push({ referencia: tx.referencia_bancaria, movimiento_id: mov.id, factura_id });
      } catch (err) {
        if (err.code === '23505') {
          omitidas.push({ referencia: tx.referencia_bancaria, razon: 'ya registrada' });
        } else {
          omitidas.push({ referencia: tx.referencia_bancaria, razon: 'Error al importar transacción' });
        }
      }
    }

    // Guardar log — fecha_desde/hasta con fallback a NOW() para cumplir NOT NULL
    const fechasValidas = seleccionadas.map(t => t.fecha).filter(Boolean).sort();
    const fechaDesde = fechasValidas[0]                 || new Date().toISOString().slice(0, 10);
    const fechaHasta = fechasValidas[fechasValidas.length - 1] || fechaDesde;
    await pool.query(`
      INSERT INTO tesoreria_extractos
        (cuenta_id, fecha_desde, fecha_hasta, total_filas, importadas, omitidas, nombre_archivo, importado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      data.cuenta_id,
      fechaDesde,
      fechaHasta,
      seleccionadas.length,
      importadas.length,
      omitidas.length,
      req.file.originalname || null,
      req.user.id,
    ]);

    res.json({
      importadas:       importadas.length,
      omitidas:         omitidas.length,
      detalle_omitidas: omitidas,
    });
  } catch (err) { next(err); }
};
