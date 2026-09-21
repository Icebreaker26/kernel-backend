import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { FUENTES } from './fuentes.js';
import { CHECKLIST_MANUAL } from './checklist.js';

// pdf-lib con las fuentes estándar solo escribe caracteres Latin-1: el resto (árabe, cirílico…) se reemplaza por "?"
const seguro = (t) => String(t ?? '').replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '?');

const PAGINA = { ancho: 595.28, alto: 841.89 };
const MARGEN = 44;
const GRIS = rgb(0.35, 0.35, 0.35);
const NEGRO = rgb(0.08, 0.08, 0.08);
const ROJO = rgb(0.62, 0.16, 0.14);
const VERDE = rgb(0.12, 0.42, 0.22);

const fechaHoraBogota = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : `${d.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'medium', timeStyle: 'short' })} (hora Colombia)`;
};

const RESULTADO_MANUAL = { sin_hallazgos: 'Sin hallazgos', hallazgo: 'CON HALLAZGO', no_aplica: 'No aplica' };
const DECISION = { descartada: 'DESCARTADA', confirmada: 'CONFIRMADA' };

/**
 * Constancia de la consulta en listas restrictivas y fuentes abiertas. Es el soporte que se anexa al expediente de vinculación:
 * datos consultados, versión (fecha y hash) de cada lista usada, resultado, decisión razonada sobre cada coincidencia, consultas
 * manuales, conclusión y validación del Oficial de Cumplimiento.
 */
export const generarPdfConsulta = async (c, { asesorNombre, oficialNombre = null, generadaAt = new Date() }) => {
  const pdf = await PDFDocument.create();
  const normal = await pdf.embedFont(StandardFonts.Helvetica);
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold);
  let pagina = pdf.addPage([PAGINA.ancho, PAGINA.alto]);
  let y = PAGINA.alto - MARGEN;
  const ancho = PAGINA.ancho - MARGEN * 2;

  const nueva = () => { pagina = pdf.addPage([PAGINA.ancho, PAGINA.alto]); y = PAGINA.alto - MARGEN; };
  const espacio = (n) => { if (y - n < MARGEN + 20) nueva(); };

  const lineas = (texto, fuente, size, maxAncho) => {
    const out = [];
    for (const parrafo of seguro(texto).split('\n')) {
      let actual = '';
      for (const palabra of parrafo.split(/\s+/).filter(Boolean)) {
        const prueba = actual ? `${actual} ${palabra}` : palabra;
        if (fuente.widthOfTextAtSize(prueba, size) > maxAncho && actual) { out.push(actual); actual = palabra; } else actual = prueba;
      }
      out.push(actual);
    }
    return out;
  };

  const escribir = (texto, { size = 9, bold = false, color = NEGRO, indent = 0, despues = 3 } = {}) => {
    const f = bold ? negrita : normal;
    for (const l of lineas(texto, f, size, ancho - indent)) {
      espacio(size + 3);
      pagina.drawText(l, { x: MARGEN + indent, y: y - size, size, font: f, color });
      y -= size + 3;
    }
    y -= despues;
  };
  const titulo = (t) => { espacio(30); y -= 6; escribir(t, { size: 11, bold: true, despues: 2 }); pagina.drawLine({ start: { x: MARGEN, y: y + 1 }, end: { x: MARGEN + ancho, y: y + 1 }, thickness: 0.6, color: GRIS }); y -= 5; };
  const par = (k, v, opts = {}) => escribir(`${k}: ${v ?? '—'}`, { size: 9, ...opts });

  // ── Encabezado ──────────────────────────────────────────────────────────────
  escribir('COOPERATIVA PROGRESEMOS', { size: 9, bold: true, color: GRIS, despues: 0 });
  escribir('Constancia de consulta en listas restrictivas y fuentes abiertas', { size: 15, bold: true, despues: 1 });
  escribir('Prevención de lavado de activos y financiación del terrorismo (SARLAFT) — vinculación de asociado', { size: 9, color: GRIS, despues: 6 });
  par('Consulta No.', c.id);
  par('Fecha y hora de la consulta', fechaHoraBogota(c.created_at));
  par('Realizada por', asesorNombre);
  if (c.cerrada_at) par('Cerrada por el asesor', fechaHoraBogota(c.cerrada_at));

  titulo('1. Datos consultados');
  par('Nombres', c.nombres);
  par('Apellidos', c.apellidos);
  par('Cédula de ciudadanía', c.cedula);
  par('Fecha de nacimiento', c.fecha_nacimiento ? String(c.fecha_nacimiento).slice(0, 10) : 'no registrada');

  // ── Listas ─────────────────────────────────────────────────────────────────
  titulo('2. Listas consultadas y versión usada');
  escribir('Cada consulta se hizo contra la copia de la lista descrita abajo. El hash SHA-256 identifica el contenido exacto del archivo original, que se conserva en el sistema.', { size: 8, color: GRIS });
  const porFuente = (f) => (c.coincidencias || []).filter((x) => x.fuente === f);
  for (const [codigo, v] of Object.entries(c.versiones || {})) {
    const cfg = FUENTES[codigo];
    espacio(56);
    escribir(`${v.nombre || cfg?.nombre || codigo}${v.vinculante ? '  [VINCULANTE PARA COLOMBIA]' : ''}`, { size: 9, bold: true, despues: 1 });
    if (!v.disponible) {
      escribir('NO SE PUDO CONSULTAR: la lista no estaba disponible en el sistema.', { size: 8.5, bold: true, color: ROJO, indent: 10 });
      continue;
    }
    escribir(`Publicada: ${v.publicada || 'sin fecha en el archivo'}  |  Verificada: ${fechaHoraBogota(v.verificada_at)}  |  Registros: ${v.registros}`, { size: 8, color: GRIS, indent: 10, despues: 0 });
    escribir(`SHA-256: ${v.sha256}`, { size: 7, color: GRIS, indent: 10, despues: 0 });
    const n = porFuente(codigo).length;
    escribir(n ? `Resultado: ${n} posible(s) coincidencia(s)` : 'Resultado: sin coincidencias', { size: 8.5, bold: true, color: n ? ROJO : VERDE, indent: 10, despues: 4 });
  }
  const p = c.parametros || {};
  escribir(`Motor: ${p.motor || '—'}. ${p.algoritmo || ''} Umbral de posible coincidencia: ${p.umbral_posible ?? '—'}; coincidencia fuerte: ${p.umbral_fuerte ?? '—'}. Las listas PEP y de sanciones disciplinarias se cotejan solo por número de cédula.`, { size: 7.5, color: GRIS, despues: 2 });

  // ── Coincidencias ──────────────────────────────────────────────────────────
  titulo('3. Coincidencias y decisión del asesor');
  if (!(c.coincidencias || []).length) {
    escribir('No se encontraron coincidencias por cédula ni por nombre en ninguna de las listas consultadas.', { size: 9, bold: true, color: VERDE });
  }
  for (const x of c.coincidencias || []) {
    espacio(70);
    escribir(`${x.fuente} — ${x.nombre}${x.nombre_coincidente && x.nombre_coincidente !== x.nombre ? ` (alias: ${x.nombre_coincidente})` : ''}`, { size: 9, bold: true, despues: 1 });
    escribir(`${x.tipo === 'documento' ? 'Coincide la cédula' : `Similitud de nombre ${Math.round(x.score * 100)}%`}. ${x.motivo_sugerencia || ''}`, { size: 8, color: GRIS, indent: 10, despues: 0 });
    const d = x.detalle || {};
    const det = [d.programa && `Programa: ${d.programa}`, d.cargo && `Cargo: ${d.cargo}`, d.entidad && `Entidad: ${d.entidad}`, d.sanciones && `Sanción: ${d.sanciones}`,
      d.fecha_desvinculacion ? `Desvinculado: ${d.fecha_desvinculacion}` : (x.fuente === 'PEP_SIGEP' ? 'PEP activo (sin fecha de desvinculación)' : null),
      x.nacimiento?.length ? `Nacimiento: ${x.nacimiento.join(', ')}` : null, x.documentos?.length ? `Cédula en la lista: ${x.documentos.join(', ')}` : null].filter(Boolean);
    if (det.length) escribir(det.join('  |  '), { size: 8, color: GRIS, indent: 10, despues: 0 });
    escribir(`Decisión: ${DECISION[x.decision] || 'SIN DECIDIR'} — ${x.decision_motivo || ''}`, { size: 8.5, bold: true, color: x.decision === 'confirmada' ? ROJO : NEGRO, indent: 10, despues: 5 });
  }

  // ── PEP y consultas manuales ────────────────────────────────────────────────
  titulo('4. PEP y fuentes abiertas');
  const dp = c.declaracion_pep;
  if (dp) {
    par('Declaración PEP del asociado en el formulario', dp.declara_pep ? 'DECLARA SER O HABER SIDO PEP / TENER VÍNCULO CON UN PEP' : 'No declara ser PEP ni tener vínculo con un PEP');
    if (dp.detalle) escribir(dp.detalle, { size: 8, color: GRIS, indent: 10 });
  }
  for (const item of CHECKLIST_MANUAL) {
    const m = (c.manual || {})[item.clave];
    espacio(44);
    escribir(`${item.titulo}${item.obligatoria ? '' : ' (opcional)'}`, { size: 9, bold: true, despues: 1 });
    if (!m) { escribir('No se consultó.', { size: 8.5, color: GRIS, indent: 10 }); continue; }
    escribir(`Resultado: ${RESULTADO_MANUAL[m.resultado] || m.resultado}`, { size: 8.5, bold: true, color: m.resultado === 'hallazgo' ? ROJO : NEGRO, indent: 10, despues: 0 });
    if (m.terminos) escribir(`Términos buscados: ${m.terminos}`, { size: 8, color: GRIS, indent: 10, despues: 0 });
    if (m.motor) escribir(`Motor o fuente: ${m.motor}`, { size: 8, color: GRIS, indent: 10, despues: 0 });
    if (m.consultada_at) escribir(`Consultada: ${fechaHoraBogota(m.consultada_at)}`, { size: 8, color: GRIS, indent: 10, despues: 0 });
    if (m.observaciones) escribir(`Observaciones: ${m.observaciones}`, { size: 8, indent: 10, despues: 0 });
    y -= 3;
  }

  // ── Conclusión ─────────────────────────────────────────────────────────────
  titulo('5. Conclusión');
  const hallazgos = c.conclusion === 'con_hallazgos';
  escribir(hallazgos ? 'CON HALLAZGOS: hay coincidencias confirmadas o hallazgos en las consultas manuales. Requiere análisis del Oficial de Cumplimiento.'
    : 'SIN HALLAZGOS: no hay coincidencias confirmadas ni hallazgos en las consultas realizadas.', { size: 10, bold: true, color: hallazgos ? ROJO : VERDE });
  if ((c.coincidencias || []).some((x) => x.decision === 'confirmada' && FUENTES[x.fuente]?.vinculante)) {
    escribir('Coincidencia confirmada con una lista vinculante de la ONU: corresponde el reporte inmediato a la UIAF y a la Fiscalía General de la Nación (art. 20, Ley 1121 de 2006) y no se puede vincular al asociado.', { size: 9, bold: true, color: ROJO });
  }
  escribir('Este resultado solo vale para las listas y las fechas indicadas arriba: no es una certificación de que la persona carezca de antecedentes.', { size: 8, color: GRIS });

  // ── Validación ─────────────────────────────────────────────────────────────
  titulo('6. Validación del Oficial de Cumplimiento');
  if (c.validada_at && c.estado === 'validada') {
    escribir(`VALIDADA por ${oficialNombre || 'el Oficial de Cumplimiento'} el ${fechaHoraBogota(c.validada_at)}.`, { size: 9.5, bold: true, color: VERDE });
    if (c.observaciones_oficial) escribir(`Observaciones: ${c.observaciones_oficial}`, { size: 8.5 });
  } else {
    escribir('Pendiente de validación por el Oficial de Cumplimiento.', { size: 9.5, bold: true, color: GRIS });
  }

  // ── Pie ────────────────────────────────────────────────────────────────────
  y -= 6;
  escribir(`Generado por Kernel el ${fechaHoraBogota(generadaAt)}. Hash SHA-256 de los datos de la consulta: ${c.datos_hash || '—'}`, { size: 7, color: GRIS });

  const paginas = pdf.getPages();
  paginas.forEach((pg, i) => pg.drawText(`Consulta ${String(c.id).slice(0, 8)} — página ${i + 1} de ${paginas.length}`, { x: MARGEN, y: 24, size: 7, font: normal, color: GRIS }));
  return pdf.save();
};
