import pool from '../../../db/database.js';
import {
  crearCuentaSchema, actualizarCuentaSchema,
  crearCategoriaSchema, actualizarCategoriaSchema,
  crearPeriodoSchema,
  crearMovimientoSchema,
  crearProveedorSchema, actualizarProveedorSchema,
  crearFacturaSchema, pagarFacturaSchema, rechazarFacturaSchema,
} from '../schemas/tesoreriaSchema.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const saldoActual = `
  COALESCE((
    SELECT SUM(CASE
      WHEN m.tipo = 'ingreso'  THEN  m.monto
      WHEN m.tipo = 'egreso'   THEN -m.monto
      WHEN m.tipo = 'traslado' AND m.cuenta_id          = c.id THEN -m.monto
      WHEN m.tipo = 'traslado' AND m.cuenta_destino_id  = c.id THEN  m.monto
    END)
    FROM tesoreria_movimientos m
    WHERE m.cuenta_id = c.id OR m.cuenta_destino_id = c.id
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
    if (data.nombre    !== undefined) { sets.push(`nombre = $${i++}`);    vals.push(data.nombre); }
    if (data.entidad   !== undefined) { sets.push(`entidad = $${i++}`);   vals.push(data.entidad || null); }
    if (data.numero    !== undefined) { sets.push(`numero = $${i++}`);    vals.push(data.numero || null); }
    if (data.is_active !== undefined) { sets.push(`is_active = $${i++}`); vals.push(data.is_active); }
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
        (tipo, monto, fecha, descripcion, referencia, cuenta_id, cuenta_destino_id,
         categoria_id, periodo_id, registrado_por, corrige_movimiento_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
    `, [
      data.tipo, data.monto, data.fecha,
      data.descripcion || null, data.referencia || null,
      data.cuenta_id, data.cuenta_destino_id || null,
      data.categoria_id || null, data.periodo_id || null,
      req.user.id, data.corrige_movimiento_id || null,
    ]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
};

// ── Dashboard ──────────────────────────────────────────────────────────────────

export const dashboard = async (req, res, next) => {
  try {
    const hoy  = new Date();
    const mes  = req.query.mes || `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`;

    const { rows: cuentas } = await pool.query(`
      SELECT c.id, c.nombre, c.tipo, c.moneda,
             (${saldoActual}) AS saldo_actual
        FROM tesoreria_cuentas c
       WHERE c.is_active = true
       ORDER BY c.tipo, c.nombre
    `);

    const { rows: flujo } = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN monto ELSE 0 END), 0) AS ingresos,
        COALESCE(SUM(CASE WHEN tipo = 'egreso'  THEN monto ELSE 0 END), 0) AS egresos
      FROM tesoreria_movimientos
      WHERE to_char(fecha, 'YYYY-MM') = $1
    `, [mes]);

    const { rows: porCategoria } = await pool.query(`
      SELECT cat.nombre, cat.color, cat.tipo,
             COALESCE(SUM(m.monto), 0) AS total
        FROM tesoreria_movimientos m
        JOIN tesoreria_categorias cat ON cat.id = m.categoria_id
       WHERE to_char(m.fecha, 'YYYY-MM') = $1
         AND m.tipo IN ('ingreso', 'egreso')
       GROUP BY cat.id, cat.nombre, cat.color, cat.tipo
       ORDER BY total DESC
    `, [mes]);

    const { rows: ultimosMovimientos } = await pool.query(`
      SELECT m.id, m.tipo, m.monto, m.fecha, m.descripcion,
             c.nombre AS cuenta_nombre,
             cat.nombre AS categoria_nombre, cat.color AS categoria_color
        FROM tesoreria_movimientos m
        LEFT JOIN tesoreria_cuentas c ON c.id = m.cuenta_id
        LEFT JOIN tesoreria_categorias cat ON cat.id = m.categoria_id
       ORDER BY m.fecha DESC, m.created_at DESC
       LIMIT 10
    `);

    res.json({
      cuentas,
      flujo: flujo[0],
      por_categoria: porCategoria,
      ultimos_movimientos: ultimosMovimientos,
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
                  frecuencia: 'frecuencia', categoria: 'categoria', notas: 'notas', is_active: 'is_active' };
    for (const [k, col] of Object.entries(map)) {
      if (data[k] !== undefined) {
        sets.push(`${col} = $${i++}`);
        vals.push(['nit','email','telefono','frecuencia','categoria','notas'].includes(k)
          ? (data[k] || null) : data[k]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Sin campos a actualizar' });
    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE tesoreria_proveedores SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals
    );
    if (!rows[0]) return res.status(404).json({ error: 'Proveedor no encontrado' });
    res.json(rows[0]);
  } catch (err) { next(err); }
};

// ── Facturas ───────────────────────────────────────────────────────────────────

const facturaBase = `
  SELECT f.*,
         p.nombre  AS proveedor_nombre,
         p.tipo_pago AS proveedor_tipo,
         p.frecuencia AS proveedor_frecuencia,
         p.categoria AS proveedor_categoria,
         c.nombre  AS cuenta_pago_nombre,
         u.nombre  AS registrado_por_nombre,
         ua.nombre AS aprobado_por_nombre
    FROM tesoreria_facturas f
    JOIN tesoreria_proveedores p  ON p.id = f.proveedor_id
    LEFT JOIN tesoreria_cuentas c ON c.id = f.cuenta_pago_id
    LEFT JOIN global_usuarios u   ON u.id = f.registrado_por
    LEFT JOIN global_usuarios ua  ON ua.id = f.aprobado_por
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
    const { rows } = await pool.query(`
      INSERT INTO tesoreria_facturas
        (proveedor_id, monto, fecha_recibida, fecha_vencimiento, descripcion, soporte, cuenta_pago_id, registrado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [
      data.proveedor_id, data.monto, data.fecha_recibida, data.fecha_vencimiento,
      data.descripcion || null, data.soporte || null,
      data.cuenta_pago_id || null, req.user.id,
    ]);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
};

export const pagarFactura = async (req, res, next) => {
  try {
    const data = pagarFacturaSchema.parse(req.body);
    const { rows: [factura] } = await pool.query(
      `SELECT f.*, p.nombre AS proveedor_nombre FROM tesoreria_facturas f JOIN tesoreria_proveedores p ON p.id = f.proveedor_id WHERE f.id = $1`,
      [req.params.id]
    );
    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });
    if (factura.estado !== 'aprobada') return res.status(400).json({ error: 'La factura debe estar aprobada para pagarse' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Crear el movimiento de egreso
      const { rows: [mov] } = await client.query(`
        INSERT INTO tesoreria_movimientos
          (tipo, monto, fecha, descripcion, referencia, cuenta_id, categoria_id, periodo_id, registrado_por)
        SELECT 'egreso', $1, $2, $3, $4, $5,
               (SELECT id FROM tesoreria_categorias WHERE nombre = 'Pago a proveedor' LIMIT 1),
               $6, $7
        RETURNING *
      `, [
        factura.monto,
        data.fecha_pago,
        `Pago factura — ${factura.proveedor_nombre}${factura.descripcion ? ': ' + factura.descripcion : ''}`,
        data.referencia || null,
        data.cuenta_pago_id,
        data.periodo_id || null,
        req.user.id,
      ]);

      // Marcar factura como pagada y vincular el movimiento
      await client.query(`
        UPDATE tesoreria_facturas
           SET estado = 'pagada', movimiento_id = $1, cuenta_pago_id = $2, updated_at = NOW()
         WHERE id = $3
      `, [mov.id, data.cuenta_pago_id, req.params.id]);

      await client.query('COMMIT');
      res.json({ ok: true, movimiento_id: mov.id });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
};

// ── Control Interno — aprobación (también usado desde control_interno module) ──

export const aprobarFactura = async (req, res, next) => {
  try {
    const { rows: [f] } = await pool.query(
      `SELECT estado FROM tesoreria_facturas WHERE id = $1`, [req.params.id]
    );
    if (!f) return res.status(404).json({ error: 'Factura no encontrada' });
    if (f.estado !== 'pendiente_aprobacion') return res.status(400).json({ error: `Estado actual: ${f.estado}` });
    const { rows } = await pool.query(`
      UPDATE tesoreria_facturas
         SET estado = 'aprobada', aprobado_por = $1, aprobado_at = NOW(), updated_at = NOW()
       WHERE id = $2 RETURNING *
    `, [req.user.id, req.params.id]);
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
    if (f.estado !== 'pendiente_aprobacion') return res.status(400).json({ error: `Estado actual: ${f.estado}` });
    const { rows } = await pool.query(`
      UPDATE tesoreria_facturas
         SET estado = 'rechazada', rechazo_motivo = $1, aprobado_por = $2, aprobado_at = NOW(), updated_at = NOW()
       WHERE id = $3 RETURNING *
    `, [motivo, req.user.id, req.params.id]);
    res.json(rows[0]);
  } catch (err) { next(err); }
};
