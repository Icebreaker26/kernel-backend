import crypto from 'crypto';
import pool from '../../../db/database.js';
import logger from '../../../config/logger.js';
import { construirPayload, llaveCiudad, norm } from './payloadSolido.js';
import { consultaVigente } from '../../captacion/listas/consultas.js';

/**
 * Cola de cargas a SOLIDO.
 *
 * Ciclo de un job:
 *   requiere_datos ──(datos y equivalencias completos)──▶ pendiente ──▶ llenando ──▶ listo_para_aprobar
 *        ▲                                                   │ (ya está en SOLIDO)          │ (aprueba una persona)
 *        │                                                   ▼                              ▼
 *        └── (reevaluar)                                  ya_existe       aprobado ──▶ guardando ──▶ cargado
 *                                                                                                  └▶ revision_humana
 *
 *  · 'llenando' es en seco: el agente digita el formulario, toma capturas y NO pulsa Guardar.
 *  · 'guardando' solo se entrega a un agente con permite_guardar = true. Un fallo o caída en ese punto NUNCA se reintenta
 *    solo: pasa a revision_humana, porque puede que SOLIDO sí haya guardado (y reintentar crearía un duplicado).
 */

export class ErrorRpa extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const MAX_INTENTOS = 3;
const RETENCION_CAPTURAS_DIAS = 30;
const ABIERTOS = ['requiere_datos', 'pendiente', 'llenando', 'listo_para_aprobar', 'aprobado', 'guardando', 'revision_humana'];

export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

// ── Contexto y payload ────────────────────────────────────────────────────────

const cargarEquivalencias = async (cn = pool) => {
  const { rows } = await cn.query(`SELECT catalogo, texto_norm, codigo_solido FROM rpa_equivalencias WHERE is_active`);
  const mapa = new Map(rows.map((r) => [`${r.catalogo}|${r.texto_norm}`, r.codigo_solido]));
  return (catalogo, texto, depto) => {
    if (catalogo === 'ciudad') {
      return (depto && mapa.get(`ciudad|${llaveCiudad(texto, depto)}`)) || mapa.get(`ciudad|${norm(texto)}`) || null;
    }
    return mapa.get(`${catalogo}|${norm(texto)}`) || null;
  };
};

const cargarVinculacion = async (vinculacionId, cn = pool) => {
  const { rows: [r] } = await cn.query(
    `SELECT v.*, p.cedula, p.nombres, p.apellidos, p.celular, p.correo, p.empresa_codigo, p.asesor_uuid,
            e.nombre AS empresa_nombre, u.cedula AS asesor_cedula, u.nombre AS asesor_nombre
       FROM captacion_vinculaciones v
       JOIN captacion_prospectos p ON p.id = v.prospecto_id
       LEFT JOIN empresas e ON e.codigo = p.empresa_codigo
       LEFT JOIN global_usuarios u ON u.id = p.asesor_uuid
      WHERE v.id = $1`, [vinculacionId]);
  return r || null;
};

export const armarPayload = async (vinculacionId, cn = pool) => {
  const r = await cargarVinculacion(vinculacionId, cn);
  if (!r) throw new ErrorRpa(404, 'Vinculación no encontrada');
  const eq = await cargarEquivalencias(cn);
  const { payload, faltantes } = construirPayload({
    v: r,
    p: { cedula: r.cedula, nombres: r.nombres, apellidos: r.apellidos, celular: r.celular, correo: r.correo,
         empresa_codigo: r.empresa_codigo, empresa_nombre: r.empresa_nombre },
    asesorCedula: r.asesor_cedula,
    eq,
  });
  // Sin el visto bueno vigente del Oficial de Cumplimiento nada se entrega al agente (aunque el job ya existiera: si después se
  // corrigió la cédula o el nombre, la consulta deja de valer y el job vuelve a requiere_datos)
  const cump = await estadoCumplimiento(vinculacionId, cn);
  if (cump.estado !== 'validada') faltantes.unshift({ campo: 'cumplimiento', motivo: cump.estado, mensaje: cump.mensaje });
  return { payload, faltantes, cedula: String(r.cedula).trim(), vinculacion: r, cumplimiento: cump };
};

const yaEstaEnPadron = async (cedula, cn = pool) => {
  const { rows } = await cn.query(`SELECT 1 FROM asociados WHERE codigo = $1 LIMIT 1`, [cedula]);
  return rows.length > 0;
};

// ── Encolar / reevaluar / aprobar / cancelar ──────────────────────────────────

export const encolar = async (vinculacionId, usuarioId) => {
  const { payload: _p, faltantes, cedula, vinculacion } = await armarPayload(vinculacionId);
  if (!vinculacion.is_active) throw new ErrorRpa(409, 'La vinculación está inactiva');
  if (vinculacion.estado !== 'entregada') throw new ErrorRpa(409, 'Solo se cargan a SOLIDO las vinculaciones entregadas');
  await exigirCumplimiento(vinculacionId);

  if (await yaEstaEnPadron(cedula)) {
    const { rows: [job] } = await pool.query(
      `INSERT INTO rpa_jobs (vinculacion_id, cedula, estado, creado_por, terminado_at, resultado)
       VALUES ($1, $2, 'ya_existe', $3, NOW(), $4) RETURNING *`,
      [vinculacionId, cedula, usuarioId, JSON.stringify({ origen: 'padron_kernel' })]);
    await pool.query(`UPDATE captacion_vinculaciones SET solido_estado = 'ya_existe' WHERE id = $1`, [vinculacionId]);
    return job;
  }

  const estado = faltantes.length ? 'requiere_datos' : 'pendiente';
  try {
    const { rows: [job] } = await pool.query(
      `INSERT INTO rpa_jobs (vinculacion_id, cedula, estado, faltantes, creado_por)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [vinculacionId, cedula, estado, faltantes.length ? JSON.stringify(faltantes) : null, usuarioId]);
    await pool.query(`UPDATE captacion_vinculaciones SET solido_estado = 'en_cola' WHERE id = $1`, [vinculacionId]);
    return job;
  } catch (err) {
    if (err.code === '23505') throw new ErrorRpa(409, 'Esta vinculación ya tiene una carga en curso');
    throw err;
  }
};

const cargarJob = async (id, cn = pool) => {
  const { rows: [j] } = await cn.query(`SELECT * FROM rpa_jobs WHERE id = $1`, [id]);
  if (!j) throw new ErrorRpa(404, 'Job no encontrado');
  return j;
};

// Vuelve a revisar los datos de un job que esperaba equivalencias, o reabre uno fallido ANTES de guardar
export const reevaluar = async (id) => {
  const job = await cargarJob(id);
  if (!['requiere_datos', 'fallido'].includes(job.estado)) throw new ErrorRpa(409, `Un job en estado ${job.estado} no se reevalúa`);
  if (job.estado === 'fallido' && job.guardar_iniciado_at) {
    throw new ErrorRpa(409, 'Este job llegó a intentar guardar: verifica primero en SOLIDO y resuélvelo desde revisión');
  }
  const { faltantes } = await armarPayload(job.vinculacion_id);
  const estado = faltantes.length ? 'requiere_datos' : 'pendiente';
  try {
    const { rows: [j] } = await pool.query(
      `UPDATE rpa_jobs SET estado = $2, faltantes = $3, error = NULL, intentos = 0, terminado_at = NULL, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [id, estado, faltantes.length ? JSON.stringify(faltantes) : null]);
    return j;
  } catch (err) {
    if (err.code === '23505') throw new ErrorRpa(409, 'Esta vinculación ya tiene otra carga en curso');
    throw err;
  }
};

export const aprobar = async (id, usuarioId) => {
  const { rows: [j] } = await pool.query(
    `UPDATE rpa_jobs SET estado = 'aprobado', aprobado_por = $2, aprobado_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND estado = 'listo_para_aprobar' RETURNING *`, [id, usuarioId]);
  if (!j) throw new ErrorRpa(409, 'Solo se aprueba un job que ya fue llenado en seco y espera revisión');
  return j;
};

export const cancelar = async (id) => {
  const { rows: [j] } = await pool.query(
    `UPDATE rpa_jobs SET estado = 'cancelado', terminado_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND estado IN ('requiere_datos','pendiente','listo_para_aprobar','aprobado','fallido') RETURNING *`, [id]);
  if (!j) throw new ErrorRpa(409, 'Un job en proceso no se puede cancelar: pausa el agente y espera a que termine');
  await pool.query(`UPDATE captacion_vinculaciones SET solido_estado = NULL WHERE id = $1 AND solido_estado = 'en_cola'`, [j.vinculacion_id]);
  return j;
};

// Una persona verificó en SOLIDO qué pasó con un job que quedó en revisión
export const resolverRevision = async (id, { resultado, nota }, usuarioId) => {
  const job = await cargarJob(id);
  if (job.estado !== 'revision_humana') throw new ErrorRpa(409, 'Solo se resuelven jobs en revisión');
  const cargado = resultado === 'cargado';
  const { rows: [j] } = await pool.query(
    `UPDATE rpa_jobs SET estado = $2, terminado_at = NOW(), updated_at = NOW(),
            resultado = COALESCE(resultado, '{}'::jsonb) || $3::jsonb
      WHERE id = $1 RETURNING *`,
    [id, cargado ? 'cargado' : 'cancelado', JSON.stringify({ resolucion: { resultado, nota, por: usuarioId, at: new Date().toISOString() } })]);
  await pool.query(
    `UPDATE captacion_vinculaciones SET solido_estado = $2, solido_cargado_at = $3 WHERE id = $1`,
    [job.vinculacion_id, cargado ? 'cargado' : null, cargado ? new Date() : null]);
  return j;
};

// ── Lado del agente ───────────────────────────────────────────────────────────

export const latido = async (agente, { version, huella_ui, sesion_bloqueada }) => {
  await pool.query(
    `UPDATE rpa_agentes SET ultimo_latido = NOW(), version = COALESCE($2, version), huella_ui = COALESCE($3, huella_ui),
            sesion_bloqueada = COALESCE($4, sesion_bloqueada), sesion_at = CASE WHEN $4::boolean IS NULL THEN sesion_at ELSE NOW() END,
            updated_at = NOW()
      WHERE id = $1`, [agente.id, version ?? null, huella_ui ?? null, sesion_bloqueada ?? null]);
  // Las capturas llevan datos personales: no se guardan más de RETENCION_CAPTURAS_DIAS
  await pool.query(`DELETE FROM rpa_capturas WHERE created_at < NOW() - make_interval(days => $1)`, [RETENCION_CAPTURAS_DIAS]);
  const { rows: [a] } = await pool.query(`SELECT pausado, permite_guardar FROM rpa_agentes WHERE id = $1`, [agente.id]);
  return { pausado: a.pausado, permite_guardar: a.permite_guardar };
};

// Trabajos que este agente dejó a medias (se reinició o se cayó)
const recuperarAbandonados = async (agenteId, cn) => {
  await cn.query(
    `WITH r AS (
       UPDATE rpa_jobs SET estado = 'revision_humana', updated_at = NOW(),
              error = 'El agente se reinició mientras guardaba: verifica en SOLIDO si el asociado quedó creado'
        WHERE agente_id = $1 AND estado = 'guardando' RETURNING vinculacion_id)
     UPDATE captacion_vinculaciones SET solido_estado = 'revision' WHERE id IN (SELECT vinculacion_id FROM r)`, [agenteId]);
  // Llenar en seco no deja rastro en SOLIDO: es seguro volver a intentarlo
  await cn.query(
    `UPDATE rpa_jobs SET estado = CASE WHEN intentos >= $2 THEN 'fallido' ELSE 'pendiente' END,
            error = CASE WHEN intentos >= $2 THEN 'El agente se reinició varias veces mientras llenaba' ELSE error END,
            terminado_at = CASE WHEN intentos >= $2 THEN NOW() END, updated_at = NOW()
      WHERE agente_id = $1 AND estado = 'llenando'`, [agenteId, MAX_INTENTOS]);
};

export const reclamar = async (agente) => {
  const cn = await pool.connect();
  try {
    await cn.query('BEGIN');
    await recuperarAbandonados(agente.id, cn);

    const { rows: [a] } = await cn.query(`SELECT pausado, permite_guardar FROM rpa_agentes WHERE id = $1 FOR UPDATE`, [agente.id]);
    if (a.pausado) { await cn.query('COMMIT'); return null; }

    // Máximo 5 vueltas: si un job resulta inválido (faltantes nuevos, ya en el padrón) se aparta y se toma el siguiente
    for (let i = 0; i < 5; i++) {
      const { rows: [job] } = await cn.query(
        `SELECT * FROM rpa_jobs
          WHERE is_active AND (estado = 'pendiente' OR (estado = 'aprobado' AND $1))
          ORDER BY (estado = 'aprobado') DESC, created_at
          LIMIT 1 FOR UPDATE SKIP LOCKED`, [a.permite_guardar]);
      if (!job) break;

      const { payload, faltantes } = await armarPayload(job.vinculacion_id, cn);
      if (faltantes.length) {
        await cn.query(`UPDATE rpa_jobs SET estado = 'requiere_datos', faltantes = $2, updated_at = NOW() WHERE id = $1`,
          [job.id, JSON.stringify(faltantes)]);
        continue;
      }
      if (await yaEstaEnPadron(job.cedula, cn)) {
        await cn.query(`UPDATE rpa_jobs SET estado = 'ya_existe', terminado_at = NOW(), resultado = $2, updated_at = NOW() WHERE id = $1`,
          [job.id, JSON.stringify({ origen: 'padron_kernel' })]);
        await cn.query(`UPDATE captacion_vinculaciones SET solido_estado = 'ya_existe' WHERE id = $1`, [job.vinculacion_id]);
        continue;
      }

      const guardar = job.estado === 'aprobado';
      await cn.query(
        guardar
          ? `UPDATE rpa_jobs SET estado = 'guardando', agente_id = $2, guardar_iniciado_at = NOW(), updated_at = NOW() WHERE id = $1`
          : `UPDATE rpa_jobs SET estado = 'llenando', agente_id = $2, intentos = intentos + 1, updated_at = NOW() WHERE id = $1`,
        [job.id, agente.id]);
      await cn.query('COMMIT');
      return { id: job.id, fase: guardar ? 'guardar' : 'llenar', cedula: job.cedula, payload };
    }
    await cn.query('COMMIT');
    return null;
  } catch (err) {
    await cn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cn.release();
  }
};

export const registrarResultado = async (agente, jobId, body) => {
  const cn = await pool.connect();
  try {
    await cn.query('BEGIN');
    const { rows: [job] } = await cn.query(`SELECT * FROM rpa_jobs WHERE id = $1 AND agente_id = $2 FOR UPDATE`, [jobId, agente.id]);
    if (!job) throw new ErrorRpa(404, 'Job no encontrado para este agente');
    if (!['llenando', 'guardando'].includes(job.estado)) throw new ErrorRpa(409, `El job ya no está en proceso (${job.estado})`);

    const guardando = job.estado === 'guardando';
    const { resultado } = body;
    const coherente = guardando
      ? ['guardado_ok', 'guardado_con_diferencias', 'guardado_incierto', 'fallido'].includes(resultado)
      : ['llenado_ok', 'ya_existe', 'fallido'].includes(resultado);
    if (!coherente) throw new ErrorRpa(409, `El resultado '${resultado}' no corresponde a un job en '${job.estado}'`);

    let estado; let error = body.error ?? null;
    switch (resultado) {
      case 'llenado_ok':               estado = 'listo_para_aprobar'; break;
      case 'ya_existe':                estado = 'ya_existe'; break;
      case 'guardado_ok':              estado = 'cargado'; break;
      case 'guardado_con_diferencias': estado = 'revision_humana'; error = error ?? 'Lo guardado en SOLIDO no coincide con Kernel'; break;
      case 'guardado_incierto':        estado = 'revision_humana'; error = error ?? 'No se pudo confirmar el guardado'; break;
      default:                         // fallido
        if (guardando) estado = 'revision_humana';                               // tras Guardar jamás se reintenta solo
        else estado = body.reintentable && job.intentos < MAX_INTENTOS ? 'pendiente' : 'fallido';
    }
    const terminal = ['cargado', 'ya_existe', 'fallido'].includes(estado);

    const { rows: [j] } = await cn.query(
      `UPDATE rpa_jobs SET estado = $2, error = $3, resultado = $4, terminado_at = $5, updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [jobId, estado, error, body.detalle ? JSON.stringify(body.detalle) : null, terminal ? new Date() : null]);

    for (const c of body.capturas) {
      await cn.query(`INSERT INTO rpa_capturas (job_id, etiqueta, mime, datos) VALUES ($1, $2, $3, $4)`,
        [jobId, c.etiqueta, c.mime, Buffer.from(c.base64, 'base64')]);
    }

    if (estado === 'cargado') {
      await cn.query(`UPDATE captacion_vinculaciones SET solido_estado = 'cargado', solido_cargado_at = NOW() WHERE id = $1`, [job.vinculacion_id]);
    } else if (estado === 'ya_existe') {
      await cn.query(`UPDATE captacion_vinculaciones SET solido_estado = 'ya_existe' WHERE id = $1`, [job.vinculacion_id]);
    } else if (estado === 'revision_humana') {
      await cn.query(`UPDATE captacion_vinculaciones SET solido_estado = 'revision' WHERE id = $1`, [job.vinculacion_id]);
    }

    if (body.fatal) {
      await cn.query(`UPDATE rpa_agentes SET pausado = true, updated_at = NOW() WHERE id = $1`, [agente.id]);
      logger.warn(`rpa: agente ${agente.nombre} pausado por error fatal: ${error ?? resultado}`);
    }
    await cn.query('COMMIT');
    return j;
  } catch (err) {
    await cn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cn.release();
  }
};

// ── Visto bueno del Oficial de Cumplimiento ───────────────────────────────────

const MENSAJES_CUMPLIMIENTO = {
  validada: 'El Oficial de Cumplimiento dio el visto bueno.',
  observada: 'El Oficial de Cumplimiento dejó observaciones en la consulta: hay que resolverlas y consultar de nuevo.',
  pendiente_validacion: 'La consulta en listas está hecha y espera el visto bueno del Oficial de Cumplimiento.',
  desactualizada: 'Cambió la cédula o el nombre después de la consulta en listas: hay que consultar de nuevo y esperar el visto bueno.',
  sin_consulta: 'Falta la consulta en listas y el visto bueno del Oficial de Cumplimiento.',
};

/** Estado de cumplimiento de una vinculación: solo 'validada' habilita subirla a SOLIDO. */
export const estadoCumplimiento = async (vinculacionId, cn = pool) => {
  const respuesta = (estado, extra = {}) => ({ estado, mensaje: MENSAJES_CUMPLIMIENTO[estado], ...extra });
  const vigente = await consultaVigente(vinculacionId);
  if (vigente) return respuesta('validada', { validada_at: vigente.validada_at });
  const { rows: [c] } = await cn.query(
    `SELECT c.estado, (c.cedula = p.cedula AND c.nombres = p.nombres AND c.apellidos = p.apellidos) AS igual
       FROM captacion_consultas_listas c
       JOIN captacion_vinculaciones v ON v.id = c.vinculacion_id
       JOIN captacion_prospectos p ON p.id = v.prospecto_id
      WHERE c.vinculacion_id = $1 AND c.estado <> 'anulada'
      ORDER BY c.created_at DESC LIMIT 1`, [vinculacionId]);
  if (!c) return respuesta('sin_consulta');
  if (c.estado === 'validada' && !c.igual) return respuesta('desactualizada');
  if (c.estado === 'observada') return respuesta('observada');
  if (c.estado === 'cerrada') return respuesta(c.igual ? 'pendiente_validacion' : 'desactualizada');
  return respuesta('sin_consulta');   // en_curso: la consulta aún no se cierra
};

/** Compuerta del servidor: sin visto bueno vigente del Oficial de Cumplimiento no se sube nada a SOLIDO. */
export const exigirCumplimiento = async (vinculacionId) => {
  const cump = await estadoCumplimiento(vinculacionId);
  if (cump.estado !== 'validada') throw new ErrorRpa(409, cump.mensaje, { cumplimiento: cump.estado });
  return cump;
};

// ── Estado del agente (activo / trabajando / sesión bloqueada / pausado / apagado) ─────────────────────────────────────

const LATIDO_MAX_S = 360;      // el agente consulta cada 30 s; un llenado tarda 2-3 min sin latidos: 6 min de margen
const ORDEN_ESTADO = { activo: 0, trabajando: 1, bloqueado: 2, pausado: 3, apagado: 4 };

const derivarEstado = (a) => {
  const sinLatido = a.segundos_sin_latido == null || a.segundos_sin_latido > LATIDO_MAX_S;
  if (sinLatido && !a.trabajando) return 'apagado';          // PC apagado, sin internet o agente detenido
  if (a.pausado) return 'pausado';                            // detenido desde Kernel o por un error fatal
  if (a.trabajando) return 'trabajando';
  if (a.sesion_bloqueada) return 'bloqueado';                 // en línea, pero la pantalla de Windows está bloqueada
  return 'activo';
};

export const estadoAgentes = async () => {
  const { rows } = await pool.query(
    `SELECT a.id, a.nombre, a.pausado, a.permite_guardar, a.ultimo_latido, a.version, a.huella_ui, a.sesion_bloqueada, a.sesion_at, a.created_at,
            EXTRACT(EPOCH FROM (NOW() - a.ultimo_latido))::int AS segundos_sin_latido,
            EXISTS (SELECT 1 FROM rpa_jobs j WHERE j.agente_id = a.id AND j.estado IN ('llenando', 'guardando')
                       AND j.updated_at > NOW() - INTERVAL '15 minutes') AS trabajando
       FROM rpa_agentes a WHERE a.is_active ORDER BY a.nombre`);
  return rows.map((a) => ({ ...a, estado: derivarEstado(a), en_linea: a.segundos_sin_latido != null && a.segundos_sin_latido <= LATIDO_MAX_S }));
};

/** Resumen para quien no administra agentes (el asesor): el mejor estado entre los agentes, sin datos internos. */
export const resumenAgente = (agentes) => {
  if (!agentes.length) return { estado: 'sin_agente', segundos_sin_latido: null };
  const mejor = [...agentes].sort((x, y) => ORDEN_ESTADO[x.estado] - ORDEN_ESTADO[y.estado])[0];
  return { estado: mejor.estado, segundos_sin_latido: mejor.segundos_sin_latido };
};

// ── Estado de una vinculación para el botón "Subir a SOLIDO" ──────────────────

export const estadoVinculacion = async (vinculacionId) => {
  const r = await cargarVinculacion(vinculacionId);
  if (!r) throw new ErrorRpa(404, 'Vinculación no encontrada');
  const [cumplimiento, agentes, { rows: [job] }] = await Promise.all([
    estadoCumplimiento(vinculacionId),
    estadoAgentes(),
    pool.query(
      `SELECT id, estado, error, faltantes, intentos, created_at, updated_at, terminado_at, aprobado_at
         FROM rpa_jobs WHERE vinculacion_id = $1 AND is_active ORDER BY created_at DESC LIMIT 1`, [vinculacionId]),
  ]);
  const abierto = job && ABIERTOS.includes(job.estado) && job.estado !== 'requiere_datos';   // requiere_datos se reintenta desde el mismo botón
  const yaCargado = ['cargado', 'ya_existe'].includes(job?.estado) || r.solido_estado === 'cargado';
  let motivo = null;
  if (r.estado !== 'entregada') motivo = 'La solicitud debe estar entregada.';
  else if (yaCargado) motivo = 'El asociado ya está en SOLIDO.';
  else if (abierto) motivo = 'Ya hay una carga en curso.';
  else if (cumplimiento.estado !== 'validada') motivo = cumplimiento.mensaje;
  return {
    reintento: job?.estado === 'requiere_datos',
    vinculacion: { estado: r.estado, solido_estado: r.solido_estado, solido_cargado_at: r.solido_cargado_at, asesor_uuid: r.asesor_uuid },
    cumplimiento,
    job: job ?? null,
    agente: resumenAgente(agentes),
    puede_subir: motivo === null,
    motivo,
  };
};

// ── Cédula de los asesores (SOLIDO la pide como "Asesor") ─────────────────────

const tokens = (s) => norm(s).split(' ').filter((t) => t.length > 1);

// Propone, por nombre, el asociado que corresponde a cada empleado sin cédula. No asigna nada: una persona confirma.
export const sugerirCedulas = async () => {
  const [{ rows: usuarios }, { rows: asociados }] = await Promise.all([
    pool.query(`SELECT id, nombre, email FROM global_usuarios WHERE is_active AND cedula IS NULL ORDER BY nombre`),
    pool.query(`SELECT codigo, nombre, apellido FROM asociados WHERE is_active`),
  ]);
  const base = asociados.map((a) => ({ ...a, t: new Set(tokens(`${a.nombre} ${a.apellido}`)) }));
  return usuarios.map((u) => {
    const tu = tokens(u.nombre);
    const exactos = base.filter((a) => a.t.size === tu.length && tu.every((t) => a.t.has(t)));
    // Parcial: el usuario escribió menos nombres que los que tiene el asociado
    const parciales = exactos.length ? [] : base.filter((a) => tu.length >= 2 && tu.every((t) => a.t.has(t)));
    const candidatos = (exactos.length ? exactos : parciales).slice(0, 5)
      .map((a) => ({ codigo: a.codigo, nombre: a.nombre, apellido: a.apellido }));
    const coincidencia = !candidatos.length ? 'ninguna'
      : candidatos.length > 1 ? 'multiple'
      : exactos.length ? 'exacta' : 'parcial';
    return { usuario_id: u.id, nombre: u.nombre, email: u.email, coincidencia, candidatos };
  });
};

export { ABIERTOS, MAX_INTENTOS };
