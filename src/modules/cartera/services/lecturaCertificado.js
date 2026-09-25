import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Lectura del certificado bancario del asociado SIN servicios externos: el texto se extrae del propio PDF (los certificados que baja el
 * asociado desde la app del banco traen texto seleccionable) y se interpreta con una plantilla por banco. El resultado es solo una
 * SUGERENCIA para Cartera, que confirma o corrige: nunca se guarda solo.
 *
 * Si el PDF no trae texto (foto o escaneo) o no coincide con ninguna plantilla, no se inventa nada: se devuelve el estado y Cartera digita.
 */

const MAX_PAGINAS = 3;
const MESES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
export const DIAS_VIGENCIA = 30;

/** Texto del PDF (primeras páginas) en una sola línea normalizada. Devuelve '' si no se puede leer. */
export const textoDePdf = async (buf) => {
  let doc;
  try {
    doc = await getDocument({ data: new Uint8Array(buf), useSystemFonts: false, isEvalSupported: false, verbosity: 0 }).promise;
    const partes = [];
    for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGINAS); i++) {
      const contenido = await (await doc.getPage(i)).getTextContent();
      partes.push(contenido.items.map((x) => x.str).join(' '));
    }
    return partes.join(' ').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  } finally {
    await doc?.destroy().catch(() => {});
  }
};

const isoFecha = (dia, mes, anio) => `${anio}-${String(MESES[mes.toLowerCase()]).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '');
const TIPO_CUENTA = { ahorros: 'ahorros', corriente: 'corriente' };

// ── Plantillas por banco ──────────────────────────────────────────────────────
// Cada una recibe el texto normalizado y devuelve los datos del certificado, o null si no es de ese banco.
const bancolombia = (t) => {
  if (!/Bancolombia\s+S\.?A\.?/i.test(t)) return null;
  const titular = t.match(/se permite informar que\s+(.+?)\s+identificad[oa]\s*(?:\(\s*a\s*\))?\s+con\s+([A-Za-z]{2,3})\s+([\d.]+)/i);
  const cuentas = [...t.matchAll(/Cuenta\s+(?:de\s+)?(ahorros|corriente)\s+(\d{6,20})\s+(\d{4}-\d{2}-\d{2})\s+([A-Za-zÁÉÍÓÚáéíóúñ]+)/gi)]
    .map((m) => ({ tipo_cuenta: TIPO_CUENTA[m[1].toLowerCase()], numero_cuenta: m[2], apertura: m[3], estado: m[4].toLowerCase() }));
  const fecha = t.match(/(\d{1,2})\s+de\s+([A-Za-zñ]+)\s+de\s+(\d{4})/);
  return {
    plantilla: 'bancolombia', banco: 'Bancolombia',
    titular_nombre: titular ? titular[1].trim() : null, tipo_documento: titular ? titular[2].toUpperCase() : null, titular_documento: titular ? soloDigitos(titular[3]) : null,
    expedicion: fecha && MESES[fecha[2].toLowerCase()] ? isoFecha(fecha[1], fecha[2], fecha[3]) : null,
    cuentas,
  };
};

export const PLANTILLAS = [bancolombia];

const diasEntre = (desdeISO, hastaISO) => Math.round((Date.parse(`${hastaISO}T00:00:00Z`) - Date.parse(`${desdeISO}T00:00:00Z`)) / 86400000);

/**
 * Interpreta el texto de un certificado y lo contrasta con el asociado. `hoy` (YYYY-MM-DD) se inyecta para poder probar la vigencia.
 * Estados: leido | no_reconocido (hay texto pero ninguna plantilla lo entiende) | sin_texto (imagen o escaneo).
 */
export const interpretarCertificado = (texto, { asociadoCodigo, hoy, origen = 'texto' }) => {
  if (!texto || texto.length < 20) return { estado: 'sin_texto', alertas: [] };
  for (const plantilla of PLANTILLAS) {
    const d = plantilla(texto);
    if (!d) continue;
    if (!d.titular_documento || d.cuentas.length === 0) return { estado: 'no_reconocido', plantilla: d.plantilla, alertas: [] };
    const alertas = [];
    // Una foto o un escaneo se lee por reconocimiento de imagen, que a veces confunde dígitos (un 5 por un 7): siempre se verifica a mano
    if (origen === 'ocr') alertas.push({ codigo: 'lectura_ocr', nivel: 'aviso', texto: 'Leído de una imagen por reconocimiento automático: puede confundir dígitos. Verifica cada dato contra el certificado.' });
    if (soloDigitos(d.titular_documento) !== soloDigitos(asociadoCodigo)) {
      alertas.push({ codigo: 'titular_distinto', nivel: 'error', texto: `El certificado es de otra persona (documento ${d.titular_documento}), no del asociado (${asociadoCodigo}). Sería un pago a un tercero.` });
    }
    const dias = d.expedicion ? diasEntre(d.expedicion, hoy) : null;
    if (dias == null) alertas.push({ codigo: 'sin_fecha', nivel: 'aviso', texto: 'No se pudo leer la fecha de expedición del certificado.' });
    else if (dias > DIAS_VIGENCIA) alertas.push({ codigo: 'vencido', nivel: 'aviso', texto: `El certificado tiene ${dias} días de expedido (más de ${DIAS_VIGENCIA}). Conviene pedir uno reciente.` });
    else if (dias < 0) alertas.push({ codigo: 'fecha_futura', nivel: 'aviso', texto: 'La fecha de expedición del certificado es posterior a hoy.' });
    for (const c of d.cuentas) {
      if (c.estado !== 'activo' && c.estado !== 'activa') alertas.push({ codigo: 'cuenta_no_activa', nivel: 'error', texto: `La cuenta terminada en ${c.numero_cuenta.slice(-4)} figura "${c.estado}" en el certificado.` });
    }
    if (d.cuentas.length > 1) alertas.push({ codigo: 'varias_cuentas', nivel: 'aviso', texto: 'El certificado lista varias cuentas: elige la que corresponde.' });
    return { estado: 'leido', origen, ...d, dias, alertas };
  }
  return { estado: 'no_reconocido', alertas: [] };
};
