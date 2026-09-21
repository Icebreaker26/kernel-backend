import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { soloDigitos } from './normalizar.js';

/**
 * Boletín de Responsables Fiscales de la Contraloría General de la República (Ley 610 de 2000, art. 60): se publica cada trimestre como un
 * PDF público, sin CAPTCHA, con una tabla "Responsable Fiscal | Tipo y Num Documento | Entidad Afectada | TR | R | Ente que Reporta |
 * Departamento | Municipio". Se descarga solo (cada semana) y se cruza por cédula.
 */

const PAGINA = 'https://cfiscal.contraloria.gov.co/reportes/consultaboletinestrimestrales.aspx';
const TRIMESTRE = { enero: 1, abril: 2, julio: 3, octubre: 4 };

// Los boletines están publicados como enlaces "postback" (ASP.NET): se elige el más reciente por año y trimestre
export const elegirBoletinMasReciente = (html) => {
  const enlaces = [...html.matchAll(/__doPostBack\(&#39;([^&]+)&#39;[^>]*>\s*([^<]+?)\s*</g)].map((m) => ({ objetivo: m[1], nombre: m[2] }));
  let mejor = null;
  for (const e of enlaces) {
    const m = e.nombre.match(/(enero|abril|julio|octubre)[^\d]*(\d{4})/i);
    if (!m) continue;
    const orden = Number(m[2]) * 10 + TRIMESTRE[m[1].toLowerCase()];
    if (!mejor || orden > mejor.orden) mejor = { ...e, orden };
  }
  return mejor;
};

/** Descarga el PDF del boletín más reciente. Devuelve [{ buf, nombre, mime }]. */
export const descargarBoletinCgr = async () => {
  const cabeceras = { 'User-Agent': 'Kernel-Progresemos/1.0 (cumplimiento)' };
  const res = await fetch(PAGINA, { headers: cabeceras, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Contraloría respondió ${res.status}`);
  const html = await res.text();
  const cookies = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const campo = (n) => (html.match(new RegExp(`name="${n}"[^>]*value="([^"]*)"`)) || [])[1] ?? '';
  const boletin = elegirBoletinMasReciente(html);
  if (!boletin) throw new Error('No se encontró ningún boletín en la página de la Contraloría');

  const cuerpo = new URLSearchParams({
    __EVENTTARGET: boletin.objetivo, __EVENTARGUMENT: '', __VIEWSTATE: campo('__VIEWSTATE').replace(/&amp;/g, '&'),
    __VIEWSTATEGENERATOR: campo('__VIEWSTATEGENERATOR'), __EVENTVALIDATION: campo('__EVENTVALIDATION').replace(/&amp;/g, '&'),
  });
  const pdf = await fetch(PAGINA, {
    method: 'POST', body: cuerpo, signal: AbortSignal.timeout(240000),
    headers: { ...cabeceras, 'Content-Type': 'application/x-www-form-urlencoded', ...(cookies && { Cookie: cookies }) },
  });
  if (!pdf.ok || !/pdf/i.test(pdf.headers.get('content-type') ?? '')) throw new Error('La Contraloría no devolvió el PDF del boletín');
  return [{ buf: Buffer.from(await pdf.arrayBuffer()), nombre: boletin.nombre.replace(/\s+/g, '_'), mime: 'application/pdf', modificada: null }];
};

const DOCUMENTO = /^(CC|CE|TI|NIT|PA|PEP|NUIP|RC)\s*([0-9][0-9.\-]{3,})$/i;

/**
 * Lee el PDF por coordenadas: cada fila empieza en el texto "CC 12345678" de la columna del documento; el nombre y las demás columnas
 * son los textos que quedan en su banda vertical y en su rango horizontal (los nombres y entidades largos ocupan varias líneas).
 * Solo se guardan personas con cédula de ciudadanía (los NIT son empresas).
 */
export const parseBoletinCgr = async (buffer) => {
  const doc = await getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: false }).promise;
  const entradas = [];
  let publicada = '';
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const items = tc.items.map((i) => ({ s: String(i.str).trim(), x: i.transform[4], y: i.transform[5] })).filter((i) => i.s);

      const cab = (rx) => items.find((i) => rx.test(i.s));
      const hDoc = cab(/^Tipo y Num/i);
      const hResp = cab(/^Responsable Fiscal$/i);
      if (!hDoc || !hResp) continue;   // página sin la tabla
      const hEnt = cab(/^Entidad Afectada$/i);
      const hTr = cab(/^TR$/i);
      const hEnte = cab(/^Ente que Reporta$/i);
      const hDep = cab(/^Departamento$/i);
      const hMun = cab(/^Municipio$/i);
      if (n === 1) {
        const linea = items.filter((i) => Math.abs(i.y - (cab(/Boletín de Responsables/i)?.y ?? -1)) < 4).sort((a, b) => a.x - b.x).map((i) => i.s).join(' ');
        const m = linea.match(/N°\s*(\d+)\s+con corte a\s+(.+)$/i);
        if (m) publicada = `Boletín N° ${m[1]}, corte a ${m[2]}`.slice(0, 60);
      }

      // El cuerpo va desde debajo del encabezado hasta el pie de la última página (leyenda "SIBOR / TR=Tipo responsabilidad…")
      const pie = items.find((i) => /^SIBOR|TR=Tipo|R=Cantidad/i.test(i.s));
      const cuerpo = items.filter((i) => i.y < hResp.y - 3 && (!pie || i.y > pie.y + 2));
      const filas = cuerpo.filter((i) => Math.abs(i.x - hDoc.x) < 60 && DOCUMENTO.test(i.s)).sort((a, b) => b.y - a.y);
      const tol = 8;
      // Los encabezados no empiezan donde empieza cada columna (van centrados): estos márgenes salen de medir el boletín real
      const docX = filas.length ? Math.min(...filas.map((f) => f.x)) : hDoc.x;
      const rango = { nombre: [-1, docX - 3], entidad: [(hEnt?.x ?? docX + 100) - 30, (hTr?.x ?? docX + 210) - 3], ente: [(hEnte?.x ?? 476) - 55, (hDep?.x ?? 606) - 20],
        depto: [(hDep?.x ?? 606) - 20, (hMun?.x ?? 692) - 25], municipio: [(hMun?.x ?? 692) - 25, Infinity] };
      const columna = (its, [desde, hasta]) => its.filter((i) => i.x >= desde && i.x < hasta)
        .sort((a, b) => b.y - a.y || a.x - b.x).map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim();

      filas.forEach((f, k) => {
        const m = f.s.match(DOCUMENTO);
        if (m[1].toUpperCase() !== 'CC') return;
        const numero = soloDigitos(m[2]);
        if (numero.length < 5 || numero.length > 12) return;
        const alto = f.y + tol;
        const bajo = filas[k + 1] ? filas[k + 1].y + tol : -Infinity;
        const banda = cuerpo.filter((i) => i.y <= alto && i.y > bajo);
        const nombre = columna(banda, rango.nombre);
        if (!nombre) return;
        entradas.push({
          ref: `${numero}-${n}-${k}`, tipo: 'persona', nombre, alias: [], documentos: [numero], nacimiento: [], nacionalidades: ['Colombia'],
          detalle: {
            tipo_documento: 'CC',
            entidad_afectada: columna(banda, rango.entidad),
            ente_que_reporta: columna(banda, rango.ente),
            departamento: columna(banda, rango.depto),
            municipio: columna(banda, rango.municipio),
            boletin: publicada,
          },
        });
      });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return { publicada, entradas };
};
