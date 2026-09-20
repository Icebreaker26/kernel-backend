/**
 * Importa a Kernel (módulo "Documentos públicos") los PDFs del Régimen Tributario Especial que hoy están en el WordPress
 * (cooperativaprogresemos.coop/rte/): los descarga, los sube al bucket y los deja publicados.
 *
 *   node scripts/importarRte.mjs --dry     lista lo que haría, sin descargar ni escribir nada
 *   node scripts/importarRte.mjs           importa
 *
 * Es idempotente: si ya existe un documento activo con el mismo título, categoría y año, lo salta.
 * Usa la base y el bucket que indique el .env (DATABASE_URL, S3_BUCKET, AWS_*).
 */
import pool from '../src/db/database.js';
import { subirBuffer } from '../src/services/archivoService.js';

const BASE = 'https://www.cooperativaprogresemos.coop/wp-content/uploads';
const ENTIDAD = 'transparencia_documento';   // igual que ENTIDAD en transparenciaController.js
const MAX_BYTES = 25 * 1024 * 1024;

const DOCUMENTOS = [
  { titulo: 'RUT',                                          categoria: 'rut',                 anio: 2026, url: `${BASE}/2025/05/RUT-Cooperativa-Progresemos.pdf` },
  { titulo: 'Acta de asamblea 2026',                          categoria: 'acta_asamblea',       anio: 2026, url: `${BASE}/2026/07/8.9.-Acta-Asamblea-2026.pdf` },
  { titulo: 'Acta de asamblea 2025',                          categoria: 'acta_asamblea',       anio: 2025, url: `${BASE}/2025/10/Acta-Asamblea-2025.pdf` },
  { titulo: 'Acta de asamblea 2024',                          categoria: 'acta_asamblea',       anio: 2024, url: `${BASE}/2025/06/8.9.-Acta-Asamblea-2024.pdf` },
  { titulo: 'Informe de gestión 2025',                        categoria: 'informe_gestion',     anio: 2025, url: `${BASE}/2026/07/3.-Informe-de-Gestion-2025.pdf` },
  { titulo: 'Informe de gestión 2024',                        categoria: 'informe_gestion',     anio: 2024, url: `${BASE}/2025/05/Informe_de_Gestion_2024.pdf` },
  { titulo: 'Informe de gestión 2023',                        categoria: 'informe_gestion',     anio: 2023, url: `${BASE}/2025/06/3.-Informe-de-Gestion-2023.pdf` },
  { titulo: 'Estados financieros 2025',                       categoria: 'estados_financieros', anio: 2025, url: `${BASE}/2026/07/4.-ESTADOS-FINANCIEROS-2025-PROGRESEMOS.pdf` },
  { titulo: 'Estados financieros 2024',                       categoria: 'estados_financieros', anio: 2024, url: `${BASE}/2025/10/Estados-Financieros-ano-2024.pdf` },
  { titulo: 'Estados financieros 2023',                       categoria: 'estados_financieros', anio: 2023, url: `${BASE}/2025/06/4.-Estados-Financieros-ano-2023.pdf` },
  { titulo: 'Declaración de renta 2025',                      categoria: 'renta',               anio: 2025, url: `${BASE}/2026/07/RENTA-2025.pdf` },
  { titulo: 'Certificación de cargos directivos y gerenciales', categoria: 'certificado',       anio: 2026, url: `${BASE}/2026/07/1.-CERTIFICACION-CARGOS-DIRECTIVOS-Y-GERENCIALES.pdf` },
  { titulo: 'Certificado de antecedentes',                    categoria: 'certificado',         anio: 2026, url: `${BASE}/2026/07/7.-CERTIFICADO-ANTECEDENTES.pdf` },
  { titulo: 'Certificado de requisitos cumplidos 2026',       categoria: 'certificado',         anio: 2026, url: `${BASE}/2026/07/5.-CERTIFICADOS-DE-REQUISITOS-CUMPLIDOS-ANO-2026.pdf` },
  { titulo: 'Formato 5245',                                   categoria: 'formato',             anio: 2026, url: `${BASE}/2026/07/FORMATO-5245.pdf` },
  { titulo: 'Formato 2531',                                   categoria: 'formato',             anio: 2026, url: `${BASE}/2026/07/FORMATO-2531.pdf` },
  { titulo: 'Formato 2530',                                   categoria: 'formato',             anio: 2026, url: `${BASE}/2026/07/FORMATO-2530.pdf` },
];

const dry = process.argv.includes('--dry');
const resumen = { creados: 0, saltados: 0, errores: 0 };

try {
  await pool.query('SELECT 1 FROM transparencia_documentos LIMIT 1');   // falla claro si la migración no se ha corrido
  for (const d of DOCUMENTOS) {
    const { rows: [existe] } = await pool.query(
      `SELECT id FROM transparencia_documentos WHERE is_active AND titulo = $1 AND categoria = $2 AND anio IS NOT DISTINCT FROM $3`,
      [d.titulo, d.categoria, d.anio]);
    if (existe) { console.log(`= ya existe   ${d.titulo}`); resumen.saltados++; continue; }
    if (dry) { console.log(`+ importaría  ${d.titulo}  [${d.categoria}${d.anio ? ' ' + d.anio : ''}]`); continue; }

    try {
      const res = await fetch(d.url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new Error(`pesa ${(buf.length / 1048576).toFixed(1)} MB (máx 25)`);
      if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('no es un PDF');

      const { rows: [doc] } = await pool.query(
        `INSERT INTO transparencia_documentos (titulo, categoria, anio, publicado) VALUES ($1, $2, $3, false) RETURNING id`,
        [d.titulo, d.categoria, d.anio]);
      const nombre = decodeURIComponent(d.url.split('/').pop());
      const archivo = await subirBuffer(ENTIDAD, doc.id, buf, { nombre, mime: 'application/pdf' });
      await pool.query(`UPDATE transparencia_documentos SET archivo_id = $1, publicado = true, updated_at = NOW() WHERE id = $2`, [archivo.id, doc.id]);
      console.log(`+ importado   ${d.titulo}  (${(buf.length / 1024).toFixed(0)} KB)`);
      resumen.creados++;
    } catch (err) {
      console.error(`! error       ${d.titulo}: ${err.message}`);
      resumen.errores++;
    }
  }
  console.log(`\n${dry ? '(simulación) ' : ''}Creados: ${resumen.creados} · ya existían: ${resumen.saltados} · con error: ${resumen.errores}`);
} finally {
  await pool.end();
}
process.exit(resumen.errores ? 1 : 0);
