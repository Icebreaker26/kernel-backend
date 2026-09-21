/**
 * Consultas que hace el asesor por su cuenta (no hay descarga masiva oficial automatizable): fuentes abiertas y certificados web.
 * Cada una deja resultado, cuándo, con qué términos y observaciones; el Oficial de Cumplimiento valida que se hicieron.
 * `obligatoria`: sin responderla no se puede cerrar la consulta. Las demás admiten "no aplica".
 */
export const CHECKLIST_MANUAL = [
  {
    clave: 'fuentes_abiertas', obligatoria: true,
    titulo: 'Búsqueda en fuentes abiertas (Google y noticias)',
    ayuda: 'Busca al asociado con su nombre completo entre comillas y con palabras de riesgo. Anota qué buscaste, en qué motor y qué encontraste (con las direcciones de las páginas relevantes).',
    pide_terminos: true,
  },
  {
    clave: 'procuraduria', obligatoria: false,
    titulo: 'Certificado de antecedentes disciplinarios (Procuraduría)',
    ayuda: 'El sistema ya cruza la base pública de sanciones (SIRI) por cédula. Si además consultaste el certificado oficial en la web, anota el resultado.',
  },
  {
    clave: 'contraloria', obligatoria: false,
    titulo: 'Boletín de responsables fiscales (Contraloría)',
    ayuda: 'No hay descarga masiva automatizable: consulta la página de la Contraloría con la cédula y anota el resultado.',
  },
  {
    clave: 'policia', obligatoria: false,
    titulo: 'Antecedentes judiciales (Policía Nacional)',
    ayuda: 'Consulta individual en la página de la Policía Nacional; anota el resultado.',
  },
];

export const CLAVES_MANUAL = CHECKLIST_MANUAL.map((i) => i.clave);

/** Enlaces de ayuda para las búsquedas abiertas (se abren en el navegador del asesor; el sistema no consulta Google). */
export const enlacesBusqueda = ({ nombres, apellidos, cedula }) => {
  const nombre = `${nombres} ${apellidos}`.replace(/\s+/g, ' ').trim();
  const g = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  return [
    { etiqueta: 'Nombre completo', url: g(`"${nombre}"`) },
    { etiqueta: 'Nombre + lavado de activos', url: g(`"${nombre}" "lavado de activos" OR narcotráfico OR corrupción OR captura`) },
    { etiqueta: 'Nombre + noticias judiciales', url: g(`"${nombre}" condenado OR imputado OR sancionado OR investigación`) },
    { etiqueta: 'Cédula', url: g(`"${cedula}" "${nombres.split(' ')[0]}"`) },
  ];
};
