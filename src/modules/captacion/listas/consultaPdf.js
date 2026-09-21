import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib';
import { FUENTES } from './fuentes.js';
import { CHECKLIST_MANUAL } from './checklist.js';

const RUTA_LOGO = join(dirname(fileURLToPath(import.meta.url)), '../assets/logo-horizontal.png');
let logoBytes = null;

// pdf-lib con las fuentes estándar escribe Latin-1 y la puntuación de WinAnsi (guiones largos, comillas curvas, viñeta, puntos suspensivos):
// el resto (árabe, cirílico…) se reemplaza por "?"
const seguro = (t) => String(t ?? '').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u20AC]/g, '?');

// Paleta del logo de Progresemos
const hex = (h) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const C = {
  azul: hex('#065B8E'), verde: hex('#5B9C3C'), dorado: hex('#F6AD18'), bosque: hex('#344B27'),
  tinta: hex('#1B2530'), gris: hex('#6B7580'), linea: hex('#DCE3EA'), blanco: rgb(1, 1, 1),
  azulSuave: hex('#E8F1F7'), verdeSuave: hex('#EEF5E9'), zebra: hex('#F6F9FB'),
  rojo: hex('#A32A24'), rojoSuave: hex('#FBE7E5'), ambar: hex('#8A5A00'), ambarSuave: hex('#FFF3D6'),
};

const A4 = { w: 595.28, h: 841.89 };
const M = 40;                       // margen lateral
const ANCHO = A4.w - M * 2;
const PIE = 46;                     // alto reservado al pie de página
const CONTACTO = 'www.cooperativaprogresemos.coop  ·  (314) 350-3254';

const fechaHoraBogota = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : `${d.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'medium', timeStyle: 'short' })} (hora Colombia)`;
};
const RESULTADO_MANUAL = { sin_hallazgos: 'Sin hallazgos', hallazgo: 'CON HALLAZGO', no_aplica: 'No aplica' };

/**
 * Constancia de la consulta en listas restrictivas y fuentes abiertas, con la identidad visual de la cooperativa. Es el soporte que se
 * anexa al expediente: datos consultados, versión (fecha y hash) de cada lista usada, resultado, decisión razonada sobre cada
 * coincidencia, consultas manuales, conclusión y validación del Oficial de Cumplimiento.
 */
export const generarPdfConsulta = async (c, { asesorNombre, oficialNombre = null, generadaAt = new Date() }) => {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Constancia de consulta en listas restrictivas');
  pdf.setAuthor('Cooperativa Progresemos — Kernel');
  pdf.setSubject(`Consulta ${c.id}`);
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold);
  logoBytes ??= await readFile(RUTA_LOGO);
  const logo = await pdf.embedPng(logoBytes);

  let pagina;
  let top = 0;                                  // distancia desde el borde superior de la página
  const Y = (t) => A4.h - t;
  const limite = () => A4.h - PIE;

  // ── Texto ────────────────────────────────────────────────────────────────
  const ancho = (t, f, s) => f.widthOfTextAtSize(t, s);
  const partir = (texto, f, s, max) => {
    const out = [];
    for (const parrafo of seguro(texto).split('\n')) {
      let actual = '';
      for (const palabra of parrafo.split(/\s+/).filter(Boolean)) {
        let p = palabra;
        while (ancho(p, f, s) > max) {          // palabra más larga que la línea (hashes, URLs)
          let n = p.length;
          while (n > 1 && ancho(p.slice(0, n), f, s) > max) n--;
          if (actual) { out.push(actual); actual = ''; }
          out.push(p.slice(0, n));
          p = p.slice(n);
        }
        const prueba = actual ? `${actual} ${p}` : p;
        if (ancho(prueba, f, s) > max && actual) { out.push(actual); actual = p; } else actual = prueba;
      }
      out.push(actual);
    }
    return out;
  };
  const dibujar = (t, x, tp, { size = 9, bold = false, color = C.tinta, derecha = null } = {}) => {
    const f = bold ? negrita : normal;
    const tx = seguro(t);
    pagina.drawText(tx, { x: derecha !== null ? derecha - ancho(tx, f, size) : x, y: Y(tp) - size * 0.8, size, font: f, color });
  };
  const interlinea = (s) => s * 1.32;

  // ── Página y encabezado ────────────────────────────────────────────────────
  const nuevaPagina = (primera = false) => {
    pagina = pdf.addPage([A4.w, A4.h]);
    // Franja de color arriba (azul y verde del logo, con un toque dorado)
    pagina.drawRectangle({ x: 0, y: Y(7), width: A4.w * 0.56, height: 7, color: C.azul });
    pagina.drawRectangle({ x: A4.w * 0.56, y: Y(7), width: A4.w * 0.36, height: 7, color: C.verde });
    pagina.drawRectangle({ x: A4.w * 0.92, y: Y(7), width: A4.w * 0.08, height: 7, color: C.dorado });
    const alto = primera ? 40 : 26;
    const escala = alto / logo.height;
    pagina.drawImage(logo, { x: M, y: Y(22 + alto), width: logo.width * escala, height: alto });
    dibujar('CONSTANCIA DE CONSULTA EN LISTAS', 0, 27, { size: 7.5, bold: true, color: C.azul, derecha: A4.w - M });
    dibujar('Prevención de LA/FT (SARLAFT)', 0, 38, { size: 7.5, color: C.gris, derecha: A4.w - M });
    top = 22 + alto + 16;
  };
  const asegurar = (alto) => { if (top + alto > limite()) nuevaPagina(); };

  // ── Bloques ────────────────────────────────────────────────────────────────
  const seccion = (titulo) => {
    asegurar(110);   // un título nunca queda solo al final de la página: tiene que caber con algo de su contenido
    top += 12;
    pagina.drawRectangle({ x: M, y: Y(top + 11), width: 4, height: 11, color: C.dorado });
    dibujar(titulo.toUpperCase(), M + 11, top, { size: 10, bold: true, color: C.azul });
    top += 15;
    pagina.drawLine({ start: { x: M, y: Y(top) }, end: { x: M + ANCHO, y: Y(top) }, thickness: 0.7, color: C.linea });
    top += 8;
  };

  // Tarjeta con fondo suave y barra de color a la izquierda; `lineas` = [{texto,size,bold,color,despues}]
  const tarjeta = (lineas, { fondo = C.zebra, barra = C.azul, pad = 9, x = M, w = ANCHO } = {}) => {
    const interior = w - pad * 2 - 6;
    const armadas = lineas.map((l) => {
      const size = l.size ?? 8.5;
      const f = l.bold ? negrita : normal;
      return { ...l, size, f, partes: partir(l.texto, f, size, interior - (l.indent ?? 0)) };
    });
    const alto = armadas.reduce((h, l) => h + l.partes.length * interlinea(l.size) + (l.despues ?? 2), 0) + pad * 2 - 2;
    asegurar(alto + 6);
    pagina.drawRectangle({ x, y: Y(top + alto), width: w, height: alto, color: fondo });
    pagina.drawRectangle({ x, y: Y(top + alto), width: 3.5, height: alto, color: barra });
    let cy = top + pad;
    for (const l of armadas) {
      for (const linea of l.partes) {
        dibujar(linea, x + pad + 6 + (l.indent ?? 0), cy, { size: l.size, bold: l.bold, color: l.color ?? C.tinta });
        cy += interlinea(l.size);
      }
      cy += l.despues ?? 2;
    }
    top += alto + 6;
  };

  // Enlace clicable sobre un rectángulo de la página (para que quien lea el PDF pueda abrir cada resultado)
  const enlazar = (url, x, tp, w, alto) => {
    let destino;
    try { destino = new URL(url).href; } catch { return; }
    const anot = pdf.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: [x, Y(tp + alto), x + w, Y(tp)], Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(destino) },
    });
    pagina.node.addAnnot(pdf.context.register(anot));
  };

  // Un resultado de la búsqueda web: título (enlace), sitio y resumen breve
  const resultadoWeb = (r) => {
    const tituloL = partir(r.titulo || r.url, negrita, 8.4, ANCHO - 16);
    const resumenL = r.resumen ? partir(r.resumen, normal, 7.6, ANCHO - 16) : [];
    const alto = tituloL.length * interlinea(8.4) + interlinea(7.4) + resumenL.length * interlinea(7.6) + 7;
    asegurar(alto);
    pagina.drawRectangle({ x: M + 2, y: Y(top + alto - 3), width: 2, height: alto - 5, color: C.linea });
    let cy = top;
    for (const l of tituloL) {
      dibujar(l, M + 10, cy, { size: 8.4, bold: true, color: C.azul });
      pagina.drawLine({ start: { x: M + 10, y: Y(cy + 9.6) }, end: { x: M + 10 + ancho(seguro(l), negrita, 8.4), y: Y(cy + 9.6) }, thickness: 0.4, color: C.azul });
      enlazar(r.url, M + 10, cy, ancho(seguro(l), negrita, 8.4), 10);
      cy += interlinea(8.4);
    }
    dibujar(`${r.dominio || ''}${r.edad ? `  ·  ${r.edad}` : ''}`, M + 10, cy, { size: 7.2, bold: true, color: C.verde });
    cy += interlinea(7.4);
    for (const l of resumenL) { dibujar(l, M + 10, cy, { size: 7.6, color: C.tinta }); cy += interlinea(7.6); }
    top += alto;
  };

  // Tabla con encabezado azul, filas alternadas y texto ajustado por columna
  const tabla = (columnas, filas) => {
    const cabecera = () => {
      asegurar(28);
      pagina.drawRectangle({ x: M, y: Y(top + 16), width: ANCHO, height: 16, color: C.azul });
      let x = M;
      for (const col of columnas) { dibujar(col.titulo.toUpperCase(), x + 6, top + 4.5, { size: 7, bold: true, color: C.blanco }); x += col.w; }
      top += 16;
    };
    cabecera();
    filas.forEach((fila, i) => {
      const celdas = columnas.map((col, k) => {
        const cel = fila[k] ?? { texto: '' };
        const size = cel.size ?? 8;
        const f = cel.bold ? negrita : normal;
        return { ...cel, size, partes: partir(cel.texto, f, size, col.w - 12) };
      });
      const alto = Math.max(...celdas.map((cl) => cl.partes.length * interlinea(cl.size))) + 9;
      if (top + alto > limite()) { nuevaPagina(); cabecera(); }
      if (i % 2 === 0) pagina.drawRectangle({ x: M, y: Y(top + alto), width: ANCHO, height: alto, color: C.zebra });
      let x = M;
      celdas.forEach((cl, k) => {
        let cy = top + 4.5;
        for (const linea of cl.partes) { dibujar(linea, x + 6, cy, { size: cl.size, bold: cl.bold, color: cl.color ?? C.tinta }); cy += interlinea(cl.size); }
        x += columnas[k].w;
      });
      top += alto;
    });
    pagina.drawLine({ start: { x: M, y: Y(top) }, end: { x: M + ANCHO, y: Y(top) }, thickness: 0.7, color: C.linea });
    top += 6;
  };

  // ── Datos de la consulta ───────────────────────────────────────────────────
  const coincidencias = c.coincidencias || [];
  const confirmadas = coincidencias.filter((x) => x.decision === 'confirmada').length;
  const descartadas = coincidencias.filter((x) => x.decision === 'descartada').length;
  const hallazgos = c.conclusion === 'con_hallazgos';
  const validada = c.estado === 'validada' && c.validada_at;
  // Nombre legible de la lista (sin el detalle entre paréntesis)
  const nombreFuente = (codigo) => String(c.versiones?.[codigo]?.nombre || FUENTES[codigo]?.nombre || codigo).replace(/\s*\(.*\)\s*$/, '');
  const vinculanteConfirmada = coincidencias.some((x) => x.decision === 'confirmada' && FUENTES[x.fuente]?.vinculante);
  const versiones = Object.entries(c.versiones || {});
  const disponibles = versiones.filter(([, v]) => v.disponible).length;

  nuevaPagina(true);
  dibujar('Constancia de consulta en listas', M, top, { size: 19, bold: true, color: C.azul });
  top += 24;
  dibujar('restrictivas y fuentes abiertas', M, top, { size: 19, bold: true, color: C.verde });
  top += 28;

  // Resumen: lo primero que ve quien la revisa
  tarjeta([
    { texto: hallazgos ? 'CON HALLAZGOS' : 'SIN HALLAZGOS', size: 15, bold: true, color: hallazgos ? C.rojo : C.bosque, despues: 4 },
    { texto: hallazgos ? 'Hay coincidencias confirmadas o hallazgos en las consultas manuales. Requiere análisis del Oficial de Cumplimiento.'
      : 'No hay coincidencias confirmadas ni hallazgos en las consultas realizadas.', size: 8.5, despues: 5 },
    { texto: `${disponibles} de ${versiones.length} listas consultadas  ·  ${coincidencias.length} coincidencia(s): ${descartadas} descartada(s), ${confirmadas} confirmada(s)`, size: 8, color: C.gris, despues: 1 },
    { texto: validada ? `Validada por ${oficialNombre || 'el Oficial de Cumplimiento'} el ${fechaHoraBogota(c.validada_at)}` : 'Pendiente de validación por el Oficial de Cumplimiento', size: 8, bold: true, color: validada ? C.bosque : C.ambar, despues: 0 },
  ], { fondo: hallazgos ? C.rojoSuave : C.verdeSuave, barra: hallazgos ? C.rojo : C.verde, pad: 12 });

  if (vinculanteConfirmada) {
    tarjeta([{ texto: 'Coincidencia confirmada con una lista vinculante de la ONU: corresponde el reporte inmediato a la UIAF y a la Fiscalía General de la Nación (art. 20, Ley 1121 de 2006) y no se puede vincular al asociado.', size: 8.5, bold: true, color: C.rojo, despues: 0 }],
      { fondo: C.rojoSuave, barra: C.rojo });
  }

  seccion('1. Datos de la consulta');
  const datos = [
    ['Cédula de ciudadanía', c.cedula], ['Nombres', c.nombres], ['Apellidos', c.apellidos],
    ['Fecha de nacimiento', c.fecha_nacimiento ? String(c.fecha_nacimiento).slice(0, 10) : 'No registrada'],
    ['Consulta No.', String(c.id)], ['Fecha y hora', fechaHoraBogota(c.created_at)], ['Realizada por', asesorNombre || '—'],
    ['Cerrada por el asesor', c.cerrada_at ? fechaHoraBogota(c.cerrada_at) : '—'],
  ];
  const mitad = (ANCHO - 8) / 2;
  for (let i = 0; i < datos.length; i += 2) {
    const par = datos.slice(i, i + 2);
    const alturas = par.map(([k, v]) => 10 + partir(v, negrita, 9, mitad - 20).length * interlinea(9) + 8);
    const alto = Math.max(...alturas);
    asegurar(alto + 4);
    par.forEach(([k, v], j) => {
      const x = M + j * (mitad + 8);
      pagina.drawRectangle({ x, y: Y(top + alto), width: mitad, height: alto, color: C.azulSuave });
      dibujar(k.toUpperCase(), x + 10, top + 6, { size: 6.5, bold: true, color: C.azul });
      let cy = top + 17;
      for (const l of partir(v, negrita, 9, mitad - 20)) { dibujar(l, x + 10, cy, { size: 9, bold: true }); cy += interlinea(9); }
    });
    top += alto + 4;
  }

  // ── Listas ─────────────────────────────────────────────────────────────────
  seccion('2. Listas consultadas y versión usada');
  tarjeta([{ texto: 'Cada consulta se hizo contra la copia de la lista descrita abajo. El hash SHA-256 identifica el contenido exacto del archivo original, que se conserva en el sistema.', size: 7.5, color: C.gris, despues: 0 }],
    { fondo: C.blanco, barra: C.linea, pad: 6 });
  tabla(
    [{ titulo: 'Lista', w: 236 }, { titulo: 'Publicada', w: 92 }, { titulo: 'Registros', w: 54 }, { titulo: 'Resultado', w: ANCHO - 236 - 92 - 54 }],
    versiones.map(([codigo, v]) => {
      const n = coincidencias.filter((x) => x.fuente === codigo).length;
      const nombre = `${v.nombre || FUENTES[codigo]?.nombre || codigo}${v.vinculante ? '  [VINCULANTE]' : ''}`;
      if (!v.disponible) return [{ texto: nombre, bold: true }, { texto: '—' }, { texto: '—' }, { texto: 'NO CONSULTADA', bold: true, color: C.rojo }];
      return [
        { texto: `${nombre}\nSHA-256 ${v.sha256}`, bold: false, size: 7.5 },
        { texto: v.publicada ? String(v.publicada).slice(0, 10) : 'Sin fecha' },
        { texto: String(v.registros) },
        { texto: n ? `${n} posible(s)` : 'Sin coincidencias', bold: true, color: n ? C.rojo : C.bosque },
      ];
    })
  );
  const p = c.parametros || {};
  dibujar(`Motor ${p.motor || '—'}  ·  umbral de coincidencia posible ${p.umbral_posible ?? '—'}, fuerte ${p.umbral_fuerte ?? '—'}  ·  PEP, sanciones disciplinarias y responsables fiscales se cotejan solo por cédula`, M, top, { size: 6.8, color: C.gris });
  top += 12;

  // ── Coincidencias ──────────────────────────────────────────────────────────
  seccion('3. Coincidencias y decisión del asesor');
  if (!coincidencias.length) {
    tarjeta([{ texto: 'No se encontraron coincidencias por cédula ni por nombre en ninguna de las listas consultadas.', size: 9, bold: true, color: C.bosque, despues: 0 }], { fondo: C.verdeSuave, barra: C.verde });
  }
  for (const x of coincidencias) {
    const d = x.detalle || {};
    const det = [d.programa && `Programa: ${d.programa}`, d.cargo && `Cargo: ${d.cargo}`, d.entidad && `Entidad: ${d.entidad}`, d.sanciones && `Sanción: ${d.sanciones}`,
      d.fecha_desvinculacion ? `Desvinculado: ${d.fecha_desvinculacion}` : (x.fuente === 'PEP_SIGEP' ? 'PEP activo (sin fecha de desvinculación)' : null),
      x.nacimiento?.length ? `Nacimiento: ${x.nacimiento.join(', ')}` : null, x.documentos?.length ? `Cédula en la lista: ${x.documentos.join(', ')}` : null,
      x.nacionalidades?.length ? `Nacionalidad: ${x.nacionalidades.join(', ')}` : null].filter(Boolean);
    const decision = x.decision === 'confirmada' ? 'CONFIRMADA (es la misma persona)' : x.decision === 'descartada' ? 'DESCARTADA (no es la misma persona)' : 'SIN DECIDIR';
    tarjeta([
      { texto: `${nombreFuente(x.fuente)}  ·  ${x.nombre}${x.nombre_coincidente && x.nombre_coincidente !== x.nombre ? `  (alias: ${x.nombre_coincidente})` : ''}`, size: 9, bold: true, despues: 1 },
      { texto: `${x.tipo === 'documento' ? 'Coincide la cédula' : `Similitud de nombre ${Math.round(x.score * 100)}%`}. ${x.motivo_sugerencia || ''}`, size: 7.8, color: C.gris, despues: 1 },
      ...(det.length ? [{ texto: det.join('   ·   '), size: 7.8, color: C.gris, despues: 3 }] : []),
      { texto: `Decisión: ${decision}${x.decision_motivo ? ` — ${x.decision_motivo}` : ''}`, size: 8.3, bold: true, color: x.decision === 'confirmada' ? C.rojo : x.decision === 'descartada' ? C.bosque : C.ambar, despues: 0 },
    ], { fondo: x.decision === 'confirmada' ? C.rojoSuave : x.decision ? C.zebra : C.ambarSuave, barra: x.decision === 'confirmada' ? C.rojo : x.decision ? C.verde : C.dorado });
  }

  // ── PEP y fuentes abiertas ─────────────────────────────────────────────────
  seccion('4. PEP y fuentes abiertas');
  const dp = c.declaracion_pep;
  if (dp) {
    tarjeta([
      { texto: 'DECLARACIÓN PEP DEL ASOCIADO EN EL FORMULARIO', size: 6.8, bold: true, color: C.azul, despues: 1 },
      { texto: dp.declara_pep ? `Declara vínculo PEP${dp.detalle ? `: ${dp.detalle}` : ''}` : 'No declara ser PEP ni tener vínculo con un PEP', size: 8.8, bold: true, color: dp.declara_pep ? C.ambar : C.bosque, despues: 0 },
    ], { fondo: dp.declara_pep ? C.ambarSuave : C.azulSuave, barra: dp.declara_pep ? C.dorado : C.azul });
  }
  const b = c.busquedas;
  if (b?.consultas?.length) {
    asegurar(50);
    dibujar('RESULTADOS DE LA BÚSQUEDA EN FUENTES ABIERTAS', M, top, { size: 7.5, bold: true, color: C.azul });
    top += 11;
    for (const l of partir(`Enlaces obtenidos automáticamente con ${b.proveedor} el ${fechaHoraBogota(b.ejecutada_at)}. Son pistas: pueden referirse a homónimos. El asesor los revisó y registró su conclusión en la tabla de abajo.`, normal, 7.2, ANCHO)) {
      dibujar(l, M, top, { size: 7.2, color: C.gris }); top += 9.4;
    }
    top += 4;
    for (const q of b.consultas) {
      asegurar(40);
      dibujar(`${q.etiqueta}  —  ${q.q}`, M, top, { size: 7.6, bold: true, color: C.bosque });
      top += 11;
      if (q.error) { dibujar(`No se pudo buscar: ${q.error}`, M + 10, top, { size: 7.6, bold: true, color: C.rojo }); top += 12; continue; }
      if (!q.resultados.length) { dibujar('Sin resultados.', M + 10, top, { size: 7.6, color: C.gris }); top += 12; continue; }
      for (const r of q.resultados.slice(0, 6)) resultadoWeb(r);
      top += 4;
    }
    top += 4;
  }
  tabla(
    [{ titulo: 'Consulta', w: 170 }, { titulo: 'Resultado', w: 88 }, { titulo: 'Detalle', w: ANCHO - 170 - 88 }],
    CHECKLIST_MANUAL.map((item) => {
      const m = (c.manual || {})[item.clave];
      const t = item.titulo + (item.obligatoria ? '' : ' (opcional)');
      if (!m) return [{ texto: t, bold: true }, { texto: 'No consultada', color: C.gris }, { texto: '—', color: C.gris }];
      const detalle = [m.autorizacion_titular && 'Con autorización del titular para la consulta', m.terminos && `Buscó: ${m.terminos}`, m.motor && `Motor: ${m.motor}`, m.consultada_at && `Consultada: ${fechaHoraBogota(m.consultada_at)}`, m.observaciones && `Observaciones: ${m.observaciones}`].filter(Boolean).join('\n');
      return [{ texto: t, bold: true }, { texto: RESULTADO_MANUAL[m.resultado] || m.resultado, bold: true, color: m.resultado === 'hallazgo' ? C.rojo : m.resultado === 'sin_hallazgos' ? C.bosque : C.gris }, { texto: detalle || '—', size: 7.5 }];
    })
  );

  // ── Conclusión y validación ────────────────────────────────────────────────
  seccion('5. Conclusión y validación');
  tarjeta([
    { texto: hallazgos ? 'CON HALLAZGOS' : 'SIN HALLAZGOS', size: 11, bold: true, color: hallazgos ? C.rojo : C.bosque, despues: 3 },
    { texto: 'Este resultado solo vale para las listas y las fechas indicadas en esta constancia: no es una certificación de que la persona carezca de antecedentes.', size: 8, color: C.gris, despues: 0 },
  ], { fondo: hallazgos ? C.rojoSuave : C.verdeSuave, barra: hallazgos ? C.rojo : C.verde });
  tarjeta(validada ? [
    { texto: 'VALIDADA POR EL OFICIAL DE CUMPLIMIENTO', size: 6.8, bold: true, color: C.bosque, despues: 1 },
    { texto: `${oficialNombre || 'Oficial de Cumplimiento'}  ·  ${fechaHoraBogota(c.validada_at)}`, size: 9.3, bold: true, despues: c.observaciones_oficial ? 3 : 0 },
    ...(c.observaciones_oficial ? [{ texto: `Observaciones: ${c.observaciones_oficial}`, size: 8, despues: 0 }] : []),
  ] : [
    { texto: 'VALIDACIÓN DEL OFICIAL DE CUMPLIMIENTO', size: 6.8, bold: true, color: C.ambar, despues: 1 },
    { texto: 'Pendiente. La constancia definitiva llevará su nombre, la fecha y sus observaciones.', size: 8.8, bold: true, despues: 0 },
  ], { fondo: validada ? C.verdeSuave : C.ambarSuave, barra: validada ? C.verde : C.dorado });

  asegurar(30);
  const hashLineas = partir(`Hash SHA-256 de los datos de la consulta: ${c.datos_hash || '—'}`, normal, 6.8, ANCHO);
  hashLineas.forEach((l) => { dibujar(l, M, top, { size: 6.8, color: C.gris }); top += 9; });
  dibujar(`Generado por Kernel el ${fechaHoraBogota(generadaAt)}`, M, top, { size: 6.8, color: C.gris });

  // ── Pie de cada página ─────────────────────────────────────────────────────
  const paginas = pdf.getPages();
  paginas.forEach((pg, i) => {
    pg.drawLine({ start: { x: M, y: 34 }, end: { x: M + ANCHO, y: 34 }, thickness: 0.7, color: C.linea });
    pg.drawText(seguro('Cooperativa Progresemos'), { x: M, y: 22, size: 7.5, font: negrita, color: C.azul });
    pg.drawText(seguro(CONTACTO), { x: M + 104, y: 22, size: 7.5, font: normal, color: C.gris });
    const der = seguro(`Consulta ${String(c.id).slice(0, 8)}  ·  página ${i + 1} de ${paginas.length}`);
    pg.drawText(der, { x: A4.w - M - normal.widthOfTextAtSize(der, 7.5), y: 22, size: 7.5, font: normal, color: C.gris });
  });
  return pdf.save();
};
