import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Llena el "Formulario de vinculación asociado y/o actualización de datos" (Formato No. 5,
 * Superintendencia de la Economía Solidaria) con los datos de una vinculación.
 *
 * La plantilla es el PDF oficial (plano, sin campos rellenables), así que cada dato se escribe
 * encima en coordenadas fijas. Las coordenadas están en puntos PDF medidos desde la esquina
 * SUPERIOR izquierda de la página (como se ve en pantalla); `y()` las convierte al sistema de pdf-lib.
 */

const RUTA_PLANTILLA = join(dirname(fileURLToPath(import.meta.url)), '../assets/formato-vinculacion.pdf');
const ALTO_PAGINA = 935.433;
const TINTA = rgb(0.05, 0.08, 0.30);
const BLANCO = rgb(1, 1, 1);
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// ── Utilidades de formato ────────────────────────────────────────────────────

// Helvetica (WinAnsi) solo dibuja Latin-1: lo demás (emoji, otros alfabetos) se descarta en vez de romper el PDF.
const limpiar = (v) => String(v ?? '').normalize('NFC').replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7E¡-ÿ]/g, '').trim();

const partesFecha = (v) => {
  if (!v) return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : { a: String(v.getFullYear()), m: String(v.getMonth() + 1).padStart(2, '0'), d: String(v.getDate()).padStart(2, '0') };
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? { a: m[1], m: m[2], d: m[3] } : null;
};
const fechaCorta = (v) => { const f = partesFecha(v); return f ? `${f.d}/${f.m}/${f.a}` : ''; };
const numero = (n) => (n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? '' : Number(n).toLocaleString('es-CO'));
const nombreCompleto = (d) => [d.nombres, d.apellidos].filter(Boolean).join(' ');

// ── Pintor: escribe sobre una página con las coordenadas de la plantilla ─────

const crearPintor = (page, fuente, negrita) => {
  const y = (top) => ALTO_PAGINA - top;

  /** Escribe `valor` con la línea base en `top`. Reduce la letra (hasta 6 pt) y, si aun así no cabe, abrevia. */
  const texto = (valor, x, top, { size = 9, ancho = null, centrar = false, font = fuente } = {}) => {
    let t = limpiar(valor);
    if (!t) return;
    let s = size;
    if (ancho) {
      while (s > 6 && font.widthOfTextAtSize(t, s) > ancho) s -= 0.5;
      if (font.widthOfTextAtSize(t, s) > ancho) {
        while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, s) > ancho) t = t.slice(0, -1);
        t = `${t}...`;
      }
    }
    const w = font.widthOfTextAtSize(t, s);
    page.drawText(t, { x: centrar ? x - w / 2 : x, y: y(top), size: s, font, color: TINTA });
  };

  /** Marca una casilla con una X centrada en (cx, cy). */
  const marca = (cx, cy, r = 3.3) => {
    const o = { thickness: 1.4, color: TINTA };
    page.drawLine({ start: { x: cx - r, y: y(cy) - r }, end: { x: cx + r, y: y(cy) + r }, ...o });
    page.drawLine({ start: { x: cx - r, y: y(cy) + r }, end: { x: cx + r, y: y(cy) - r }, ...o });
  };

  /** Casillas Sí / No de un dato booleano; si no se conoce (null/undefined) no se marca ninguna. */
  const siNo = (valor, casillaSi, casillaNo) => {
    if (valor === true) marca(...casillaSi);
    else if (valor === false) marca(...casillaNo);
  };

  /** Fecha en las cajitas DD | MM | AA: tapa la ayuda gris de la plantilla y escribe los dígitos. */
  const fechaEnCajas = (valor, centros, top, { anioCompleto = false } = {}) => {
    const f = partesFecha(valor);
    if (!f) return;
    [f.d, f.m, anioCompleto ? f.a : f.a.slice(2)].forEach((digitos, i) => {
      const cx = centros[i];
      const ancho = i === 2 && anioCompleto ? 26 : 17;
      page.drawRectangle({ x: cx - ancho / 2, y: y(top) - 2, width: ancho, height: 10, color: BLANCO });
      texto(digitos, cx, top, { size: 9, centrar: true });
    });
  };

  /** Texto largo repartido por renglones: cada renglón tiene su x, su línea base y su ancho disponible. */
  const parrafo = (valor, renglones, size = 8.5) => {
    const palabras = limpiar(valor).split(' ').filter(Boolean);
    let i = 0;
    for (const r of renglones) {
      let linea = '';
      while (i < palabras.length) {
        const prueba = linea ? `${linea} ${palabras[i]}` : palabras[i];
        if (fuente.widthOfTextAtSize(prueba, size) > r.ancho && linea) break;
        linea = prueba;
        i += 1;
      }
      texto(linea, r.x, r.top, { size, ancho: r.ancho });
      if (i >= palabras.length) break;
    }
  };

  return { texto, marca, siNo, fechaEnCajas, parrafo, y, negrita };
};

// ── Página 1: información personal, laboral, PEP, financiera y beneficios ────

const pagina1 = (p, d) => {
  const { texto, marca, siNo, fechaEnCajas } = p;

  // Encabezado: fecha del formulario y tipo (una vinculación nueva es una afiliación)
  const fechaForm = partesFecha(d.firma_at) || partesFecha(new Date());
  texto(fechaForm.d, 515, 138, { size: 10, centrar: true });
  texto(fechaForm.m, 550.5, 138, { size: 10, centrar: true });
  texto(fechaForm.a, 590, 138, { size: 10, centrar: true });
  marca(598.5, 157);

  // Información personal
  texto(d.apellidos, 36, 268, { size: 10, ancho: 278 });
  texto(d.nombres, 327, 268, { size: 10, ancho: 290 });

  const tipoDoc = { CC: 92, TI: 114, CE: 141, PAS: 165.5 }[d.tipo_documento];
  if (tipoDoc) marca(tipoDoc, 280.5);
  texto(d.cedula, 52, 300, { ancho: 118 });
  texto(d.ciudad_expedicion, 181, 300, { ancho: 98 });
  fechaEnCajas(d.fecha_expedicion, [292, 313.5, 336], 299.5);
  texto(fechaCorta(d.fecha_nacimiento), 350, 300, { ancho: 72 });
  texto(d.ciudad_nacimiento, 428, 300, { ancho: 92 });
  texto(d.departamento_nacimiento, 527, 300, { ancho: 92 });

  texto(d.direccion_residencia, 35, 330, { ancho: 330 });
  texto(d.ciudad_residencia, 374, 330, { ancho: 128 });
  texto(d.departamento_residencia, 511, 330, { ancho: 108 });

  texto(d.telefono_fijo, 35, 358, { ancho: 96 });
  texto(d.celular, 141, 358, { ancho: 118 });
  if (d.genero === 'M') marca(279.3, 356);
  if (d.genero === 'F') marca(305, 356);
  texto(d.nivel_academico, 322, 358, { ancho: 132 });
  texto(d.profesion, 462, 358, { ancho: 156 });

  texto(d.correo, 35, 388, { ancho: 580 });

  const civil = { soltero: [164.5, 401], casado: [230.5, 401], union_libre: [301.5, 401], separado: [88.5, 412], divorciado: [164.5, 412], viudo: [230.5, 412] }[d.estado_civil];
  if (civil) marca(...civil);
  const vivienda = { propia: [379.5, 410.5], arrendada: [456.5, 410.5], familiar: [524.5, 411] }[d.tipo_vivienda];
  if (vivienda) marca(...vivienda);
  texto(d.estrato, 546, 414);

  siNo(d.cabeza_de_hogar, [60.5, 438], [98.5, 438]);
  texto(d.personas_a_cargo, 241, 441);
  siNo(d.instruccion_cooperativa, [363.5, 438], [401.5, 438]);
  siNo(d.declarante_de_renta, [522.5, 438], [560.5, 438]);

  if (['casado', 'union_libre'].includes(d.estado_civil)) {
    texto(d.conyuge_nombre, 34, 473, { ancho: 138 });
    texto(d.conyuge_cedula, 182, 473, { ancho: 138 });
    fechaEnCajas(d.conyuge_fecha_nacimiento, [404, 428.7, 457], 469.5);
    texto(d.conyuge_actividad, 479, 473, { ancho: 138 });
  }

  // Información laboral
  texto(d.empresa_nombre, 36, 527, { ancho: 580 });
  texto(d.direccion_trabajo, 36, 551, { ancho: 345 });
  texto(d.telefono_trabajo, 422, 550, { ancho: 122 });
  texto(d.ciudad_trabajo, 36, 577, { ancho: 116 });
  texto(d.departamento_trabajo, 163, 577, { ancho: 98 });
  fechaEnCajas(d.fecha_ingreso, [333, 363, 398], 579, { anioCompleto: true });
  texto(d.cargo, 426, 577, { ancho: 192 });

  const contrato = { fijo: [144.5, 590], indefinido: [225.5, 590], prestacion_servicios: [121.5, 604] }[d.tipo_contrato];
  if (contrato) marca(...contrato);
  if (d.tipo_contrato === 'otro') texto('Otro', 166, 606);
  siNo(d.maneja_recursos_publicos, [294.5, 603], [329.5, 603]);
  texto(d.maneja_recursos_desc, 378, 606, { ancho: 236 });

  // Personas públicamente expuestas: izquierda = preguntas 1 y 3, derecha = 2 y 4
  siNo(d.pep_maneja_recursos_publicos, [254.6, 644.7], [277.5, 644.7]);
  siNo(d.pep_reconocimiento_publico, [584.5, 644.7], [606.8, 644.7]);
  siNo(d.pep_poder_publico, [254.6, 654.5], [277.5, 654.5]);
  siNo(d.pep_vinculo_expuesto, [584.5, 654.5], [606.8, 654.5]);

  // Moneda extranjera
  siNo(d.moneda_extranjera, [203.5, 706], [236.5, 706]);
  const ext = Array.isArray(d.moneda_extranjera_detalle) ? d.moneda_extranjera_detalle[0] : null;
  if (ext) {
    texto(ext.banco, 99, 738, { ancho: 66 });
    texto(ext.ciudad, 172, 738, { ancho: 78 });
    texto(ext.pais, 257, 738, { ancho: 82 });
    texto(ext.monto ? numero(ext.monto) : '', 346, 738, { ancho: 78 });
    texto(ext.moneda, 430, 738, { ancho: 78 });
    texto(ext.cuenta, 514, 738, { ancho: 104 });
  }

  // Situación financiera (los valores van después de cada rótulo impreso)
  texto(d.actividad_financiera, 127, 784.5, { ancho: 195 });
  texto(d.ciiu, 354, 784.5, { ancho: 264 });
  texto(numero(d.ingresos_mensuales), 113, 797.3);
  texto(numero(d.egresos_mensuales), 407, 797.3);
  texto(numero(d.otros_ingresos), 95, 810.1);
  texto(d.otros_ingresos_desc, 361, 810.1, { ancho: 255 });
  texto(numero(d.total_activos), 89, 822.9);
  texto(numero(d.total_pasivos), 386, 822.9);

  // Seguros y beneficios adquiridos
  const aporte = numero(d.valor_aporte);
  texto(aporte ? `${aporte}${d.periodicidad_descuento ? `  (descuento ${d.periodicidad_descuento})` : ''}` : '', 73, 865.5, { ancho: 250 });
  texto(numero(d.cuota_admision), 111, 878.3);
  texto(d.seguro_vida_activo === true ? numero(d.valor_seguro_vida) : d.seguro_vida_activo === false ? 'No' : '', 98, 891.2);
  texto(d.bono_sorteo_activo === true ? numero(d.valor_bono_sorteo) : d.bono_sorteo_activo === false ? 'No' : '', 67, 904);
  // El formato no tiene renglón para el fondo de bienestar: va en "Otros servicios"
  if (d.valor_fondo_bienestar) texto(`Fondo de bienestar $${numero(d.valor_fondo_bienestar)}`, 388, 878.3, { ancho: 228 });
};

// ── Página 2: beneficiarios, referencias, declaraciones y firma ──────────────

const FILAS_BENEFICIARIOS = [74.2, 90.3, 105.6, 120.8, 136.5];

const pagina2 = (p, d, firmaImg) => {
  const { texto, parrafo } = p;

  [...(d.beneficiarios || [])].sort((a, b) => a.orden - b.orden).slice(0, 5).forEach((b, i) => {
    const base = FILAS_BENEFICIARIOS[i] + 11.3;
    texto(String(i + 1), 38.5, base, { centrar: true });
    texto(b.identificacion, 52, base, { ancho: 105 });
    texto(b.nombres, 163, base, { ancho: 189 });
    texto(`${Number(b.porcentaje)}%`, 378, base, { centrar: true });
    texto(fechaCorta(b.fecha_nacimiento), 406, base, { ancho: 108 });
    texto(b.parentesco, 522, base, { ancho: 98 });
  });

  // Referencias: cada una va en la fila de su tipo; si esa fila ya está ocupada, en la otra
  const filas = { personal: 200.5, familiar: 214.7 };
  const usadas = new Set();
  for (const r of d.referencias || []) {
    let tipo = r.tipo === 'familiar' ? 'familiar' : 'personal';
    if (usadas.has(tipo)) tipo = tipo === 'personal' ? 'familiar' : 'personal';
    if (usadas.has(tipo)) continue;
    usadas.add(tipo);
    texto(r.nombres, 117, filas[tipo], { ancho: 306 });
    texto(r.telefono_fijo, 432, filas[tipo], { ancho: 78 });
    texto(r.celular, 518, filas[tipo], { ancho: 100 });
  }

  // Autorización de descuento de nómina y origen de fondos
  texto(d.empresa_nombre, 326, 249, { size: 8.5, ancho: 184 });
  parrafo(d.origen_fondos, [
    { x: 550, top: 297.5, ancho: 66 },
    { x: 35, top: 308.5, ancho: 580 },
    { x: 35, top: 321.8, ancho: 580 },
  ]);

  // Declaración del asociado: fecha, nombre, cédula y firma
  const f = partesFecha(d.firma_at);
  if (f) {
    texto(String(Number(f.d)), 132, 654, { centrar: true });
    texto(MESES[Number(f.m) - 1], 190, 654, { ancho: 92 });
    texto(f.a, 343, 654, { centrar: true });
  }
  texto(nombreCompleto(d), 37, 695.5, { size: 8.5, ancho: 200 });
  texto(d.cedula, 418, 695.5, { ancho: 108 });

  if (firmaImg) {
    const caja = { ancho: 150, alto: 36 };
    const k = Math.min(caja.ancho / firmaImg.width, caja.alto / firmaImg.height);
    const w = firmaImg.width * k;
    const h = firmaImg.height * k;
    p.page.drawImage(firmaImg, { x: 252 + (caja.ancho - w) / 2, y: p.y(696) , width: w, height: h });
  }

  // Entrevista: quién atendió y cuándo
  texto(d.asesor_nombre, 82, 745.5, { ancho: 228 });
  texto(fechaCorta(d.firma_at || new Date()), 222, 772.5, { ancho: 88 });
};

// ── Punto de entrada ─────────────────────────────────────────────────────────

/**
 * @param {object} datos vinculación + prospecto en columnas planas (ver getVinculacion), más
 *   empresa_nombre, asesor_nombre, beneficiarios[], referencias[] y firma_png (data URL PNG, opcional).
 * @returns {Promise<Buffer>} el PDF listo para enviar o descargar.
 */
export const generarFormatoVinculacion = async (datos) => {
  const pdf = await PDFDocument.load(await readFile(RUTA_PLANTILLA));
  const fuente  = await pdf.embedFont(StandardFonts.Helvetica);
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold);
  const [pag1, pag2] = pdf.getPages();

  let firmaImg = null;
  const m = /^data:image\/png;base64,(.+)$/.exec(datos.firma_png || '');
  if (m) {
    try { firmaImg = await pdf.embedPng(Buffer.from(m[1], 'base64')); } catch { /* firma ilegible: se deja el espacio en blanco */ }
  }

  const p1 = crearPintor(pag1, fuente, negrita);
  pagina1(p1, datos);
  const p2 = crearPintor(pag2, fuente, negrita);
  p2.page = pag2;
  pagina2(p2, datos, firmaImg);

  pdf.setTitle(`Formulario de vinculación — ${nombreCompleto(datos)}`);
  pdf.setSubject('Cooperativa Progresemos — Formato No. 5');
  return Buffer.from(await pdf.save());
};
