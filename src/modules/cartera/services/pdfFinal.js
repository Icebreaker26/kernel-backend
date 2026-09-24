// PDF final del crédito: une TODOS los documentos del expediente en un orden fijo y estampa los sellos de Cartera
// (AVAL FONDO REGIONAL, FIRMA ELECTRONICA, DESEMBOLSO) en el lugar que Cartera eligió sobre el Comprobante de aprobación.
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';

// Los sellos tienen tamaño fijo (fracción del ancho de la página): así la vista previa del navegador y el PDF coinciden exactamente
export const SELLO_ANCHO = 0.30;      // ancho del sello / ancho de la página
export const SELLO_ASPECTO = 3.2;     // ancho / alto del sello
export const SELLOS = ['aval', 'firma', 'desembolso'];

const A4 = [595.28, 841.89];

// Las fuentes estándar solo codifican Latin-1
const seguro = (s) => String(s ?? '')
  .replace(/[—–]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
  .replace(/[^\x20-\x7E\xA0-\xFF]/gu, '?');

export const pesos = (n) => `$${Number(n).toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;

// Orden del expediente. Primero lo que produjo Cartera, luego lo firmado por el asesor, la autorización de la empresa y los soportes
const RANGO_FIRMADO = { comprobante_aprobacion: 1, formato_estudio_credito: 2, solicitud_credito: 10, libranza: 11, pagare: 12, carta_instrucciones: 13, proyeccion: 14 };
const RANGO_ADJUNTO = { desprendible_nomina: 30, certificado_bancario: 31 };
export const rangoDocumento = (d) => {
  if (d.origen === 'autorizacion') return 20;
  if (d.clase === 'firmado') return RANGO_FIRMADO[d.tipo] ?? 15;
  if (d.clase === 'adjunto') return RANGO_ADJUNTO[d.tipo] ?? 32;
  if (d.clase === 'evidencia_externa') return 40;
  return 99;
};
export const ordenarDocumentos = (docs) =>
  [...docs].sort((a, b) => rangoDocumento(a) - rangoDocumento(b) || new Date(a.created_at) - new Date(b.created_at));

// Punto de la vista (u a la derecha, v hacia abajo, desde la esquina superior izquierda) → coordenadas del PDF sin rotar
const aPdf = ({ R, cb }, u, v) => {
  if (R === 90)  return { x: cb.x + v,              y: cb.y + u };
  if (R === 180) return { x: cb.x + cb.width - u,   y: cb.y + v };
  if (R === 270) return { x: cb.x + cb.width - v,   y: cb.y + cb.height - u };
  return { x: cb.x + u, y: cb.y + cb.height - v };
};

export const dimensionesVisibles = (page) => {
  const cb = page.getCropBox();
  const R = ((page.getRotation().angle % 360) + 360) % 360;
  const rotada = R === 90 || R === 270;
  return { R, cb, W: rotada ? cb.height : cb.width, H: rotada ? cb.width : cb.height };
};

const AZUL = rgb(0.05, 0.22, 0.5);

const dibujarSello = (page, fuentes, { titulo, detalle }, { x, y }) => {
  const dim = dimensionesVisibles(page);
  const w = SELLO_ANCHO * dim.W;
  const h = w / SELLO_ASPECTO;
  const u = Math.min(Math.max(x, 0), 1 - SELLO_ANCHO) * dim.W;
  const v = Math.min(Math.max(y, 0), 1 - (SELLO_ANCHO / SELLO_ASPECTO) * (dim.W / dim.H)) * dim.H;
  const giro = degrees(dim.R);

  const esquina = aPdf(dim, u, v + h);   // esquina inferior izquierda del sello tal como se ve
  page.drawRectangle({ x: esquina.x, y: esquina.y, width: w, height: h, rotate: giro, borderColor: AZUL, borderWidth: 1.6, color: rgb(1, 1, 1), opacity: 0.92, borderOpacity: 1 });

  const ajustar = (texto, fuente, tam) => {
    let t = tam;
    while (t > 4 && fuente.widthOfTextAtSize(texto, t) > w * 0.9) t -= 0.5;
    return t;
  };
  const t1 = seguro(titulo);
  const t2 = seguro(detalle);
  const s1 = ajustar(t1, fuentes.negrita, h * 0.27);
  const s2 = ajustar(t2, fuentes.negrita, h * 0.36);
  const linea = (texto, fuente, tam, vBase) => {
    const ancho = fuente.widthOfTextAtSize(texto, tam);
    const p = aPdf(dim, u + (w - ancho) / 2, vBase);
    page.drawText(texto, { x: p.x, y: p.y, size: tam, font: fuente, color: AZUL, rotate: giro });
  };
  linea(t1, fuentes.negrita, s1, v + h * 0.38);
  linea(t2, fuentes.negrita, s2, v + h * 0.78);
};

const textoSello = (clave, c) => ({
  aval: { titulo: 'AVAL FONDO REGIONAL', detalle: `${Number(c.aval_porcentaje)}% · ${pesos(c.aval_valor)}` },
  firma: { titulo: 'FIRMA ELECTRONICA', detalle: pesos(c.firma_electronica_valor) },
  desembolso: { titulo: 'DESEMBOLSO', detalle: pesos(c.desembolso_neto) },
}[clave]);

/** Qué sellos aplican a este crédito (el de aval solo si lleva aval; el de firma solo si se firmó con proveedor externo) */
export const sellosAplicables = (cierre, solicitud) => [
  ...(cierre?.con_aval ? ['aval'] : []),
  ...(solicitud.modalidad_firma === 'externa' ? ['firma'] : []),
  'desembolso',
];

const paginaInformativa = async (doc, fuentes, titulo, lineas) => {
  const p = doc.addPage(A4);
  p.drawText(seguro(titulo), { x: 48, y: A4[1] - 72, size: 14, font: fuentes.negrita, color: rgb(0.1, 0.1, 0.1) });
  lineas.forEach((l, i) => p.drawText(seguro(l), { x: 48, y: A4[1] - 100 - i * 16, size: 10, font: fuentes.normal, color: rgb(0.3, 0.3, 0.3) }));
};

const agregarImagen = async (doc, bytes, esPng) => {
  const img = esPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const p = doc.addPage(A4);
  const margen = 28;
  const k = Math.min((A4[0] - 2 * margen) / img.width, (A4[1] - 2 * margen) / img.height, 1.5);
  const w = img.width * k;
  const h = img.height * k;
  p.drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
};

/**
 * @param entradas  [{ nombre, tipo, clase, origen, bytes, mime, comprobante }] YA en el orden final
 * @param cierre    fila de credito_cierre (valores y posición de los sellos)
 * @param solicitud fila de credito_solicitudes
 * @returns {{ bytes: Uint8Array, omitidos: string[], paginas: number }}
 */
export const armarPdfFinal = async (entradas, cierre, solicitud) => {
  const doc = await PDFDocument.create();
  doc.setTitle(`Expediente de crédito ${solicitud.radicado}`);
  doc.setProducer('Kernel · Cooperativa Progresemos');
  doc.setCreator('Kernel');
  const fuentes = { normal: await doc.embedFont(StandardFonts.Helvetica), negrita: await doc.embedFont(StandardFonts.HelveticaBold) };
  const omitidos = [];

  for (const e of entradas) {
    try {
      if (e.mime === 'application/pdf') {
        const origen = await PDFDocument.load(e.bytes, { updateMetadata: false });
        const paginas = await doc.copyPages(origen, origen.getPageIndices());
        paginas.forEach((p) => doc.addPage(p));
        if (e.comprobante) {
          const aplican = sellosAplicables(cierre, solicitud);
          for (const clave of aplican) {
            const pos = cierre?.sellos?.[clave];
            if (!pos) continue;
            const pagina = paginas[pos.pagina];
            if (!pagina) throw new Error(`El sello ${clave} quedó en una página que no existe en el comprobante`);
            dibujarSello(pagina, fuentes, textoSello(clave, cierre), pos);
          }
        }
      } else {
        await agregarImagen(doc, e.bytes, e.mime === 'image/png');
      }
    } catch (err) {
      if (e.comprobante) throw err;   // sin el comprobante (o con sellos mal puestos) el documento final no sirve
      omitidos.push(e.nombre);
      await paginaInformativa(doc, fuentes, 'No se pudo incorporar este documento', [e.nombre, 'El archivo está dañado o protegido con contraseña.', 'Consúltalo por separado en el expediente.']);
    }
  }
  return { bytes: await doc.save(), omitidos, paginas: doc.getPageCount() };
};
