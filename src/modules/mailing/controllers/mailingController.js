import pool from '../../../db/database.js';
import { crearCampanaSchema, actualizarCampanaSchema } from '../schemas/mailingSchema.js';
import logger from '../../../config/logger.js';
// enviarEmail y buildCampanaHtml los usa mailingDispatcher, no este controller

// ── Obtener destinatarios según segmento ──────────────────────────────────────
// segmento = { empresas: [], sorteos: [], codigos: [] }
// Si todos los arrays están vacíos → TODOS los asociados con email.
// Si alguno tiene elementos → UNION de los tres conjuntos.
const getDestinatarios = async (segmento = {}) => {
  const empresas = segmento.empresas ?? [];
  const sorteos  = segmento.sorteos  ?? [];
  const codigos  = segmento.codigos  ?? [];
  const todos    = empresas.length === 0 && sorteos.length === 0 && codigos.length === 0;

  if (todos) {
    const { rows } = await pool.query(`
      SELECT codigo, nombre, apellido, email
      FROM asociados
      WHERE is_active = true AND email IS NOT NULL AND email <> ''
      ORDER BY apellido, nombre
    `);
    return rows;
  }

  const { rows } = await pool.query(`
    SELECT DISTINCT a.codigo, a.nombre, a.apellido, a.email
    FROM asociados a
    WHERE a.is_active = true
      AND a.email IS NOT NULL AND a.email <> ''
      AND (
        ($1::text[]  <> '{}'::text[]  AND a.empresa_dsto = ANY($1::text[]))
        OR
        ($2::uuid[]  <> '{}'::uuid[]  AND EXISTS (
          SELECT 1 FROM boletos b
          WHERE b.asociado_codigo = a.codigo
            AND b.sorteo_id = ANY($2::uuid[])
            AND b.estado = 'asignado'
        ))
        OR
        ($3::text[]  <> '{}'::text[]  AND a.codigo = ANY($3::text[]))
      )
    ORDER BY a.apellido, a.nombre
  `, [empresas, sorteos, codigos]);
  return rows;
};

// ── Controladores ─────────────────────────────────────────────────────────────

export const listar = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.asunto, c.estado, c.segmento, c.plantilla,
             c.destinatarios_total, c.enviados, c.errores,
             c.created_at, c.enviada_at,
             gu.nombre AS creado_por_nombre
      FROM campanas c
      LEFT JOIN global_usuarios gu ON gu.id = c.creado_por
      WHERE c.is_active = true
      ORDER BY c.created_at DESC
    `);
    res.json(rows);
  } catch (err) { next(err); }
};

export const crear = async (req, res, next) => {
  try {
    const data = crearCampanaSchema.parse(req.body);
    const { rows: [camp] } = await pool.query(
      `INSERT INTO campanas (asunto, cuerpo_html, cuerpo_texto, segmento, plantilla, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        data.asunto,
        data.cuerpo_html,
        data.cuerpo_texto ?? null,
        JSON.stringify(data.segmento ?? { empresas: [], sorteos: [], codigos: [] }),
        data.plantilla ? JSON.stringify(data.plantilla) : null,
        req.user.id,
      ]
    );
    res.status(201).json(camp);
  } catch (err) { next(err); }
};

export const actualizar = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: [camp] } = await pool.query(
      `SELECT estado FROM campanas WHERE id = $1 AND is_active = true`, [id]
    );
    if (!camp) return res.status(404).json({ error: 'Campaña no encontrada' });
    if (camp.estado !== 'borrador') return res.status(409).json({ error: 'Solo se pueden editar campañas en borrador' });

    const data = actualizarCampanaSchema.parse(req.body);
    const sets = []; const vals = [id];
    if (data.asunto       !== undefined) { vals.push(data.asunto);                    sets.push(`asunto = $${vals.length}`); }
    if (data.cuerpo_html  !== undefined) { vals.push(data.cuerpo_html);               sets.push(`cuerpo_html = $${vals.length}`); }
    if (data.cuerpo_texto !== undefined) { vals.push(data.cuerpo_texto);              sets.push(`cuerpo_texto = $${vals.length}`); }
    if (data.segmento  !== undefined) { vals.push(JSON.stringify(data.segmento));              sets.push(`segmento = $${vals.length}`); }
    if (data.plantilla !== undefined) { vals.push(data.plantilla ? JSON.stringify(data.plantilla) : null); sets.push(`plantilla = $${vals.length}`); }
    if (!sets.length) return res.json(camp);

    sets.push(`updated_at = NOW()`);
    const { rows: [updated] } = await pool.query(
      `UPDATE campanas SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals
    );
    res.json(updated);
  } catch (err) { next(err); }
};

export const eliminar = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: [camp] } = await pool.query(
      `UPDATE campanas SET is_active = false, updated_at = NOW() WHERE id = $1 AND is_active = true RETURNING id`, [id]
    );
    if (!camp) return res.status(404).json({ error: 'Campaña no encontrada' });
    res.json({ ok: true });
  } catch (err) { next(err); }
};

export const preview = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows: [camp] } = await pool.query(
      `SELECT * FROM campanas WHERE id = $1 AND is_active = true`, [id]
    );
    if (!camp) return res.status(404).json({ error: 'Campaña no encontrada' });
    const destinatarios = await getDestinatarios(camp.segmento);
    const count = destinatarios.length;
    // El relay tiene límite de 500 emails/hora (global, incluye otros envíos del sistema)
    const advertencia_rate = count > 400
      ? `Esta campaña tiene ${count} destinatarios. El relay procesa máx. 500 emails/hora (compartido con otros envíos del sistema). Si hay activaciones de portal en el mismo momento puede haber demoras.`
      : null;
    res.json({ ...camp, destinatarios_count: count, advertencia_rate });
  } catch (err) { next(err); }
};

// Lista de candidatos para selección manual (todos los asociados con email)
export const candidatos = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT codigo, nombre, apellido, email, nombre_empresa
      FROM asociados
      WHERE is_active = true AND email IS NOT NULL AND email <> ''
      ORDER BY apellido, nombre
    `);
    res.json(rows);
  } catch (err) { next(err); }
};

// Encola todos los destinatarios — el dispatcher los procesa a 480/hora en background.
export const enviar = async (req, res, next) => {
  const { id } = req.params;
  try {
    const { rows: [camp] } = await pool.query(
      `UPDATE campanas SET estado = 'enviando', updated_at = NOW()
       WHERE id = $1 AND is_active = true AND estado = 'borrador' RETURNING *`,
      [id]
    );
    if (!camp) return res.status(409).json({ error: 'La campaña no existe o ya fue enviada' });

    const destinatarios = await getDestinatarios(camp.segmento);

    if (!destinatarios.length) {
      await pool.query(
        `UPDATE campanas SET estado = 'enviada', enviados = 0, destinatarios_total = 0, enviada_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [id]
      );
      return res.json({ ok: true, destinatarios: 0 });
    }

    // Insertar en cola en un solo INSERT masivo — estado explícito para satisfacer la CHECK
    const values = destinatarios
      .map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3}, 'pendiente')`)
      .join(', ');
    const params = [id, ...destinatarios.flatMap(d => [d.email, d.codigo])];
    await pool.query(
      `INSERT INTO cola_mailing (campana_id, email, asociado_codigo, estado) VALUES ${values}`,
      params
    );

    await pool.query(
      `UPDATE campanas SET destinatarios_total = $2, enviados = 0, errores = 0, updated_at = NOW() WHERE id = $1`,
      [id, destinatarios.length]
    );

    const horasEstimadas = (destinatarios.length / 480).toFixed(1);
    logger.info(`campana ${id}: ${destinatarios.length} destinatarios encolados (~${horasEstimadas}h)`);
    res.json({ ok: true, destinatarios: destinatarios.length, horas_estimadas: Number(horasEstimadas) });
  } catch (err) { next(err); }
};
