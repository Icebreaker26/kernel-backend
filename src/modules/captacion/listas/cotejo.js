import pool from '../../../db/database.js';
import { PARAMETROS_COTEJO, normalizar, palabras, soloDigitos, compararPalabras } from './normalizar.js';

// Fuentes que solo se cotejan por cédula exacta (buscar por nombre en decenas de miles de personas solo genera homónimos)
const SOLO_DOCUMENTO = new Set(['PEP_SIGEP', 'SIRI', 'CGR_BOLETIN']);

let cache = null;   // { firma, entradas[], porPalabra: Map, porPrefijo: Map, porDoc: Map }

export const invalidarCache = () => { cache = null; };

const construirCache = async () => {
  const { rows: versiones } = await pool.query(`SELECT id, fuente FROM listas_versiones WHERE activa ORDER BY fuente`);
  const firma = versiones.map((v) => `${v.fuente}:${v.id}`).join('|');
  if (cache?.firma === firma) return cache;
  const entradas = [];
  const porPalabra = new Map();
  const porPrefijo = new Map();
  const porDoc = new Map();
  if (versiones.length) {
    const { rows } = await pool.query(
      `SELECT e.fuente, e.ref, e.tipo, e.nombre, e.alias, e.documentos, e.nacimiento, e.nacionalidades, e.detalle
         FROM listas_entradas e JOIN listas_versiones v ON v.id = e.version_id AND v.activa`
    );
    for (const r of rows) {
      const nombres = [r.nombre, ...r.alias].filter(Boolean);
      const e = { ...r, nombres, tokens: nombres.map(palabras) };
      const idx = entradas.push(e) - 1;
      for (const doc of r.documentos) porDoc.set(doc, [...(porDoc.get(doc) || []), idx]);
      if (SOLO_DOCUMENTO.has(r.fuente)) continue;
      const vistos = new Set();
      for (const t of e.tokens.flat()) {
        if (t.length < 3 || vistos.has(t)) continue;
        vistos.add(t);
        (porPalabra.get(t) || porPalabra.set(t, []).get(t)).push(idx);
        const pre = t.slice(0, 4);
        if (pre.length === 4) { const l = porPrefijo.get(pre) || porPrefijo.set(pre, new Set()).get(pre); l.add(idx); }
      }
    }
  }
  cache = { firma, entradas, porPalabra, porPrefijo, porDoc };
  return cache;
};

const anioDe = (s) => (String(s).match(/(1[89]\d\d|20\d\d)/) || [])[1] || null;

/**
 * Cota a una persona contra las listas activas. Devuelve las posibles coincidencias con su motivo y una SUGERENCIA (descartar/revisar);
 * la decisión siempre es de una persona: el sistema nunca descarta ni confirma solo.
 * @param {{cedula: string, nombres: string, apellidos: string, nacimiento?: string|Date|null}} p
 */
export const cotejar = async ({ cedula, nombres, apellidos, nacimiento = null }) => {
  const c = await construirCache();
  const doc = soloDigitos(cedula);
  const qTokens = palabras(`${nombres} ${apellidos}`);
  const anioNac = nacimiento ? anioDe(nacimiento instanceof Date ? nacimiento.toISOString() : nacimiento) : null;
  const resultado = new Map();   // idx → coincidencia

  // 1. Cédula exacta: coincidencia fuerte en cualquier lista
  if (doc.length >= 5) {
    for (const idx of c.porDoc.get(doc) || []) {
      const e = c.entradas[idx];
      resultado.set(idx, { ...describir(e), score: 1, tipo: 'documento', motivo: 'La cédula es la misma', sugerencia: 'revisar', motivo_sugerencia: 'Misma cédula: coincidencia fuerte' });
    }
  }

  // 2. Nombre (solo listas de sanciones): se prueban las entradas que comparten alguna palabra o el mismo inicio
  if (qTokens.length >= 2) {
    const candidatos = new Set();
    for (const t of qTokens) {
      for (const i of c.porPalabra.get(t) || []) candidatos.add(i);
      if (t.length >= 4) for (const i of c.porPrefijo.get(t.slice(0, 4)) || []) candidatos.add(i);
    }
    for (const idx of candidatos) {
      if (resultado.has(idx)) continue;
      const e = c.entradas[idx];
      let mejor = { score: 0 };
      let nombreCoincidente = e.nombre;
      e.tokens.forEach((tk, k) => {
        const r = compararPalabras(qTokens, tk);
        if (r.score > mejor.score) { mejor = r; nombreCoincidente = e.nombres[k]; }
      });
      if (mejor.score < PARAMETROS_COTEJO.umbral_posible) continue;
      const otraCedula = e.documentos.length > 0 && doc && !e.documentos.includes(doc);
      const otroAnio = anioNac && e.nacimiento.length > 0 && e.nacimiento.map(anioDe).filter(Boolean).length > 0
        && !e.nacimiento.map(anioDe).includes(anioNac);
      let sugerencia = 'revisar';
      let motivoSug = mejor.parcial ? 'La persona contiene todas las palabras del nombre de la lista' : 'Nombre parecido';
      if (otraCedula) { sugerencia = 'descartar'; motivoSug = `Probable homónimo: la lista trae otra cédula (${e.documentos.join(', ')})`; }
      else if (otroAnio) { sugerencia = 'descartar'; motivoSug = `Probable homónimo: la lista trae otro año de nacimiento (${e.nacimiento.join(', ')})`; }
      resultado.set(idx, {
        ...describir(e), nombre_coincidente: nombreCoincidente, score: Math.round(mejor.score * 1000) / 1000, tipo: 'nombre',
        motivo: mejor.score >= PARAMETROS_COTEJO.umbral_fuerte ? 'Nombre casi idéntico' : 'Nombre parecido',
        sugerencia, motivo_sugerencia: motivoSug,
      });
    }
  }

  const lista = [...resultado.values()].sort((a, b) => b.score - a.score || (a.sugerencia === 'revisar' ? -1 : 1)).slice(0, 60);
  return lista.map((x, i) => ({ id: String(i + 1), ...x, decision: null, decision_motivo: null }));
};

const describir = (e) => ({
  fuente: e.fuente, ref: e.ref, entidad_tipo: e.tipo, nombre: e.nombre, nombre_coincidente: e.nombre, alias: e.alias.slice(0, 6),
  documentos: e.documentos, nacimiento: e.nacimiento, nacionalidades: e.nacionalidades, detalle: e.detalle,
});

/** Estado del PEP/antecedentes por cédula: PEP vigente si no tiene fecha de desvinculación o esta fue hace menos de 2 años (Decreto 830 de 2021). */
export const vigenciaPep = (detalle) => {
  const desv = String(detalle?.fecha_desvinculacion || '').trim();
  if (!desv) return { vigente: true, hasta: null };
  const [d, m, a] = desv.split(/[\/\-]/).map(Number);
  const fecha = a > 31 ? new Date(a, m - 1, d) : new Date(d, m - 1, a);
  if (Number.isNaN(fecha.getTime())) return { vigente: null, hasta: null };
  const hasta = new Date(fecha);
  hasta.setFullYear(hasta.getFullYear() + 2);
  return { vigente: hasta > new Date(), hasta: hasta.toISOString().slice(0, 10) };
};

export { normalizar };
