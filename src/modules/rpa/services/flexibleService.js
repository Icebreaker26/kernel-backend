/**
 * Flexible del maestro de cartera de SOLIDO (padrón completo de asociados).
 *
 * Flujo: una persona lo SOLICITA en Kernel → el agente lo exporta de SOLIDO a CSV UTF-8 y lo SUBE → queda `recibida` → una persona con
 * permiso lo revisa (el mismo análisis de impacto del sync manual) y lo APRUEBA o lo rechaza. Nada se aplica solo: al aprobar se ejecuta el
 * mismo importador del sync manual de CSV de asociados, con todas sus guardas (20 % de retiros, tasa de error, tope de filas, lock).
 */
import crypto from 'crypto';
import pool from '../../../db/database.js';
import { ErrorRpa } from './rpaService.js';
import { parsearCSV, previewImportarCSV, importarCSV } from '../../asociados/controllers/asociadosController.js';

export const MAX_BYTES = 40 * 1024 * 1024;        // el padrón completo cabe con holgura
const ABANDONO_MIN = 45;                          // una exportación 'ejecutando' más de esto se da por fallida (el agente se cayó)

// Los importadores reales; los tests los reemplazan (aplicar sobre la BD local de pruebas retiraría todo el padrón)
export const importadores = { preview: previewImportarCSV, aplicar: importarCSV };

const SELECT = `SELECT f.id, f.estado, f.nombre_archivo, f.tamano_bytes, f.sha256, f.filas, f.error, f.resultado, f.nota,
                       f.created_at, f.iniciada_at, f.recibida_at, f.revisada_at, f.agente_id,
                       (f.csv IS NOT NULL) AS tiene_archivo,
                       su.nombre AS solicitada_por_nombre, ru.nombre AS revisada_por_nombre, ag.nombre AS agente_nombre
                  FROM rpa_flexibles f
                  LEFT JOIN global_usuarios su ON su.id = f.solicitada_por
                  LEFT JOIN global_usuarios ru ON ru.id = f.revisada_por
                  LEFT JOIN rpa_agentes ag ON ag.id = f.agente_id`;

export const listar = async () => {
  const { rows } = await pool.query(`${SELECT} WHERE f.is_active ORDER BY f.created_at DESC LIMIT 50`);
  return rows;
};

const cargar = async (id, cn = pool) => {
  const { rows: [f] } = await cn.query(`SELECT * FROM rpa_flexibles WHERE id = $1 AND is_active`, [id]);
  if (!f) throw new ErrorRpa(404, 'Exportación no encontrada');
  return f;
};

export const obtener = async (id) => {
  const { rows: [f] } = await pool.query(`${SELECT} WHERE f.id = $1 AND f.is_active`, [id]);
  if (!f) throw new ErrorRpa(404, 'Exportación no encontrada');
  return f;
};

/** Pide al agente que exporte el flexible. Solo una en curso a la vez. */
export const solicitar = async (usuarioId) => {
  await abandonadas();
  try {
    const { rows: [f] } = await pool.query(
      `INSERT INTO rpa_flexibles (solicitada_por) VALUES ($1) RETURNING id`, [usuarioId]);
    return obtener(f.id);
  } catch (err) {
    if (err.code === '23505') throw new ErrorRpa(409, 'Ya hay una exportación del flexible en curso.');
    throw err;
  }
};

export const cancelar = async (id) => {
  const { rows: [f] } = await pool.query(
    `UPDATE rpa_flexibles SET estado = 'cancelada', updated_at = NOW() WHERE id = $1 AND estado = 'solicitada' RETURNING id`, [id]);
  if (!f) throw new ErrorRpa(409, 'Solo se cancela una exportación que el agente aún no empezó.');
  return obtener(id);
};

const abandonadas = async () => {
  await pool.query(
    `UPDATE rpa_flexibles SET estado = 'fallida', error = 'El agente dejó de responder durante la exportación', updated_at = NOW()
      WHERE estado = 'ejecutando' AND iniciada_at < NOW() - ($1 || ' minutes')::interval`, [String(ABANDONO_MIN)]);
};

/** El agente pide trabajo de este tipo: devuelve la exportación solicitada más antigua, o null. */
export const reclamarTarea = async (agente) => {
  await abandonadas();
  const cn = await pool.connect();
  try {
    await cn.query('BEGIN');
    const { rows: [a] } = await cn.query(`SELECT pausado FROM rpa_agentes WHERE id = $1 FOR UPDATE`, [agente.id]);
    if (a.pausado) { await cn.query('COMMIT'); return null; }
    const { rows: [f] } = await cn.query(
      `SELECT id FROM rpa_flexibles WHERE is_active AND estado = 'solicitada' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!f) { await cn.query('COMMIT'); return null; }
    await cn.query(`UPDATE rpa_flexibles SET estado = 'ejecutando', agente_id = $2, iniciada_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [f.id, agente.id]);
    await cn.query('COMMIT');
    return { id: f.id, tipo: 'flexible' };
  } catch (err) {
    await cn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { cn.release(); }
};

/** El agente entrega el CSV. Se valida que sea el padrón antes de dejarlo `recibida`. */
export const recibirArchivo = async (agente, id, buffer, nombre) => {
  const f = await cargar(id);
  if (f.estado !== 'ejecutando' || f.agente_id !== agente.id) throw new ErrorRpa(409, 'Esta exportación no está en curso para este agente');
  if (!buffer?.length) throw new ErrorRpa(400, 'El archivo llegó vacío');

  let filas = 0; let validos = 0; let errores = 0;
  try {
    const p = parsearCSV(buffer);
    filas = p.registrosFiltrados.length; validos = p.validos.length; errores = p.errores.length;
  } catch (e) {
    return marcarFallida(id, `El archivo no se pudo leer como CSV: ${e.message}`);
  }
  if (validos === 0) return marcarFallida(id, 'El archivo no contiene filas válidas del padrón (revisa el flexible exportado).');

  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  await pool.query(
    `UPDATE rpa_flexibles SET estado = 'recibida', csv = $2, nombre_archivo = $3, tamano_bytes = $4, sha256 = $5, filas = $6,
            resultado = $7, recibida_at = NOW(), error = NULL, updated_at = NOW() WHERE id = $1`,
    [id, buffer, String(nombre || 'flexible.csv').slice(0, 200), buffer.length, sha, filas, JSON.stringify({ validos, errores_formato: errores })]);
  return obtener(id);
};

export const marcarFallida = async (id, error) => {
  await pool.query(`UPDATE rpa_flexibles SET estado = 'fallida', error = $2, updated_at = NOW() WHERE id = $1 AND estado IN ('solicitada','ejecutando')`,
    [id, String(error).slice(0, 2000)]);
  return obtener(id);
};

export const fallo = async (agente, id, error) => {
  const f = await cargar(id);
  if (f.agente_id !== agente.id) throw new ErrorRpa(409, 'Esta exportación no es de este agente');
  return marcarFallida(id, error);
};

// ── Revisión humana ───────────────────────────────────────────────────────────

// Ejecuta un controlador de Express (que responde por `res`) con un CSV guardado, sin pasar por HTTP: devuelve {status, body}
const correr = async (controlador, buffer, user, nombre = 'flexible.csv') => {
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } };
  let error = null;
  await controlador({ file: { buffer, originalname: nombre, size: buffer.length, mimetype: 'text/csv' }, user }, res, (e) => { error = e; });
  if (error) throw error;
  return out;
};

const csvDe = async (id, estadosOk) => {
  const { rows: [f] } = await pool.query(`SELECT id, estado, csv FROM rpa_flexibles WHERE id = $1 AND is_active`, [id]);
  if (!f) throw new ErrorRpa(404, 'Exportación no encontrada');
  if (!estadosOk.includes(f.estado) || !f.csv) throw new ErrorRpa(409, `La exportación está en estado '${f.estado}'.`);
  return f.csv;
};

/** Análisis de impacto sin escribir nada (nuevos, actualizados, retirados y advertencias). */
export const analizar = async (id) => correr(importadores.preview, await csvDe(id, ['recibida']), null);

/** Aprobación: ejecuta el sync real con el archivo guardado. Solo pasa a `aplicada` si el importador respondió 200. */
export const aplicar = async (id, user) => {
  const cn = await pool.connect();
  try {
    // Reserva el paso para que dos personas no lo apliquen a la vez
    const { rows: [r] } = await cn.query(
      `UPDATE rpa_flexibles SET estado = 'aplicando', updated_at = NOW() WHERE id = $1 AND estado = 'recibida' AND is_active RETURNING csv, nombre_archivo`, [id]);
    if (!r) throw new ErrorRpa(409, 'Solo se aprueba una exportación recibida y pendiente de revisión.');
    let salida;
    try {
      salida = await correr(importadores.aplicar, r.csv, user, `${r.nombre_archivo || 'flexible.csv'} (agente RPA)`);
    } catch (e) {
      await cn.query(`UPDATE rpa_flexibles SET estado = 'recibida', updated_at = NOW() WHERE id = $1`, [id]);   // no se aplicó: sigue pendiente
      throw e;
    }
    if (salida.status >= 400) {
      await cn.query(`UPDATE rpa_flexibles SET estado = 'recibida', updated_at = NOW() WHERE id = $1`, [id]);   // el importador lo rechazó (guardas): sigue pendiente
      return { aplicada: false, ...salida };
    }
    await cn.query(
      `UPDATE rpa_flexibles SET estado = 'aplicada', revisada_por = $2, revisada_at = NOW(), resultado = $3, updated_at = NOW() WHERE id = $1`,
      [id, user.id, JSON.stringify(salida.body ?? {})]);
    return { aplicada: true, ...salida };
  } finally { cn.release(); }
};

export const rechazar = async (id, user, nota) => {
  const { rows: [f] } = await pool.query(
    `UPDATE rpa_flexibles SET estado = 'rechazada', revisada_por = $2, revisada_at = NOW(), nota = $3, updated_at = NOW()
      WHERE id = $1 AND estado = 'recibida' AND is_active RETURNING id`, [id, user.id, nota]);
  if (!f) throw new ErrorRpa(409, 'Solo se rechaza una exportación recibida y pendiente de revisión.');
  return obtener(id);
};

export const descargar = async (id) => {
  const { rows: [f] } = await pool.query(`SELECT nombre_archivo, csv FROM rpa_flexibles WHERE id = $1 AND is_active`, [id]);
  if (!f?.csv) throw new ErrorRpa(404, 'La exportación no tiene archivo');
  return f;
};
