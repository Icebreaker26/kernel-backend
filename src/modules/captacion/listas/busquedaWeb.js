import { env } from '../../../config/env.js';
import logger from '../../../config/logger.js';

/**
 * Búsqueda en fuentes abiertas (noticias y web) para el análisis de riesgo reputacional. Usa la API de Brave Search: la API de búsqueda
 * de Google ya no admite clientes nuevos y se apaga el 1 de enero de 2027. Si no hay llave configurada, la consulta sigue funcionando y
 * el asesor busca con los enlaces de ayuda.
 *
 * El resultado es una PISTA para el asesor, no una conclusión: hay muchos homónimos y el sistema no sabe si un artículo se refiere a
 * la persona. Por eso se guardan los enlaces y el resumen tal como los devuelve el buscador, y el asesor decide.
 */

const PROVEEDOR = 'Brave Search';
const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const RESULTADOS_POR_CONSULTA = 8;

export const busquedaWebDisponible = () => !!env.BRAVE_SEARCH_API_KEY;

/** Las consultas que se hacen: nombre solo, con palabras de riesgo y con términos judiciales (y la cédula solo si se activó). */
export const consultasDeBusqueda = ({ nombres, apellidos, cedula }, { incluirCedula = env.BUSQUEDA_INCLUIR_CEDULA } = {}) => {
  const nombre = `${nombres} ${apellidos}`.replace(/\s+/g, ' ').trim();
  const consultas = [
    { clave: 'nombre', etiqueta: 'Nombre completo', q: `"${nombre}"` },
    { clave: 'riesgo', etiqueta: 'Nombre + lavado de activos, narcotráfico, corrupción', q: `"${nombre}" lavado de activos narcotráfico corrupción captura` },
    { clave: 'judicial', etiqueta: 'Nombre + condena, imputación, sanción', q: `"${nombre}" condenado imputado sancionado investigación fiscalía` },
  ];
  if (incluirCedula && cedula) consultas.push({ clave: 'cedula', etiqueta: 'Cédula', q: `"${cedula}" "${nombres.split(' ')[0]}"` });
  return consultas;
};

const ENTIDADES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ' };
// El buscador devuelve el resumen con etiquetas (<strong>) y entidades HTML: se guarda como texto plano
export const limpiarResumen = (t) => String(t ?? '').replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#39|#x27|nbsp);/g, (e) => ENTIDADES[e]).replace(/\s+/g, ' ').trim().slice(0, 320);

const dominioDe = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

const buscarBrave = async (q) => {
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', q);
  url.searchParams.set('count', String(RESULTADOS_POR_CONSULTA));
  url.searchParams.set('search_lang', 'es');
  url.searchParams.set('safesearch', 'off');
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': env.BRAVE_SEARCH_API_KEY },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'La llave del buscador no es válida o no tiene saldo' : res.status === 429 ? 'El buscador limitó las consultas: intenta en un momento' : `El buscador respondió ${res.status}`);
  const json = await res.json();
  return (json.web?.results ?? [])
    .filter((r) => /^https?:\/\//i.test(r.url ?? ''))
    .map((r) => ({ titulo: limpiarResumen(r.title).slice(0, 200), url: r.url, dominio: r.meta_url?.hostname?.replace(/^www\./, '') || dominioDe(r.url), resumen: limpiarResumen(r.description), edad: r.age ?? null }));
};

/**
 * Hace las búsquedas y devuelve { proveedor, ejecutada_at, consultas: [{ clave, etiqueta, q, resultados[], error? }] }.
 * Una búsqueda que falla no impide las demás ni la consulta: queda anotado el error en esa búsqueda.
 */
export const buscarFuentesAbiertas = async (persona, { buscar = buscarBrave, incluirCedula } = {}) => {
  const consultas = [];
  for (const c of consultasDeBusqueda(persona, { incluirCedula })) {
    try {
      consultas.push({ ...c, resultados: await buscar(c.q) });
    } catch (err) {
      logger.warn(`busqueda web: falló "${c.clave}": ${err.message}`);
      consultas.push({ ...c, resultados: [], error: err.message });
    }
  }
  return { proveedor: PROVEEDOR, ejecutada_at: new Date().toISOString(), consultas };
};
