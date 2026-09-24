import crypto from 'crypto';
import pool from '../../../db/database.js';
import { selloSchema, registroSchema, MAX_DOCS_LOTE } from '../schemas/firmaSchema.js';
import { firmarSello, verificarSello, clavePublicaPem } from '../services/selloService.js';

// Emite el folio y el sello del servidor para un documento. Solo recibe hashes y datos de identificación: el PDF, la firma
// y la huella nunca llegan aquí (se estampan en el navegador del empleado).
export const sellar = async (req, res, next) => {
  try {
    const data = selloSchema.parse(req.body);
    const { rows: [emp] } = await pool.query('SELECT nombre FROM global_usuarios WHERE id = $1', [req.user.id]);
    const { lote } = data;
    if (lote) {
      // Un lote es de un solo empleado y admite hasta MAX_DOCS_LOTE documentos (más algún reintento de los que fallaron)
      const { rows: [g] } = await pool.query(
        `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE empleado_id IS DISTINCT FROM $2)::int AS ajenos
         FROM firma_eventos WHERE lote_id = $1`, [lote.id, req.user.id]);
      if (g.ajenos > 0) return res.status(409).json({ error: 'Ese lote pertenece a otro funcionario' });
      if (g.n >= MAX_DOCS_LOTE * 2) return res.status(409).json({ error: 'El lote alcanzó el máximo de documentos' });
    }
    const { rows: [ev] } = await pool.query(
      `INSERT INTO firma_eventos (h_original, nombre_archivo, paginas, empleado_id, firmantes, ip, lote_id, lote_pos, lote_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING folio, created_at`,
      [data.h_original, data.nombre_archivo, data.paginas, req.user.id, JSON.stringify(data.firmantes), req.ip,
        lote?.id ?? null, lote?.pos ?? null, lote?.total ?? null]);
    const ts = ev.created_at.toISOString();
    const token = firmarSello({ f: ev.folio, h: data.h_original, t: ts, e: req.user.id });
    res.status(201).json({ folio: ev.folio, ts, token, empleado: emp?.nombre ?? null });
  } catch (err) { next(err); }
};

// Fija el hash del PDF final (una sola vez) para poder verificarlo después con /verificar.
export const registrarFinal = async (req, res, next) => {
  try {
    const { folio, h_final } = registroSchema.parse(req.body);
    const { rows: [ev] } = await pool.query('SELECT id, empleado_id, h_final FROM firma_eventos WHERE folio = $1', [folio]);
    if (!ev || ev.empleado_id !== req.user.id) return res.status(404).json({ error: 'Folio no encontrado' });
    if (ev.h_final) return res.status(409).json({ error: 'Este folio ya tiene su documento final registrado' });
    await pool.query('UPDATE firma_eventos SET h_final = $1, final_at = NOW() WHERE id = $2', [h_final, ev.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
};

// Recalcula el SHA-256 del PDF subido y lo busca entre los documentos finales registrados. El archivo no se guarda.
export const verificar = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Adjunta el PDF a verificar' });
    const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const { rows: [ev] } = await pool.query(
      `SELECT e.folio, e.nombre_archivo, e.h_original, e.paginas, e.firmantes, e.created_at, e.lote_id, e.lote_pos, e.lote_total, u.nombre AS empleado
       FROM firma_eventos e LEFT JOIN global_usuarios u ON u.id = e.empleado_id
       WHERE e.h_final = $1`, [hash]);
    if (!ev) return res.json({ valido: false, hash });
    res.json({
      valido: true, hash, folio: ev.folio, nombre_archivo: ev.nombre_archivo, h_original: ev.h_original,
      paginas: ev.paginas, fecha: ev.created_at, empleado: ev.empleado,
      lote: ev.lote_id ? { id: ev.lote_id, pos: ev.lote_pos, total: ev.lote_total } : null,
      firmantes: ev.firmantes.map((f) => ({ nombre: f.nombre, tipo_doc: f.tipo_doc, num_doc: f.num_doc, rol: f.rol, con_huella: f.con_huella })),
    });
  } catch (err) { next(err); }
};

// Comprueba un token de sello (p. ej. el de la constancia impresa en el PDF)
export const verificarToken = (req, res) => {
  const payload = verificarSello(req.body?.token);
  res.json({ valido: !!payload, ...(payload ? { folio: payload.f, h_original: payload.h, ts: payload.t } : {}) });
};

export const clavePublica = (req, res) => res.type('text/plain').send(clavePublicaPem());
