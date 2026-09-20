import xss from 'xss';

/**
 * Lista blanca del contenido de una entrada del blog. El editor de Kernel solo produce estas etiquetas; todo lo demás
 * (scripts, estilos, imágenes, iframes, atributos de eventos...) se elimina en el servidor, así que el HTML guardado
 * es seguro de mostrar en el sitio público sin importar lo que llegue en la petición.
 *
 * Se usa `xss` (solo CommonJS) y no `sanitize-html`: la versión sin avisos de seguridad depende de un paquete ESM que
 * Jest no puede cargar, y las anteriores tienen avisos sobre la validación de esquemas de URL en los enlaces.
 */
const PERMITIDAS = {
  h2: [], h3: [], p: [], br: [], hr: [], strong: [], b: [], em: [], i: [], u: [], s: [],
  ul: [], ol: [], li: [], blockquote: [],
  a: ['href'],
};

// El editor puede producir h1 y niveles bajos: en la página el título de la entrada ya es el h1
const NIVEL = { h1: 'h2', h4: 'h3', h5: 'h3', h6: 'h3' };

const filtro = new xss.FilterXSS({
  whiteList: PERMITIDAS,
  stripIgnoreTagBody: ['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math'],   // y su contenido
  allowCommentTag: false,
  // Etiquetas no permitidas: se quitan y el texto se conserva (salvo los cuerpos de arriba); los niveles de título se remapean
  onIgnoreTag: (tag, html, { isClosing }) => (NIVEL[tag] ? `<${isClosing ? '/' : ''}${NIVEL[tag]}>` : ''),
  // href: solo http, https, mailto y tel (xss ya descarta javascript:, vbscript: y data:)
  safeAttrValue: (tag, nombre, valor, css) => {
    if (tag === 'a' && nombre === 'href') {
      const v = String(valor).trim();
      return /^(https?:\/\/|mailto:|tel:)/i.test(v) ? xss.escapeAttrValue(v) : '';
    }
    return xss.safeAttrValue(tag, nombre, valor, css);
  },
});

export const sanitizarContenido = (html) => filtro.process(String(html ?? ''))
  // El editor deja párrafos vacíos al dar Enter de más: en la página serían huecos sin sentido
  .replace(/<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, '')
  // Los enlaces sin destino válido quedan como texto
  .replace(/<a(?:\s+href(?:="")?)?\s*>([\s\S]*?)<\/a>/gi, '$1')
  // Los enlaces abren en otra pestaña y no comparten el contexto con el sitio de destino
  .replace(/<a\s+href="([^"]*)"\s*>/gi, '<a href="$1" target="_blank" rel="noopener noreferrer nofollow">');

/** Texto plano (sin etiquetas) para resúmenes y para saber si una entrada tiene contenido. */
export const textoPlano = (html) =>
  new xss.FilterXSS({ whiteList: {}, stripIgnoreTag: true, stripIgnoreTagBody: ['script', 'style', 'iframe', 'svg', 'math'], allowCommentTag: false })
    .process(String(html ?? ''))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
