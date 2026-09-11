import pool from '../../../db/database.js';
import {
  validarArchivo,
  generarPresignedUpload,
  guardarArchivo,
  listarArchivos,
  generarPresignedDescarga,
} from '../../../services/archivoService.js';

// ── Contable: ver estado actual + solicitud pendiente de un proveedor ──────
export const getEstado = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rows: [prov] } = await pool.query(
      `SELECT banco, tipo_cuenta, numero_cuenta, titular_cuenta, datos_bancarios_estado
         FROM tesoreria_proveedores WHERE id = $1`,
      [id]
    );
    if (!prov) return res.status(404).json({ error: 'Proveedor no encontrado' });

    const { rows: [pendiente] } = await pool.query(
      `SELECT db.*, u.nombre AS solicitado_por_nombre
         FROM tesoreria_proveedores_datos_bancarios db
         LEFT JOIN global_usuarios u ON u.id = db.solicitado_por
        WHERE db.proveedor_id = $1 AND db.estado = 'pendiente_ci'
        ORDER BY db.created_at DESC LIMIT 1`,
      [id]
    );

    res.json({ activos: prov, pendiente: pendiente || null });
  } catch (err) { next(err); }
};

// ── Contable: registrar nueva solicitud de datos bancarios ─────────────────
export const solicitarCambio = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { banco, tipo_cuenta, numero_cuenta, titular_cuenta } = req.body;

    if (!banco || !tipo_cuenta || !numero_cuenta || !titular_cuenta)
      return res.status(400).json({ error: 'Todos los campos bancarios son obligatorios' });

    const { rows: [prov] } = await pool.query(
      `SELECT datos_bancarios_estado FROM tesoreria_proveedores WHERE id = $1`,
      [id]
    );
    if (!prov) return res.status(404).json({ error: 'Proveedor no encontrado' });
    if (prov.datos_bancarios_estado === 'pendiente_ci')
      return res.status(409).json({ error: 'Ya hay una solicitud en revisión por Control Interno' });

    await pool.query('BEGIN');
    const { rows: [solicitud] } = await pool.query(
      `INSERT INTO tesoreria_proveedores_datos_bancarios
         (proveedor_id, banco, tipo_cuenta, numero_cuenta, titular_cuenta, solicitado_por)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [id, banco, tipo_cuenta, numero_cuenta, titular_cuenta, req.user.id]
    );
    await pool.query(
      `UPDATE tesoreria_proveedores SET datos_bancarios_estado = 'pendiente_ci' WHERE id = $1`,
      [id]
    );
    await pool.query('COMMIT');
    res.status(201).json(solicitud);
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
    next(err);
  }
};

// ── Contable: solicitar presigned URL para certificado bancario ───────────
export const solicitarCertificadoUpload = async (req, res, next) => {
  try {
    const { solicitudId } = req.params;
    const error = validarArchivo(req.body);
    if (error) return res.status(400).json({ error });

    const { rows: [sol] } = await pool.query(
      `SELECT id FROM tesoreria_proveedores_datos_bancarios WHERE id = $1`,
      [solicitudId]
    );
    if (!sol) return res.status(404).json({ error: 'Solicitud no encontrada' });

    const result = await generarPresignedUpload('certificado_bancario', solicitudId, req.body);
    res.json(result);
  } catch (err) { next(err); }
};

// ── Contable: confirmar upload y guardar en archivos ──────────────────────
export const confirmarCertificadoUpload = async (req, res, next) => {
  try {
    const { solicitudId } = req.params;
    const { key, nombre, mime, size } = req.body;

    if (!key || !nombre) return res.status(400).json({ error: 'Faltan campos: key, nombre' });
    if (!key.startsWith(`kernel/certificado_bancarios/${solicitudId}/`))
      return res.status(400).json({ error: 'Key inválida para esta solicitud' });

    await guardarArchivo('certificado_bancario', solicitudId, { key, nombre, mime, size }, req.user.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
};

// ── CI: ver certificado bancario de una solicitud ─────────────────────────
export const verCertificado = async (req, res, next) => {
  try {
    const { id } = req.params;
    const archivos = await listarArchivos('certificado_bancario', id);
    if (!archivos.length) return res.status(404).json({ error: 'Sin certificado adjunto' });
    const result = await generarPresignedDescarga(archivos[0].id);
    res.json(result);
  } catch (err) { next(err); }
};

// ── Contable: ver certificado bancario por proveedor (última solicitud con cert) ──
export const verCertificadoDeProveedor = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: solicitudes } = await pool.query(
      `SELECT id FROM tesoreria_proveedores_datos_bancarios
        WHERE proveedor_id = $1
        ORDER BY created_at DESC`,
      [id]
    );
    for (const sol of solicitudes) {
      const archivos = await listarArchivos('certificado_bancario', sol.id);
      if (archivos.length) {
        const result = await generarPresignedDescarga(archivos[0].id);
        return res.json(result);
      }
    }
    return res.status(404).json({ error: 'Sin certificado adjunto' });
  } catch (err) { next(err); }
};

// ── CI: listar solicitudes de datos bancarios (filtrable por estado) ───────
export const listarPendientes = async (req, res, next) => {
  try {
    const ESTADOS_VALIDOS = ['pendiente_ci', 'verificado', 'rechazado'];
    const estado = ESTADOS_VALIDOS.includes(req.query.estado) ? req.query.estado : 'pendiente_ci';

    const { rows } = await pool.query(
      `SELECT db.*,
              p.nombre AS proveedor_nombre,
              p.nit    AS proveedor_nit,
              u.nombre  AS solicitado_por_nombre,
              v.nombre  AS verificado_por_nombre
         FROM tesoreria_proveedores_datos_bancarios db
         JOIN tesoreria_proveedores p ON p.id = db.proveedor_id
         LEFT JOIN global_usuarios u ON u.id = db.solicitado_por
         LEFT JOIN global_usuarios v ON v.id = db.verificado_por
        WHERE db.estado = $1
        ORDER BY db.created_at DESC`,
      [estado]
    );
    res.json(rows);
  } catch (err) { next(err); }
};

// ── CI: verificar (aprobar) ────────────────────────────────────────────────
export const verificar = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rows: [sol] } = await pool.query(
      `SELECT * FROM tesoreria_proveedores_datos_bancarios WHERE id = $1`,
      [id]
    );
    if (!sol) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (sol.estado !== 'pendiente_ci')
      return res.status(400).json({ error: 'La solicitud ya fue procesada' });

    await pool.query('BEGIN');
    await pool.query(
      `UPDATE tesoreria_proveedores_datos_bancarios
          SET estado = 'verificado', verificado_por = $1, verificado_at = NOW()
        WHERE id = $2`,
      [req.user.id, id]
    );
    await pool.query(
      `UPDATE tesoreria_proveedores
          SET banco = $1, tipo_cuenta = $2, numero_cuenta = $3, titular_cuenta = $4,
              datos_bancarios_estado = 'verificado'
        WHERE id = $5`,
      [sol.banco, sol.tipo_cuenta, sol.numero_cuenta, sol.titular_cuenta, sol.proveedor_id]
    );
    await pool.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
    next(err);
  }
};

// ── CI: rechazar ───────────────────────────────────────────────────────────
export const rechazar = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { motivo } = req.body;
    if (!motivo?.trim()) return res.status(400).json({ error: 'El motivo de rechazo es obligatorio' });

    const { rows: [sol] } = await pool.query(
      `SELECT * FROM tesoreria_proveedores_datos_bancarios WHERE id = $1`,
      [id]
    );
    if (!sol) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (sol.estado !== 'pendiente_ci')
      return res.status(400).json({ error: 'La solicitud ya fue procesada' });

    await pool.query('BEGIN');
    await pool.query(
      `UPDATE tesoreria_proveedores_datos_bancarios
          SET estado = 'rechazado', motivo_rechazo = $1, verificado_por = $2, verificado_at = NOW()
        WHERE id = $3`,
      [motivo.trim(), req.user.id, id]
    );
    // Volver al estado anterior (verificado si ya tenía datos, sin_datos si no)
    await pool.query(
      `UPDATE tesoreria_proveedores
          SET datos_bancarios_estado = CASE
            WHEN banco IS NOT NULL THEN 'verificado'
            ELSE 'sin_datos'
          END
        WHERE id = $1`,
      [sol.proveedor_id]
    );
    await pool.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
    next(err);
  }
};
