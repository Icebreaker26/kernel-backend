import pool from '../../../db/database.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { env } from '../../../config/env.js';
import {
  causarSchema, registrarPagoSchema, anularSchema,
  configEmpresaSchema, activarPortalEmpresaSchema,
  loginEmpresaSchema, cambiarPasswordEmpresaSchema,
  actualizarAporteSchema,
} from '../schemas/patronalesSchema.js';

const cookieOpts = () => ({
  httpOnly: true,
  secure: env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: 8 * 60 * 60 * 1000,
});

const generarPassword = () => {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

// ── Portal empresa ─────────────────────────────────────────────────────────────

export const loginEmpresa = async (req, res, next) => {
  try {
    const { email, password } = loginEmpresaSchema.parse(req.body);
    const { rows } = await pool.query(
      `SELECT epa.*, e.nombre
         FROM empresas_portal_acceso epa
         JOIN empresas e ON e.codigo = epa.empresa_codigo
        WHERE epa.email = $1 AND epa.portal_activo = true`,
      [email]
    );
    if (!rows.length) return res.status(401).json({ error: 'Credenciales inválidas' });
    const acc = rows[0];
    const valid = await bcrypt.compare(password, acc.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = jwt.sign(
      { tipo: 'empresa', codigo: acc.empresa_codigo, email: acc.email, nombre: acc.nombre },
      env.JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.cookie('token_empresa', token, cookieOpts());
    res.json({ empresa_codigo: acc.empresa_codigo, nombre: acc.nombre, primer_login: acc.primer_login });
  } catch (err) { next(err); }
};

export const logoutEmpresa = (_req, res) => {
  res.clearCookie('token_empresa');
  res.json({ ok: true });
};

export const meEmpresa = async (req, res, next) => {
  try {
    const { rows: [emp] } = await pool.query(
      `SELECT epa.email, epa.primer_login, e.codigo, e.nombre
         FROM empresas_portal_acceso epa
         JOIN empresas e ON e.codigo = epa.empresa_codigo
        WHERE epa.empresa_codigo = $1`,
      [req.empresa.codigo]
    );
    if (!emp) return res.status(404).json({ error: 'Empresa no encontrada' });
    res.json(emp);
  } catch (err) { next(err); }
};

export const cambiarPasswordEmpresa = async (req, res, next) => {
  try {
    const { password_actual, password_nueva } = cambiarPasswordEmpresaSchema.parse(req.body);
    const { rows: [acc] } = await pool.query(
      'SELECT password_hash FROM empresas_portal_acceso WHERE empresa_codigo = $1',
      [req.empresa.codigo]
    );
    if (!acc) return res.status(404).json({ error: 'No encontrado' });
    const valid = await bcrypt.compare(password_actual, acc.password_hash);
    if (!valid) return res.status(400).json({ error: 'Contraseña actual incorrecta' });

    const hash = await bcrypt.hash(password_nueva, 12);
    await pool.query(
      `UPDATE empresas_portal_acceso
          SET password_hash = $1, primer_login = false, updated_at = NOW()
        WHERE empresa_codigo = $2`,
      [hash, req.empresa.codigo]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
};

export const misFacturas = async (req, res, next) => {
  try {
    const codigo = req.empresa.codigo;
    await pool.query(
      `UPDATE patronales_facturas SET estado = 'vencida', updated_at = NOW()
        WHERE empresa_codigo = $1 AND estado IN ('pendiente','pago_parcial') AND fecha_vencimiento < CURRENT_DATE`,
      [codigo]
    );
    const { rows } = await pool.query(`
      SELECT f.id, f.periodo, f.tipo_cuota, f.monto_total, f.estado,
             f.fecha_emision, f.fecha_vencimiento,
             COALESCE(p.pagado, 0)                               AS total_pagado,
             f.monto_total - COALESCE(p.pagado, 0)              AS saldo,
             GREATEST(0, CURRENT_DATE - f.fecha_vencimiento)    AS dias_mora
        FROM patronales_facturas f
        LEFT JOIN (SELECT factura_id, SUM(monto) AS pagado FROM patronales_pagos GROUP BY factura_id) p
          ON p.factura_id = f.id
       WHERE f.empresa_codigo = $1 AND f.estado <> 'anulada'
       ORDER BY f.periodo DESC
    `, [codigo]);
    res.json(rows);
  } catch (err) { next(err); }
};

// ── Dashboard ─────────────────────────────────────────────────────────────────

export const dashboard = async (req, res, next) => {
  try {
    const { rows: [stats] } = await pool.query(`
      SELECT
        COALESCE(SUM(f.monto_total), 0)                                          AS total_causado,
        COALESCE(SUM(p.pagado), 0)                                               AS total_cobrado,
        COALESCE(SUM(CASE WHEN f.estado = 'vencida'
                     THEN f.monto_total - COALESCE(p.pagado, 0) ELSE 0 END), 0) AS total_mora,
        COUNT(DISTINCT CASE WHEN f.estado IN ('pendiente','pago_parcial','vencida')
                       THEN f.empresa_codigo END)                                AS empresas_en_deuda
        FROM patronales_facturas f
        LEFT JOIN (
          SELECT factura_id, SUM(monto) AS pagado FROM patronales_pagos GROUP BY factura_id
        ) p ON p.factura_id = f.id
       WHERE f.estado <> 'anulada'
    `);
    res.json(stats);
  } catch (err) { next(err); }
};

// ── Causar ────────────────────────────────────────────────────────────────────

export const causar = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { periodo } = causarSchema.parse(req.body);

    // Último día del periodo: filtra asociados cuya cuota ya aplica
    const ultimoDiaPeriodo = `(date_trunc('month', to_date('${periodo}-01', 'YYYY-MM-DD')) + interval '1 month - 1 day')::date`;

    const { rows: empresas } = await client.query(`
      SELECT DISTINCT e.codigo, e.nombre,
             COALESCE(cfg.facturacion, 'unica')      AS facturacion,
             COALESCE(cfg.dias_vencimiento, 30)      AS dias_vencimiento
        FROM empresas e
        JOIN asociados a ON a.empresa_dsto = e.codigo
                        AND a.is_active = true
                        AND a.valor_aporte IS NOT NULL
                        AND a.valor_aporte_desde IS NOT NULL
                        AND a.valor_aporte_desde <= ${ultimoDiaPeriodo}
        LEFT JOIN patronales_config_empresa cfg ON cfg.empresa_codigo = e.codigo
       WHERE e.is_active = true
    `);

    const results = [];
    await client.query('BEGIN');

    for (const emp of empresas) {
      const { rows: asocs } = await client.query(
        `SELECT codigo, nombre || ' ' || apellido AS nombre_completo, clase_cuota, valor_aporte
           FROM asociados
          WHERE empresa_dsto = $1
            AND is_active = true
            AND valor_aporte IS NOT NULL
            AND valor_aporte_desde IS NOT NULL
            AND valor_aporte_desde <= ${ultimoDiaPeriodo}`,
        [emp.codigo]
      );
      if (!asocs.length) continue;

      // Boletos activos en sorteos activos para los asociados de esta empresa
      const codigosAsocs = asocs.map((a) => a.codigo);
      const { rows: boletosActivos } = await client.query(
        `SELECT b.asociado_codigo, b.numero, s.nombre AS sorteo_nombre, s.precio_boleto
           FROM boletos b
           JOIN sorteos s ON s.id = b.sorteo_id
          WHERE b.asociado_codigo = ANY($1)
            AND b.estado = 'asignado'
            AND s.estado = 'activo'
            AND s.precio_boleto > 0`,
        [codigosAsocs]
      );

      // Agrupar boletos: asociado_codigo → sorteo_nombre → {precio, numeros[]}
      const boletosMap = new Map();
      for (const b of boletosActivos) {
        if (!boletosMap.has(b.asociado_codigo)) boletosMap.set(b.asociado_codigo, new Map());
        const porSorteo = boletosMap.get(b.asociado_codigo);
        if (!porSorteo.has(b.sorteo_nombre)) {
          porSorteo.set(b.sorteo_nombre, { precio_boleto: parseFloat(b.precio_boleto), numeros: [] });
        }
        porSorteo.get(b.sorteo_nombre).numeros.push(b.numero);
      }

      // Enriquecer cada asociado con su costo total de bonos y el snapshot
      for (const a of asocs) {
        const porSorteo = boletosMap.get(a.codigo);
        if (!porSorteo || porSorteo.size === 0) {
          a.bonos_monto   = 0;
          a.bonos_detalle = null;
          continue;
        }
        let total = 0;
        const detalle = [];
        for (const [sorteo, { precio_boleto, numeros }] of porSorteo) {
          const subtotal = precio_boleto * numeros.length;
          total += subtotal;
          detalle.push({ sorteo, precio_boleto, boletos: numeros.sort((x, y) => x - y), subtotal });
        }
        a.bonos_monto   = total;
        a.bonos_detalle = detalle;
      }

      const insertFactura = async (tipo_cuota, members) => {
        // Total = cuota del sorteo (bonos_monto) + aporte de ahorros (valor_aporte × factor)
        const monto_total = members.reduce((s, a) =>
          s + (a.bonos_monto ?? 0) + parseFloat(a.valor_aporte) * (a.clase_cuota === '1' ? 2 : 1), 0);

        // Verificar si ya existe una factura activa (no anulada) para este período
        const { rows: [existente] } = await client.query(
          `SELECT id FROM patronales_facturas
            WHERE empresa_codigo = $1 AND periodo = $2 AND tipo_cuota = $3 AND estado <> 'anulada'`,
          [emp.codigo, periodo, tipo_cuota]
        );
        if (existente) {
          results.push({ empresa: emp.nombre, tipo: tipo_cuota, created: false, reason: 'ya existe' });
          return;
        }

        const { rows: [f] } = await client.query(
          `INSERT INTO patronales_facturas (empresa_codigo, periodo, tipo_cuota, monto_total, fecha_vencimiento)
           VALUES ($1, $2, $3, $4, CURRENT_DATE + $5::int)
           RETURNING id`,
          [emp.codigo, periodo, tipo_cuota, monto_total, emp.dias_vencimiento]
        );
        for (const a of members) {
          await client.query(
            `INSERT INTO patronales_detalle
               (factura_id, asociado_codigo, nombre_snapshot, clase_cuota_snapshot, valor_aporte_snapshot, bonos_monto, bonos_detalle)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [f.id, a.codigo, a.nombre_completo, a.clase_cuota, a.valor_aporte,
             a.bonos_monto ?? 0, a.bonos_detalle ? JSON.stringify(a.bonos_detalle) : null]
          );
        }
        results.push({ empresa: emp.nombre, tipo: tipo_cuota, monto: monto_total, factura_id: f.id, created: true });
      };

      if (emp.facturacion === 'unica') {
        await insertFactura('mixta', asocs);
      } else {
        const quincenal = asocs.filter((a) => a.clase_cuota === '1');
        const mensual   = asocs.filter((a) => a.clase_cuota === '2');
        if (quincenal.length) await insertFactura('quincenal', quincenal);
        if (mensual.length)   await insertFactura('mensual', mensual);
      }
    }

    await client.query(
      `INSERT INTO patronales_logs (accion, usuario_uuid, detalle) VALUES ('causar', $1, $2)`,
      [req.user.id, JSON.stringify({ periodo, total: results.filter((r) => r.created).length })]
    );

    await client.query('COMMIT');
    res.json({ periodo, results });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── Facturas ──────────────────────────────────────────────────────────────────

export const listarFacturas = async (req, res, next) => {
  try {
    await pool.query(`
      UPDATE patronales_facturas SET estado = 'vencida', updated_at = NOW()
       WHERE estado IN ('pendiente','pago_parcial') AND fecha_vencimiento < CURRENT_DATE
    `);

    const { empresa_codigo, periodo, estado } = req.query;
    const params = [];
    const conds  = ["f.estado <> 'anulada'"];
    if (empresa_codigo) { params.push(empresa_codigo); conds.push(`f.empresa_codigo = $${params.length}`); }
    if (periodo)        { params.push(periodo);         conds.push(`f.periodo = $${params.length}`); }
    if (estado)         { params.push(estado);          conds.push(`f.estado = $${params.length}`); }

    const { rows } = await pool.query(`
      SELECT f.*, e.nombre AS nombre_empresa,
             COALESCE(p.pagado, 0)                            AS total_pagado,
             f.monto_total - COALESCE(p.pagado, 0)           AS saldo,
             GREATEST(0, CURRENT_DATE - f.fecha_vencimiento) AS dias_mora
        FROM patronales_facturas f
        JOIN empresas e ON e.codigo = f.empresa_codigo
        LEFT JOIN (SELECT factura_id, SUM(monto) AS pagado FROM patronales_pagos GROUP BY factura_id) p
          ON p.factura_id = f.id
       WHERE ${conds.join(' AND ')}
       ORDER BY f.periodo DESC, e.nombre
    `, params);

    res.json(rows);
  } catch (err) { next(err); }
};

export const getFactura = async (req, res, next) => {
  try {
    const { id } = req.params;
    await pool.query(
      `UPDATE patronales_facturas SET estado = 'vencida', updated_at = NOW()
        WHERE id = $1 AND estado IN ('pendiente','pago_parcial') AND fecha_vencimiento < CURRENT_DATE`,
      [id]
    );

    const { rows: [factura] } = await pool.query(`
      SELECT f.*, e.nombre AS nombre_empresa,
             COALESCE(p.pagado, 0)                            AS total_pagado,
             f.monto_total - COALESCE(p.pagado, 0)           AS saldo,
             GREATEST(0, CURRENT_DATE - f.fecha_vencimiento) AS dias_mora
        FROM patronales_facturas f
        JOIN empresas e ON e.codigo = f.empresa_codigo
        LEFT JOIN (SELECT factura_id, SUM(monto) AS pagado FROM patronales_pagos GROUP BY factura_id) p
          ON p.factura_id = f.id
       WHERE f.id = $1
    `, [id]);

    if (!factura) return res.status(404).json({ error: 'Factura no encontrada' });

    const { rows: detalle } = await pool.query(
      `SELECT *,
              valor_aporte_snapshot * CASE WHEN clase_cuota_snapshot = '1' THEN 2 ELSE 1 END AS aporte_monto,
              bonos_monto + valor_aporte_snapshot * CASE WHEN clase_cuota_snapshot = '1' THEN 2 ELSE 1 END AS monto_cobrado
         FROM patronales_detalle WHERE factura_id = $1 ORDER BY nombre_snapshot`,
      [id]
    );
    const { rows: pagos } = await pool.query(
      `SELECT pp.*, gu.nombre AS registrado_por_nombre
         FROM patronales_pagos pp
         LEFT JOIN global_usuarios gu ON gu.id = pp.registrado_por
        WHERE pp.factura_id = $1
        ORDER BY pp.fecha_pago`,
      [id]
    );

    res.json({ ...factura, detalle, pagos });
  } catch (err) { next(err); }
};

export const registrarPago = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { fecha_pago, monto, referencia } = registrarPagoSchema.parse(req.body);

    await client.query('BEGIN');
    const { rows: [factura] } = await client.query(
      'SELECT * FROM patronales_facturas WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!factura)                    return res.status(404).json({ error: 'Factura no encontrada' });
    if (factura.estado === 'anulada') return res.status(400).json({ error: 'La factura está anulada' });
    if (factura.estado === 'pagada')  return res.status(400).json({ error: 'La factura ya está pagada' });

    await client.query(
      `INSERT INTO patronales_pagos (factura_id, fecha_pago, monto, referencia, registrado_por)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, fecha_pago, monto, referencia || null, req.user.id]
    );

    const { rows: [{ total_pagado }] } = await client.query(
      'SELECT SUM(monto) AS total_pagado FROM patronales_pagos WHERE factura_id = $1',
      [id]
    );

    const nuevo_estado = parseFloat(total_pagado) >= parseFloat(factura.monto_total)
      ? 'pagada'
      : 'pago_parcial';

    await client.query(
      'UPDATE patronales_facturas SET estado = $1, updated_at = NOW() WHERE id = $2',
      [nuevo_estado, id]
    );
    await client.query(
      `INSERT INTO patronales_logs (accion, entidad_id, usuario_uuid, detalle) VALUES ('pagar', $1, $2, $3)`,
      [id, req.user.id, JSON.stringify({ monto, referencia, nuevo_estado })]
    );

    await client.query('COMMIT');
    res.json({ ok: true, nuevo_estado, total_pagado: parseFloat(total_pagado) });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

export const anularFactura = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { motivo } = anularSchema.parse(req.body);

    await client.query('BEGIN');
    const { rows: [factura] } = await client.query(
      'SELECT estado FROM patronales_facturas WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (!factura)                    return res.status(404).json({ error: 'Factura no encontrada' });
    if (factura.estado === 'anulada') return res.status(400).json({ error: 'Ya está anulada' });
    if (factura.estado === 'pagada')  return res.status(400).json({ error: 'No se puede anular una factura pagada' });

    await client.query(
      `UPDATE patronales_facturas
          SET estado = 'anulada', anulada_motivo = $1, updated_at = NOW()
        WHERE id = $2`,
      [motivo, id]
    );
    await client.query(
      `INSERT INTO patronales_logs (accion, entidad_id, usuario_uuid, detalle) VALUES ('anular', $1, $2, $3)`,
      [id, req.user.id, JSON.stringify({ motivo })]
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── Empresas ──────────────────────────────────────────────────────────────────

export const listarEmpresas = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.codigo, e.nombre, e.is_active,
             COALESCE(cfg.facturacion, 'unica')      AS facturacion,
             COALESCE(cfg.dias_vencimiento, 30)      AS dias_vencimiento,
             cfg.email_contacto,
             COALESCE(cfg.activa, true)              AS activa,
             epa.email                               AS portal_email,
             epa.portal_activo,
             COUNT(a.codigo) FILTER (WHERE a.is_active = true) AS total_asociados
        FROM empresas e
        LEFT JOIN patronales_config_empresa cfg  ON cfg.empresa_codigo = e.codigo
        LEFT JOIN empresas_portal_acceso    epa  ON epa.empresa_codigo = e.codigo
        LEFT JOIN asociados                 a    ON a.empresa_dsto = e.codigo
       GROUP BY e.codigo, e.nombre, e.is_active, cfg.facturacion, cfg.dias_vencimiento,
                cfg.email_contacto, cfg.activa, epa.email, epa.portal_activo
       ORDER BY e.nombre
    `);
    res.json(rows);
  } catch (err) { next(err); }
};

export const getEmpresa = async (req, res, next) => {
  try {
    const { codigo } = req.params;
    const { rows: [empresa] } = await pool.query(
      `SELECT e.codigo, e.nombre, e.is_active, e.fecha_ingreso,
              COALESCE(cfg.facturacion, 'unica') AS facturacion,
              COALESCE(cfg.dias_vencimiento, 30) AS dias_vencimiento,
              cfg.email_contacto, COALESCE(cfg.activa, true) AS activa,
              epa.email AS portal_email, epa.portal_activo, epa.primer_login
         FROM empresas e
         LEFT JOIN patronales_config_empresa cfg ON cfg.empresa_codigo = e.codigo
         LEFT JOIN empresas_portal_acceso    epa ON epa.empresa_codigo = e.codigo
        WHERE e.codigo = $1`,
      [codigo]
    );
    if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });

    const { rows: asociados } = await pool.query(
      `SELECT codigo, nombre || ' ' || apellido AS nombre_completo, clase_cuota, valor_aporte, valor_aporte_desde
         FROM asociados WHERE empresa_dsto = $1 AND is_active = true ORDER BY nombre`,
      [codigo]
    );
    const { rows: facturas } = await pool.query(`
      SELECT f.id, f.periodo, f.tipo_cuota, f.monto_total, f.estado,
             f.fecha_emision, f.fecha_vencimiento,
             COALESCE(p.pagado, 0)                            AS total_pagado,
             GREATEST(0, CURRENT_DATE - f.fecha_vencimiento) AS dias_mora
        FROM patronales_facturas f
        LEFT JOIN (SELECT factura_id, SUM(monto) AS pagado FROM patronales_pagos GROUP BY factura_id) p
          ON p.factura_id = f.id
       WHERE f.empresa_codigo = $1
       ORDER BY f.periodo DESC`,
      [codigo]
    );

    res.json({ ...empresa, asociados, facturas });
  } catch (err) { next(err); }
};

export const updateConfigEmpresa = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { codigo } = req.params;
    const data = configEmpresaSchema.parse(req.body);
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO patronales_config_empresa (empresa_codigo, facturacion, dias_vencimiento, email_contacto, activa)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (empresa_codigo) DO UPDATE
         SET facturacion      = EXCLUDED.facturacion,
             dias_vencimiento = EXCLUDED.dias_vencimiento,
             email_contacto   = EXCLUDED.email_contacto,
             activa           = EXCLUDED.activa,
             updated_at       = NOW()`,
      [codigo, data.facturacion, data.dias_vencimiento, data.email_contacto || null, data.activa]
    );
    await client.query(
      `INSERT INTO patronales_logs (accion, usuario_uuid, detalle) VALUES ('config_empresa', $1, $2)`,
      [req.user.id, JSON.stringify({ empresa_codigo: codigo, ...data })]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

export const activarPortalEmpresa = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { codigo } = req.params;
    const { email } = activarPortalEmpresaSchema.parse(req.body);

    const { rows: [emp] } = await client.query(
      'SELECT codigo FROM empresas WHERE codigo = $1 AND is_active = true',
      [codigo]
    );
    if (!emp) return res.status(404).json({ error: 'Empresa no encontrada' });

    const password = generarPassword();
    const hash     = await bcrypt.hash(password, 12);

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO empresas_portal_acceso (empresa_codigo, email, password_hash, portal_activo, primer_login)
       VALUES ($1, $2, $3, true, true)
       ON CONFLICT (empresa_codigo) DO UPDATE
         SET email         = EXCLUDED.email,
             password_hash = EXCLUDED.password_hash,
             portal_activo = true,
             primer_login  = true,
             updated_at    = NOW()`,
      [codigo, email, hash]
    );
    await client.query(
      `INSERT INTO patronales_logs (accion, usuario_uuid, detalle) VALUES ('activar_portal', $1, $2)`,
      [req.user.id, JSON.stringify({ empresa_codigo: codigo, email })]
    );
    await client.query('COMMIT');

    res.json({ ok: true, email, password });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

// ── Aportes ───────────────────────────────────────────────────────────────────

export const actualizarAporte = async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { codigo } = req.params;
    const { valor_aporte, fecha_desde, motivo, soporte } = actualizarAporteSchema.parse(req.body);

    await client.query('BEGIN');
    const { rows: [prev] } = await client.query(
      'SELECT valor_aporte FROM asociados WHERE codigo = $1 FOR UPDATE',
      [codigo]
    );
    if (!prev) return res.status(404).json({ error: 'Asociado no encontrado' });

    await client.query(
      'UPDATE asociados SET valor_aporte = $1, valor_aporte_desde = $2, updated_at = NOW() WHERE codigo = $3',
      [valor_aporte, fecha_desde, codigo]
    );
    await client.query(
      `INSERT INTO asociados_aporte_historial
         (asociado_codigo, valor_anterior, valor_nuevo, origen, motivo, soporte, usuario_uuid)
       VALUES ($1, $2, $3, 'admin', $4, $5, $6)`,
      [codigo, prev.valor_aporte, valor_aporte, motivo, soporte || null, req.user.id]
    );

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

export const historialAporte = async (req, res, next) => {
  try {
    const { codigo } = req.params;
    const { rows } = await pool.query(
      `SELECT h.*, gu.nombre AS usuario_nombre
         FROM asociados_aporte_historial h
         LEFT JOIN global_usuarios gu ON gu.id = h.usuario_uuid
        WHERE h.asociado_codigo = $1
        ORDER BY h.created_at DESC`,
      [codigo]
    );
    res.json(rows);
  } catch (err) { next(err); }
};
