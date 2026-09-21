import pool from '../../../db/database.js';
import { crearCampanaSchema, actualizarCampanaSchema, contactoSchema } from '../schemas/mailingSchema.js';
import logger from '../../../config/logger.js';
import { velocidadPorHora } from '../../../services/mailingDispatcher.js';
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
        AND NOT EXISTS (SELECT 1 FROM email_bajas eb WHERE eb.is_active AND lower(eb.email) = lower(asociados.email))
      ORDER BY apellido, nombre
    `);
    return rows;
  }

  const { rows } = await pool.query(`
    SELECT DISTINCT a.codigo, a.nombre, a.apellido, a.email
    FROM asociados a
    WHERE a.is_active = true
      AND a.email IS NOT NULL AND a.email <> ''
      AND NOT EXISTS (SELECT 1 FROM email_bajas eb WHERE eb.is_active AND lower(eb.email) = lower(a.email))
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

// Contactos no asociados (jornadas presenciales). segmento.jornadas vacío = todos los contactos activos.
// Se excluyen quienes ya son asociados (cruce por correo) y quienes se dieron de baja.
const getContactos = async (segmento = {}) => {
  const jornadas = segmento.jornadas ?? [];
  const { rows } = await pool.query(`
    SELECT c.id AS contacto_id, c.nombre, c.email
    FROM mailing_contactos c
    WHERE c.is_active = true
      AND ($1::text[] = '{}'::text[] OR c.jornada = ANY($1::text[]))
      AND NOT EXISTS (SELECT 1 FROM email_bajas eb WHERE eb.is_active AND lower(eb.email) = lower(c.email))
      AND NOT EXISTS (SELECT 1 FROM asociados a WHERE a.is_active AND lower(a.email) = lower(c.email))
    ORDER BY c.created_at
  `, [jornadas]);
  return rows;
};

const getAudiencia = (camp) =>
  camp.audiencia === 'contactos' ? getContactos(camp.segmento) : getDestinatarios(camp.segmento);

// ── Controladores ─────────────────────────────────────────────────────────────

export const listar = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.id, c.asunto, c.estado, c.segmento, c.plantilla, c.audiencia,
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
      `INSERT INTO campanas (asunto, cuerpo_html, cuerpo_texto, audiencia, segmento, plantilla, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        data.asunto,
        data.cuerpo_html,
        data.cuerpo_texto ?? null,
        data.audiencia,
        JSON.stringify(data.segmento ?? { empresas: [], sorteos: [], codigos: [], jornadas: [] }),
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
    if (data.audiencia    !== undefined) { vals.push(data.audiencia);                 sets.push(`audiencia = $${vals.length}`); }
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
    const destinatarios = await getAudiencia(camp);
    const count = destinatarios.length;
    // Solo advierte cuando el envío tardaría más de una hora al ritmo actual del dispatcher
    const porHora = velocidadPorHora();
    const advertencia_rate = count > porHora
      ? `Esta campaña tiene ${count} destinatarios y el envío procesa ~${porHora} correos/hora (compartido con otros envíos del sistema): tardará unas ${(count / porHora).toFixed(1)} h.`
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
    // Las plantillas de jornada vienen con marcadores [COMPLETAR]: no se envía hasta reemplazarlos
    const { rows: [borrador] } = await pool.query(
      `SELECT asunto, cuerpo_html FROM campanas WHERE id = $1 AND is_active = true`, [id]
    );
    if (borrador && (borrador.asunto + borrador.cuerpo_html).includes('[COMPLETAR')) {
      return res.status(409).json({ error: 'La campaña aún tiene marcadores [COMPLETAR] en el asunto o el contenido' });
    }
    const { rows: [camp] } = await pool.query(
      `UPDATE campanas SET estado = 'enviando', updated_at = NOW()
       WHERE id = $1 AND is_active = true AND estado = 'borrador' RETURNING *`,
      [id]
    );
    if (!camp) return res.status(409).json({ error: 'La campaña no existe o ya fue enviada' });

    const destinatarios = await getAudiencia(camp);

    if (!destinatarios.length) {
      await pool.query(
        `UPDATE campanas SET estado = 'enviada', enviados = 0, destinatarios_total = 0, enviada_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [id]
      );
      return res.json({ ok: true, destinatarios: 0 });
    }

    // Insertar en cola en un solo INSERT masivo — estado explícito para satisfacer la CHECK
    const values = destinatarios
      .map((_, i) => `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4}, 'pendiente')`)
      .join(', ');
    const params = [id, ...destinatarios.flatMap(d => [d.email, d.codigo ?? null, d.contacto_id ?? null])];
    await pool.query(
      `INSERT INTO cola_mailing (campana_id, email, asociado_codigo, contacto_id, estado) VALUES ${values}`,
      params
    );

    await pool.query(
      `UPDATE campanas SET destinatarios_total = $2, enviados = 0, errores = 0, updated_at = NOW() WHERE id = $1`,
      [id, destinatarios.length]
    );

    const horasEstimadas = (destinatarios.length / velocidadPorHora()).toFixed(1);
    logger.info(`campana ${id}: ${destinatarios.length} destinatarios encolados (~${horasEstimadas}h)`);
    res.json({ ok: true, destinatarios: destinatarios.length, horas_estimadas: Number(horasEstimadas) });
  } catch (err) { next(err); }
};

// ── Contactos de jornada (personas no asociadas) ──────────────────────────────

export const listarContactos = async (req, res, next) => {
  try {
    const jornada = typeof req.query.jornada === 'string' ? req.query.jornada : null;
    const { rows } = await pool.query(`
      SELECT id, nombre, email, telefono, jornada, autorizacion_at, created_at
      FROM mailing_contactos
      WHERE is_active = true AND ($1::text IS NULL OR jornada = $1)
      ORDER BY created_at DESC
      LIMIT 500
    `, [jornada]);
    res.json(rows);
  } catch (err) { next(err); }
};

export const listarJornadas = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT jornada, COUNT(*)::int AS contactos, MAX(created_at) AS ultima
      FROM mailing_contactos
      WHERE is_active = true
      GROUP BY jornada
      ORDER BY MAX(created_at) DESC
    `);
    res.json(rows);
  } catch (err) { next(err); }
};

export const crearContacto = async (req, res, next) => {
  try {
    const data = contactoSchema.parse(req.body);
    const { rows: [yaAsociado] } = await pool.query(
      `SELECT codigo FROM asociados WHERE is_active = true AND lower(email) = $1 LIMIT 1`, [data.email]
    );
    if (yaAsociado) return res.status(409).json({ error: 'Ese correo ya pertenece a un asociado de la cooperativa' });

    const { rows: [c] } = await pool.query(
      `INSERT INTO mailing_contactos (nombre, email, telefono, jornada, autorizacion_datos, creado_por)
       VALUES ($1, $2, $3, $4, true, $5)
       ON CONFLICT (lower(email), lower(jornada)) WHERE is_active
       DO UPDATE SET nombre = EXCLUDED.nombre, telefono = COALESCE(EXCLUDED.telefono, mailing_contactos.telefono), updated_at = NOW()
       RETURNING id, nombre, email, telefono, jornada, created_at`,
      [data.nombre, data.email, data.telefono || null, data.jornada, req.user.id]
    );
    res.status(201).json(c);
  } catch (err) { next(err); }
};

export const eliminarContacto = async (req, res, next) => {
  try {
    const { rows: [c] } = await pool.query(
      `UPDATE mailing_contactos SET is_active = false, updated_at = NOW() WHERE id = $1 AND is_active = true RETURNING id`,
      [req.params.id]
    );
    if (!c) return res.status(404).json({ error: 'Contacto no encontrado' });
    res.json({ ok: true });
  } catch (err) { next(err); }
};
