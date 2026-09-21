import { parse as parseCsv } from 'csv-parse/sync';
import { XMLParser } from 'fast-xml-parser';
import { soloDigitos } from './normalizar.js';

/**
 * Lectores de cada lista. Todos devuelven { publicada, entradas[] } con entradas normalizadas:
 *   { ref, tipo: 'persona'|'entidad', nombre, alias[], documentos[] (solo dígitos de cédula), nacimiento[], nacionalidades[], detalle{} }
 * Los formatos se verificaron con archivos reales (2026-09-20); si una fuente cambia su estructura, el lector lanza error y esa
 * fuente queda con estado "error" sin reemplazar la versión activa.
 */

const arr = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : [v]);
const texto = (v) => (v === undefined || v === null ? '' : String(v).trim());
const unicos = (a) => [...new Set(a.filter(Boolean))];
const sinVacios = (s) => (s === '-0-' ? '' : s);

// Cédulas colombianas: los textos de las listas traen "Cedula No. 123.456 (Colombia)"
const cedulasEnTexto = (t) => {
  const out = [];
  for (const m of String(t).matchAll(/c[eé]dula(?:\s+de\s+ciudadan[ií]a)?(?:\s+No\.?|\s+#)?\s*[:#]?\s*([\d][\d.,\-\s]{3,15})/gi)) {
    const d = soloDigitos(m[1]);
    if (d.length >= 5 && d.length <= 12) out.push(d);
  }
  return out;
};

// ── ONU: lista consolidada del Consejo de Seguridad (XML) ────────────────────
export const parseOnu = (xml) => {
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true }).parse(xml);
  const raiz = doc.CONSOLIDATED_LIST;
  if (!raiz) throw new Error('ONU: no se encontró CONSOLIDATED_LIST');
  const entradas = [];

  for (const p of arr(raiz.INDIVIDUALS?.INDIVIDUAL)) {
    const nombre = [p.FIRST_NAME, p.SECOND_NAME, p.THIRD_NAME, p.FOURTH_NAME].map(texto).filter(Boolean).join(' ');
    const docs = arr(p.INDIVIDUAL_DOCUMENT);
    const documentos = [];
    for (const d of docs) {
      const num = texto(d.NUMBER);
      if (/c[eé]dula/i.test(num) || (/colombia/i.test(texto(d.ISSUING_COUNTRY)) && /national identification|cedula/i.test(texto(d.TYPE_OF_DOCUMENT) + ' ' + num))) {
        const digitos = cedulasEnTexto(num).concat(/^\D*[\d.\s]+\D*$/.test(num) ? [soloDigitos(num)] : []);
        documentos.push(...digitos.filter((x) => x.length >= 5));
      }
    }
    entradas.push({
      ref: texto(p.DATAID),
      tipo: 'persona',
      nombre,
      alias: unicos(arr(p.INDIVIDUAL_ALIAS).map((a) => texto(a.ALIAS_NAME))),
      documentos: unicos(documentos),
      nacimiento: unicos(arr(p.INDIVIDUAL_DATE_OF_BIRTH).map((d) => texto(d.DATE || d.YEAR || d.FROM_YEAR))),
      nacionalidades: unicos(arr(p.NATIONALITY).flatMap((n) => arr(n.VALUE).map(texto))),
      detalle: {
        programa: texto(p.UN_LIST_TYPE), referencia: texto(p.REFERENCE_NUMBER), fecha_lista: texto(p.LISTED_ON),
        comentarios: texto(p.COMMENTS1).slice(0, 600),
      },
    });
  }
  for (const e of arr(raiz.ENTITIES?.ENTITY)) {
    entradas.push({
      ref: texto(e.DATAID), tipo: 'entidad', nombre: texto(e.FIRST_NAME),
      alias: unicos(arr(e.ENTITY_ALIAS).map((a) => texto(a.ALIAS_NAME))), documentos: [], nacimiento: [], nacionalidades: [],
      detalle: { programa: texto(e.UN_LIST_TYPE), referencia: texto(e.REFERENCE_NUMBER), fecha_lista: texto(e.LISTED_ON) },
    });
  }
  return { publicada: texto(raiz['@_dateGenerated']), entradas: entradas.filter((e) => e.nombre) };
};

// ── OFAC: SDN o Consolidada (CSV sin encabezado) + su archivo de alias ───────
// SDN/CONS_PRIM: ent_num, nombre, tipo, programa, título, …, remarks(col 12). ALT/CONS_ALT: ent_num, alt_num, tipo, alias, remarks.
export const parseOfac = (csvPrincipal, csvAlias) => {
  const filas = parseCsv(csvPrincipal, { relax_column_count: true, relax_quotes: true, skip_empty_lines: true });
  const alias = new Map();
  for (const f of parseCsv(csvAlias || '', { relax_column_count: true, relax_quotes: true, skip_empty_lines: true })) {
    const nombre = sinVacios(texto(f[3]));
    if (nombre) alias.set(f[0], [...(alias.get(f[0]) || []), nombre]);
  }
  const entradas = filas.map((f) => {
    const remarks = sinVacios(texto(f[11]));
    const akas = [...remarks.matchAll(/a\.k\.a\.\s*'([^']+)'/gi)].map((m) => m[1]);
    return {
      ref: texto(f[0]),
      tipo: /individual/i.test(f[2]) ? 'persona' : 'entidad',
      nombre: texto(f[1]),
      alias: unicos([...(alias.get(f[0]) || []), ...akas]),
      documentos: unicos(cedulasEnTexto(remarks)),
      nacimiento: unicos([...remarks.matchAll(/DOB\s+([^;]+)/gi)].map((m) => texto(m[1]))),
      nacionalidades: unicos([...remarks.matchAll(/nationality\s+([^;.]+)/gi)].map((m) => texto(m[1]))),
      detalle: { programa: sinVacios(texto(f[3])), titulo: sinVacios(texto(f[4])), observaciones: remarks.slice(0, 600) },
    };
  }).filter((e) => e.nombre && e.ref);
  return { publicada: '', entradas };
};

// ── Unión Europea: lista consolidada (CSV ";", una fila por alias × dirección × documento) ──
export const parseUe = (csv) => {
  const filas = parseCsv(csv.replace(/^﻿/, ''), { columns: true, delimiter: ';', relax_quotes: true, relax_column_count: true, skip_empty_lines: true });
  const porId = new Map();
  let publicada = '';
  for (const f of filas) {
    publicada ||= texto(f.fileGenerationDate);
    const id = texto(f.Entity_LogicalId);
    if (!id) continue;
    if (!porId.has(id)) {
      porId.set(id, {
        ref: id, tipo: texto(f.Entity_SubjectType) === 'P' ? 'persona' : 'entidad', nombre: '', alias: new Set(), documentos: new Set(),
        nacimiento: new Set(), nacionalidades: new Set(), detalle: { programa: texto(f.Entity_Regulation_Programme), referencia: texto(f.Entity_EU_ReferenceNumber) },
      });
    }
    const e = porId.get(id);
    const nombre = texto(f.NameAlias_WholeName) || [f.NameAlias_FirstName, f.NameAlias_MiddleName, f.NameAlias_LastName].map(texto).filter(Boolean).join(' ');
    if (nombre) { if (!e.nombre) e.nombre = nombre; else if (nombre !== e.nombre) e.alias.add(nombre); }
    if (f.BirthDate_BirthDate) e.nacimiento.add(texto(f.BirthDate_BirthDate));
    if (f.Citizenship_CountryDescription) e.nacionalidades.add(texto(f.Citizenship_CountryDescription));
    if (f.Identification_Number && /colombia/i.test(texto(f.Identification_CountryDescription))) {
      const d = soloDigitos(f.Identification_Number);
      if (d.length >= 5) e.documentos.add(d);
    }
  }
  const entradas = [...porId.values()].filter((e) => e.nombre).map((e) => ({
    ...e, alias: [...e.alias], documentos: [...e.documentos], nacimiento: [...e.nacimiento], nacionalidades: [...e.nacionalidades],
  }));
  return { publicada, entradas };
};

// ── Reino Unido: OFSI Consolidated List (CSV; la primera línea es "Last Updated,dd/mm/aaaa") ──
export const parseUk = (csv) => {
  const lineas = csv.replace(/^﻿/, '').split(/\r?\n/);
  const publicada = (lineas[0].match(/Last Updated,(.+)/) || [])[1]?.trim() || '';
  const filas = parseCsv(lineas.slice(1).join('\n'), { columns: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true });
  const porGrupo = new Map();
  for (const f of filas) {
    const grupo = texto(f['Group ID']);
    if (!grupo || texto(f['Group Type']) === 'Ship') continue;
    const nombre = ['Name 1', 'Name 2', 'Name 3', 'Name 4', 'Name 5', 'Name 6'].map((k) => texto(f[k])).filter(Boolean).join(' ');
    if (!porGrupo.has(grupo)) {
      porGrupo.set(grupo, {
        ref: grupo, tipo: texto(f['Group Type']) === 'Individual' ? 'persona' : 'entidad', nombre: '', alias: new Set(), documentos: new Set(),
        nacimiento: new Set(), nacionalidades: new Set(), detalle: { programa: texto(f.Regime), otra_informacion: texto(f['Other Information']).slice(0, 400) },
      });
    }
    const e = porGrupo.get(grupo);
    const esPrincipal = /primary name$/i.test(texto(f['Alias Type'])) || /primary/i.test(texto(f['Alias Type'])) && !/variation/i.test(f['Alias Type']);
    if (nombre) { if (esPrincipal && !e.nombre) e.nombre = nombre; else e.alias.add(nombre); }
    if (f.DOB) e.nacimiento.add(texto(f.DOB));
    if (f.Nationality) e.nacionalidades.add(texto(f.Nationality));
    const idn = `${texto(f['National Identification Number'])} ${texto(f['National Identification Details'])}`;
    if (/colombia/i.test(idn) || /colombia/i.test(texto(f.Nationality))) {
      const d = soloDigitos(f['National Identification Number']);
      if (d.length >= 5 && d.length <= 12) e.documentos.add(d);
    }
  }
  const entradas = [...porGrupo.values()].map((e) => {
    const alias = [...e.alias];
    if (!e.nombre) e.nombre = alias.shift() || '';
    return { ...e, alias: alias.filter((a) => a !== e.nombre), documentos: [...e.documentos], nacimiento: [...e.nacimiento], nacionalidades: [...e.nacionalidades] };
  }).filter((e) => e.nombre);
  return { publicada, entradas };
};

// Encabezados sin importar mayúsculas
const fila = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k.toLowerCase(), v]));

// ── PEP de Colombia: SIGEP / Función Pública (datos.gov.co, Decreto 830 de 2021 art. 7) ──
export const parsePepSigep = (csv) => {
  const filas = parseCsv(csv.replace(/^﻿/, ''), { columns: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true });
  const entradas = [];
  filas.forEach((r0, i) => {
    const r = fila(r0);
    const doc = soloDigitos(r.numero_documento);
    if (doc.length < 5 || !texto(r.nombre_pep)) return;
    entradas.push({
      ref: `${doc}-${i}`, tipo: 'persona', nombre: texto(r.nombre_pep), alias: [], documentos: [doc], nacimiento: [], nacionalidades: ['Colombia'],
      detalle: {
        cargo: texto(r.denominacion_cargo), entidad: texto(r.nombre_entidad), fecha_vinculacion: texto(r.fecha_vinculacion),
        fecha_desvinculacion: texto(r.fecha_desvinculacion), hoja_de_vida: texto(r.enlace_hoja_vida_sigep),
      },
    });
  });
  return { publicada: '', entradas };
};

// ── Procuraduría: sanciones disciplinarias SIRI (datos.gov.co) ──
export const parseSiri = (csv) => {
  const filas = parseCsv(csv.replace(/^﻿/, ''), { columns: true, relax_quotes: true, relax_column_count: true, skip_empty_lines: true });
  const entradas = [];
  for (const r0 of filas) {
    const r = fila(r0);
    if (!/c[eé]dula de ciudadan/i.test(String(r.nombre_tipo_identificacion || '').normalize('NFD').replace(/[̀-ͯ]/g, ''))) continue;
    const doc = soloDigitos(r.numero_identificacion);
    if (doc.length < 5) continue;
    const nombre = [r.primer_nombre, r.segundo_nombre, r.primer_apellido, r.segundo_apellido].map(texto).filter(Boolean).join(' ');
    entradas.push({
      ref: texto(r.numero_siri) || `${doc}-${entradas.length}`, tipo: 'persona', nombre, alias: [], documentos: [doc], nacimiento: [], nacionalidades: ['Colombia'],
      detalle: {
        tipo_inhabilidad: texto(r.tipo_inhabilidad), sanciones: texto(r.sanciones), cargo: texto(r.cargo), autoridad: texto(r.autoridad),
        fecha_efectos_juridicos: texto(r.fecha_efectos_juridicos), entidad: texto(r.entidad_sancionado),
        duracion: [r.duracion_anos && `${texto(r.duracion_anos)} años`, r.duracion_mes && `${texto(r.duracion_mes)} meses`, r.duracion_dias && `${texto(r.duracion_dias)} días`].filter(Boolean).join(' '),
      },
    });
  }
  return { publicada: '', entradas };
};
