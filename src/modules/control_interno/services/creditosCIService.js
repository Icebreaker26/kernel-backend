import pool from '../../../db/database.js';
import { ErrorNegocio } from '../../creditos/http.js';
import { LIMITE_LISTA, filtrosLista } from '../../creditos/services/creditoService.js';

/**
 * Bandeja de Control Interno para los créditos. Cada pestaña es un momento del crédito visto desde Control Interno:
 *   por_revisar  → Cartera lo completó y espera la validación
 *   en_tesoreria → Control Interno lo aprobó y espera el pago
 *   pagados      → Tesorería ya lo pagó
 *   devueltos    → Control Interno lo devolvió (a Cartera o al asesor) y aún no vuelve a llegar completado
 */
const ESTADO_TAB = {
  por_revisar: `s.estado = 'completada'`,
  en_tesoreria: `s.estado = 'en_tesoreria'`,
  pagados: `s.estado = 'pagada'`,
  devueltos: `(s.estado IN ('recibida', 'devuelta') AND rv.decision = 'devuelta')`,
};
const TODAS = `(${Object.values(ESTADO_TAB).join(' OR ')})`;
const norm = (col) => `upper(regexp_replace(coalesce(${col}, ''), '[\\s.-]', '', 'g'))`;

const FROM_CI = `
  FROM credito_solicitudes s
  JOIN asociados a ON a.codigo = s.asociado_codigo
  JOIN empresas e ON e.codigo = s.empresa_codigo
  JOIN credito_categorias c ON c.id = s.categoria_id
  JOIN global_usuarios u ON u.id = s.asesor_uuid
  LEFT JOIN credito_cierre cc ON cc.solicitud_id = s.id
  LEFT JOIN global_usuarios uc ON uc.id = s.completada_por
  LEFT JOIN LATERAL (
    SELECT r.decision, r.destino, r.motivo, r.created_at, ur.nombre AS revisor
      FROM credito_revisiones_ci r LEFT JOIN global_usuarios ur ON ur.id = r.revisor_uuid
     WHERE r.solicitud_id = s.id ORDER BY r.created_at DESC LIMIT 1
  ) rv ON true`;

const COLUMNAS_CI = `
  s.id, s.radicado, s.asociado_codigo, (a.nombre || ' ' || a.apellido) AS asociado_nombre, e.nombre AS empresa_nombre, c.nombre AS categoria,
  s.valor_solicitado, s.monto_desembolso, s.modalidad_firma, s.forma_desembolso, s.estado, s.completada_at, uc.nombre AS completada_por_nombre, u.nombre AS asesor_nombre,
  cc.con_aval, cc.aval_porcentaje, cc.aval_valor, cc.firma_electronica_valor, cc.desembolso_neto,
  (s.forma_desembolso = 'transferencia' AND cc.titular_documento IS NOT NULL AND ${norm('cc.titular_documento')} <> ${norm('s.asociado_codigo')}) AS titular_tercero,
  rv.decision AS revision_decision, rv.destino AS revision_destino, rv.motivo AS revision_motivo, rv.created_at AS revision_at, rv.revisor AS revision_por,
  GREATEST(0, ((NOW() AT TIME ZONE 'America/Bogota')::date - (coalesce(s.completada_at, s.updated_at) AT TIME ZONE 'America/Bogota')::date)) AS dias`;

const ORDEN_CI = {
  fecha: 's.completada_at', valor: 's.valor_solicitado', desembolso: 'cc.desembolso_neto', dias: 's.completada_at',
  asociado: "(a.nombre || ' ' || a.apellido)", radicado: 's.radicado',
};

/** WHERE común: los filtros de la lista de créditos (sin alcance por asesor) y, aparte, la antigüedad en Control Interno */
const dondeCI = async (f, { tab }) => {
  const { dias, ...resto } = f;
  const { where, params } = await filtrosLista(null, resto, { sinEstado: true, sinAlcance: true });
  const cond = [where, tab === 'todas' ? TODAS : ESTADO_TAB[tab]];
  if (dias != null) {
    params.push(dias);
    cond.push(`GREATEST(0, ((NOW() AT TIME ZONE 'America/Bogota')::date - (coalesce(s.completada_at, s.updated_at) AT TIME ZONE 'America/Bogota')::date)) >= $${params.length}`);
  }
  return { where: cond.join(' AND '), params };
};

export const listarCI = async (f = {}) => {
  const tab = f.tab ?? 'por_revisar';
  if (tab !== 'todas' && !ESTADO_TAB[tab]) throw new ErrorNegocio(400, 'Pestaña inválida');
  const { where, params } = await dondeCI(f, { tab });
  const columna = ORDEN_CI[f.orden];
  // "dias" ordena por antigüedad: la fecha más vieja es la de más días
  const dir = f.orden === 'dias' ? (f.dir === 'asc' ? 'DESC' : 'ASC') : (f.dir === 'asc' ? 'ASC' : 'DESC');
  // Sin orden elegido: lo que espera revisión, lo más antiguo primero (FIFO); lo demás, lo más reciente primero
  const orden = columna ? `${columna} ${dir}` : (tab === 'por_revisar' ? 's.completada_at ASC' : 's.completada_at DESC');
  const { rows } = await pool.query(`SELECT ${COLUMNAS_CI} ${FROM_CI} WHERE ${where} ORDER BY ${orden}, s.id LIMIT ${LIMITE_LISTA}`, params);
  return rows;
};

/** Conteo y desembolso neto por pestaña con los mismos filtros (sin pestaña): contadores de las pestañas y columnas del tablero */
export const resumenCI = async (f = {}) => {
  const { where, params } = await dondeCI(f, { tab: 'todas' });
  const { rows } = await pool.query(
    `SELECT CASE WHEN s.estado = 'completada' THEN 'por_revisar' WHEN s.estado = 'en_tesoreria' THEN 'en_tesoreria' WHEN s.estado = 'pagada' THEN 'pagados' ELSE 'devueltos' END AS tab,
            COUNT(*)::int AS n, COALESCE(SUM(COALESCE(cc.desembolso_neto, s.valor_solicitado)), 0)::numeric AS valor
       ${FROM_CI} WHERE ${where} GROUP BY 1`, params);
  return { limite: LIMITE_LISTA, tabs: rows.map((r) => ({ tab: r.tab, n: r.n, valor: Number(r.valor) })) };
};

/** Empresas, asesores y categorías presentes en la bandeja, para armar los filtros */
export const opcionesCI = async () => {
  const { where, params } = await dondeCI({}, { tab: 'todas' });
  const [{ rows: empresas }, { rows: asesores }, { rows: categorias }] = await Promise.all([
    pool.query(`SELECT DISTINCT e.codigo, e.nombre ${FROM_CI} WHERE ${where} ORDER BY e.nombre`, params),
    pool.query(`SELECT DISTINCT u.id, u.nombre ${FROM_CI} WHERE ${where} ORDER BY u.nombre`, params),
    pool.query(`SELECT DISTINCT c.id, c.nombre ${FROM_CI} WHERE ${where} ORDER BY c.nombre`, params),
  ]);
  return { empresas, asesores, categorias };
};
