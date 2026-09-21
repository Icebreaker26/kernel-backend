// Normalización y comparación de nombres para el cotejo en listas restrictivas.
// No existe un umbral legal de similitud: los umbrales son parámetros del motor y quedan registrados en cada consulta.

export const PARAMETROS_COTEJO = {
  motor: 'kernel-cotejo-v1',
  algoritmo: 'Coincidencia por palabras sin orden (Jaro-Winkler por palabra), alias incluidos; la cédula exacta es coincidencia fuerte',
  umbral_posible: 0.85,
  umbral_fuerte: 0.95,
  jw_palabra: 0.9,
};

// Partículas que no distinguen a una persona (de la, del, van, bin…): se ignoran al comparar
const PARTICULAS = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'EL', 'Y', 'E', 'VAN', 'VON', 'DER', 'DEN', 'DA', 'DOS', 'DI', 'BIN', 'BEN', 'AL']);

// Mayúsculas, sin tildes ni signos, espacios simples
export const normalizar = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toUpperCase()
  .replace(/[^A-Z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export const palabras = (s) => normalizar(s).split(' ').filter((t) => t && !PARTICULAS.has(t));

// Solo dígitos (cédulas con puntos, espacios o prefijos como "Cedula No.")
export const soloDigitos = (s) => String(s ?? '').replace(/\D/g, '');

// Jaro-Winkler estándar
export const jaroWinkler = (a, b) => {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  const rango = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Array(la).fill(false);
  const mb = new Array(lb).fill(false);
  let coincidencias = 0;
  for (let i = 0; i < la; i++) {
    const desde = Math.max(0, i - rango);
    const hasta = Math.min(lb - 1, i + rango);
    for (let j = desde; j <= hasta; j++) {
      if (!mb[j] && a[i] === b[j]) { ma[i] = true; mb[j] = true; coincidencias++; break; }
    }
  }
  if (!coincidencias) return 0;
  let transposiciones = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!ma[i]) continue;
    while (!mb[k]) k++;
    if (a[i] !== b[k]) transposiciones++;
    k++;
  }
  const jaro = (coincidencias / la + coincidencias / lb + (coincidencias - transposiciones / 2) / coincidencias) / 3;
  let prefijo = 0;
  while (prefijo < Math.min(4, la, lb) && a[prefijo] === b[prefijo]) prefijo++;
  return jaro + prefijo * 0.1 * (1 - jaro);
};

/**
 * Compara dos nombres ya separados en palabras. Devuelve { score, coinciden, parcial }.
 *  - Cada palabra de `q` se empareja (una sola vez) con la más parecida de `c` si supera `jw_palabra`.
 *  - score = 2·suma(similitudes) / (palabras de q + palabras de c).
 *  - Si la persona contiene TODAS las palabras de un nombre de la lista de 3 o más palabras, se considera coincidencia parcial (mínimo umbral_posible):
 *    la lista suele traer menos nombres que los que la persona escribe completos.
 */
export const compararPalabras = (q, c, { jw_palabra } = PARAMETROS_COTEJO) => {
  if (!q.length || !c.length) return { score: 0, coinciden: 0, parcial: false };
  const usadas = new Set();
  let suma = 0;
  let coinciden = 0;
  for (const tq of q) {
    let mejor = 0;
    let idx = -1;
    for (let i = 0; i < c.length; i++) {
      if (usadas.has(i)) continue;
      const s = tq === c[i] ? 1 : (tq.length >= 4 && c[i].length >= 4 ? jaroWinkler(tq, c[i]) : 0);
      if (s > mejor) { mejor = s; idx = i; }
    }
    if (idx >= 0 && mejor >= jw_palabra) { usadas.add(idx); suma += mejor; coinciden++; }
  }
  let score = (2 * suma) / (q.length + c.length);
  const parcial = c.length >= 3 && coinciden === c.length && score < PARAMETROS_COTEJO.umbral_posible;
  if (parcial) score = PARAMETROS_COTEJO.umbral_posible;
  return { score, coinciden, parcial };
};
