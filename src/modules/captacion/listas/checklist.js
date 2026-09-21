/**
 * Consultas que hace el asesor por su cuenta (no hay descarga masiva oficial automatizable): fuentes abiertas y certificados web.
 * Cada una deja resultado, cuándo, con qué términos y observaciones; el Oficial de Cumplimiento valida que se hicieron.
 * `obligatoria`: sin responderla no se puede cerrar la consulta. Las demás admiten "no aplica".
 */
export const CHECKLIST_MANUAL = [
  {
    clave: 'fuentes_abiertas', obligatoria: true,
    titulo: 'Búsqueda en fuentes abiertas (Google y noticias)',
    ayuda: 'El sistema ya buscó por ti (resultados arriba, con enlace y resumen). Abre los que parezcan referirse a la persona: muchos son homónimos y no cuentan. Si alguno es de ella, marca “Con hallazgo” y anota cuál. Si no hay buscador configurado, usa los enlaces de ayuda. Anota qué buscaste y dónde.',
    pide_terminos: true,
  },
  {
    clave: 'procuraduria', obligatoria: false,
    titulo: 'Certificado de antecedentes disciplinarios (Procuraduría)',
    ayuda: 'El sistema ya cruza la base pública de sanciones (SIRI) por cédula. El certificado oficial (que también refleja anotaciones penales, contractuales y fiscales) se saca en la web con la cédula: si lo consultaste, anota el resultado.',
    enlaces: [{ etiqueta: 'Certificado de antecedentes (Procuraduría)', url: 'https://apps.procuraduria.gov.co/webcert/Certificado.aspx' }],
  },
  {
    clave: 'contraloria', obligatoria: false,
    titulo: 'Boletín de responsables fiscales (Contraloría)',
    ayuda: 'No hay descarga masiva automatizable: el boletín se publica en PDF cada trimestre y el certificado se saca por persona. Consúltalo con la cédula y anota el resultado.',
    enlaces: [
      { etiqueta: 'Certificado de antecedentes fiscales', url: 'https://www.contraloria.gov.co/en/control-fiscal/responsabilidad-fiscal/certificado-de-antecedentes-fiscales' },
      { etiqueta: 'Boletín trimestral (PDF)', url: 'https://cfiscal.contraloria.gov.co/reportes/consultaboletinestrimestrales.aspx' },
    ],
  },
  {
    clave: 'policia', obligatoria: false,
    titulo: 'Antecedentes judiciales (Policía Nacional)',
    ayuda: 'Consulta individual con la cédula y un CAPTCHA (no se puede automatizar). La página pide que quien consulta tenga la autorización del titular. Anota el resultado.',
    enlaces: [{ etiqueta: 'Consulta de antecedentes judiciales', url: 'https://antecedentes.policia.gov.co:7005/WebJudicial/' }],
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
