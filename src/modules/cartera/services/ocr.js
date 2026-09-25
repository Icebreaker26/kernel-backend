import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import logger from '../../../config/logger.js';

/**
 * OCR local (Tesseract, WASM) para certificados que no traen texto: fotos y escaneos. Nada sale del servidor: el motor y el idioma español
 * vienen empaquetados en node_modules (@tesseract.js-data/spa), así que tampoco se descarga nada de internet al ejecutarse.
 *
 * Cada lectura levanta y apaga su propio motor: son pocas por día y así no queda memoria retenida entre solicitudes.
 * Tesseract y el canvas nativo se cargan la PRIMERA vez que se necesitan (import dinámico): así el arranque de la aplicación y su memoria no pagan por algo que casi nunca se usa.
 */

const require = createRequire(import.meta.url);
const LANG_PATH = path.join(path.dirname(require.resolve('@tesseract.js-data/spa/package.json')), '4.0.0_best_int');
const CACHE_PATH = path.join(os.tmpdir(), 'kernel-tesseract');
const TIMEOUT_MS = 90_000;
const MAX_PAGINAS_PDF = 2;

const normalizar = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

/** Texto de una o varias imágenes (PNG/JPG en Buffer). Devuelve '' si no se puede leer o tarda demasiado. */
export const textoDeImagenes = async (imagenes) => {
  let worker;
  let vencido = false;
  const temporizador = setTimeout(() => { vencido = true; worker?.terminate().catch(() => {}); }, TIMEOUT_MS);
  try {
    const { createWorker } = await import('tesseract.js');
    worker = await createWorker('spa', 1, { langPath: LANG_PATH, gzip: true, cachePath: CACHE_PATH, cacheMethod: 'refresh' });
    const partes = [];
    for (const img of imagenes) {
      const { data } = await worker.recognize(img);
      partes.push(data.text);
    }
    return normalizar(partes.join(' '));
  } catch (err) {
    logger.warn(`OCR no pudo leer el archivo${vencido ? ' (tiempo agotado)' : ''}: ${err.message}`);
    return '';
  } finally {
    clearTimeout(temporizador);
    await worker?.terminate().catch(() => {});
  }
};

export const textoDeImagen = (buf) => textoDeImagenes([buf]);


// Un escaneo es un PDF cuyas páginas son una imagen. Se toma esa imagen ya decodificada por pdf.js (sin dibujar la página, que con el canvas
// nativo es frágil) y se convierte a PNG para el OCR.
const KIND_GRIS_1BPP = 1;
const KIND_RGB = 2;
const KIND_RGBA = 3;
const MAX_LADO = 5000;   // una imagen desmedida agotaría la memoria: se ignora

const aRgba = ({ width, height, kind, data }) => {
  const out = new Uint8ClampedArray(width * height * 4);
  if (kind === KIND_RGBA) { out.set(data.subarray(0, out.length)); return out; }
  if (kind === KIND_RGB) {
    for (let i = 0, j = 0; i < width * height; i++, j += 3) { out[i * 4] = data[j]; out[i * 4 + 1] = data[j + 1]; out[i * 4 + 2] = data[j + 2]; out[i * 4 + 3] = 255; }
    return out;
  }
  if (kind === KIND_GRIS_1BPP) {
    const bytesFila = Math.ceil(width / 8);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = (data[y * bytesFila + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        const k = (y * width + x) * 4;
        out[k] = v; out[k + 1] = v; out[k + 2] = v; out[k + 3] = 255;
      }
    }
    return out;
  }
  return null;
};

/** La imagen más grande de cada una de las primeras páginas de un PDF, como PNG */
export const paginasComoImagenes = async (buf) => {
  let doc;
  try {
    const { createCanvas, ImageData } = await import('@napi-rs/canvas');
    doc = await getDocument({ data: new Uint8Array(buf), isEvalSupported: false, verbosity: 0 }).promise;
    const salida = [];
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGINAS_PDF); i++) {
      const pagina = await doc.getPage(i);
      const ops = await pagina.getOperatorList();
      let mejor = null;
      for (let k = 0; k < ops.fnArray.length; k++) {
        if (ops.fnArray[k] !== OPS.paintImageXObject) continue;
        const img = await new Promise((resolve) => { pagina.objs.get(ops.argsArray[k][0], resolve); });
        if (img?.data && img.width <= MAX_LADO && img.height <= MAX_LADO && (!mejor || img.width * img.height > mejor.width * mejor.height)) mejor = img;
      }
      const rgba = mejor && aRgba(mejor);
      if (!rgba) continue;
      const canvas = createCanvas(mejor.width, mejor.height);
      canvas.getContext('2d').putImageData(new ImageData(rgba, mejor.width, mejor.height), 0, 0);
      salida.push(canvas.toBuffer('image/png'));
    }
    return salida;
  } catch (err) {
    logger.warn(`No se pudieron extraer las imágenes del PDF para OCR: ${err.message}`);
    return [];
  } finally {
    await doc?.destroy().catch(() => {});
  }
};

/** Texto de un PDF escaneado: extrae la imagen de sus páginas y la lee por OCR */
export const textoDePdfEscaneado = async (buf) => {
  const imagenes = await paginasComoImagenes(buf);
  return imagenes.length ? textoDeImagenes(imagenes) : '';
};
