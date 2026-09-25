/**
 * Índice DIVIPOLA (DANE): traduce "ciudad + departamento" escritos a mano en Kernel al código de municipio de 5 dígitos
 * que SOLIDO usa en sus campos de ciudad (p. ej. La Virginia, Risaralda → 66400).
 * Fuente: datos.gov.co (gdxc-w37w), 1122 filas. Función pura, sin base de datos.
 * Solo devuelve un código cuando es INEQUÍVOCO; si hay duda devuelve null y el dato queda como "sin equivalencia"
 * para que una persona lo resuelva en la tabla rpa_equivalencias (que siempre tiene prioridad sobre este índice).
 */
import { readFileSync } from 'node:fs';

// Sin tildes, minúsculas, sin signos ni "(depto)", y "Bogotá, D.C." == "Bogota D.C." == "bogota"
export const normDane = (s) => String(s ?? '')
  .replace(/\(.*?\)/g, ' ')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  .replace(/\s+(d c|distrito capital)$/, '');

// El departamento de SOLIDO/Kernel se escribe de otra forma que en DIVIPOLA en estos casos
const ALIAS_DEPTO = [[/^san andres( |$)/, '88'], [/^bogota/, '11']];
const codigoDepto = (nombreNorm, porNombre) => {
  for (const [re, cod] of ALIAS_DEPTO) if (re.test(nombreNorm)) return cod;
  return porNombre.get(nombreNorm) || null;
};

/** @param {Array<[string,string,string,string]>} filas [cod_mpio, municipio, cod_dpto, departamento] */
export const crearIndice = (filas) => {
  const porNombreDepto = new Map();
  const municipios = filas.map(([codigo, municipio, cd, depto]) => {
    porNombreDepto.set(normDane(depto), cd);
    return { codigo, municipio, cd, norm: normDane(municipio) };
  });
  const porCiudad = new Map();
  for (const m of municipios) porCiudad.set(m.norm, [...(porCiudad.get(m.norm) || []), m]);

  const unico = (lista) => (lista.length === 1 ? lista[0].codigo : null);

  return (ciudad, departamento) => {
    const c = normDane(ciudad);
    if (!c) return null;
    const cd = departamento ? codigoDepto(normDane(departamento), porNombreDepto) : null;

    const exactos = porCiudad.get(c) || [];
    if (cd) {
      const enDepto = exactos.filter((m) => m.cd === cd);
      if (enDepto.length === 1) return enDepto[0].codigo;
      // "Tumaco" → "San Andrés de Tumaco": el texto es una parte completa del nombre, dentro del mismo departamento
      if (enDepto.length === 0) {
        const parcial = municipios.filter((m) => m.cd === cd && ` ${m.norm} `.includes(` ${c} `));
        if (parcial.length === 1) return parcial[0].codigo;
      }
      return null;
    }
    // Sin departamento (o desconocido): solo si el nombre es único en todo el país
    return unico(exactos);
  };
};

let indice = null;
/** Índice con la lista oficial completa (se carga una sola vez por proceso). */
export const codigoDane = (ciudad, departamento) => {
  if (!indice) {
    const ruta = new URL('../data/divipola.json', import.meta.url);
    indice = crearIndice(JSON.parse(readFileSync(ruta, 'utf8')));
  }
  return indice(ciudad, departamento);
};
