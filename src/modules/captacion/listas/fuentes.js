import crypto from 'crypto';
import pool from '../../../db/database.js';
import logger from '../../../config/logger.js';
import { subirBuffer } from '../../../services/archivoService.js';
import { parseOnu, parseOfac, parseUe, parseUk, parsePepSigep, parseSiri } from './parsers.js';
import { descargarBoletinCgr, parseBoletinCgr } from './boletinCgr.js';
import { invalidarCache } from './cotejo.js';

const OFAC = 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports';
const DATOS = 'https://www.datos.gov.co/api/views';

/**
 * Fuentes que se descargan solas cada día. `cotejo`: 'nombre' compara por nombre y por cédula; 'documento' solo por cédula exacta
 * (PEP y sanciones de la Procuraduría: buscar por nombre en 40 mil personas solo genera homónimos).
 * `vinculante`: listas del Consejo de Seguridad de la ONU, que la Circular Básica Jurídica exige consultar antes de vincular.
 */
export const FUENTES = {
  ONU: {
    nombre: 'ONU — Lista consolidada del Consejo de Seguridad', vinculante: true, obligatoria: true, cotejo: 'nombre', grupo: 'sanciones',
    archivos: [{ url: 'https://scsanctions.un.org/resources/xml/en/consolidated.xml', nombre: 'consolidated.xml', mime: 'application/xml' }],
    leer: ([xml]) => parseOnu(xml),
  },
  OFAC_SDN: {
    nombre: 'OFAC — Lista SDN (lista Clinton)', vinculante: false, obligatoria: false, cotejo: 'nombre', grupo: 'sanciones',
    archivos: [{ url: `${OFAC}/SDN.CSV`, nombre: 'SDN.CSV', mime: 'text/csv' }, { url: `${OFAC}/ALT.CSV`, nombre: 'ALT.CSV', mime: 'text/csv' }],
    leer: ([sdn, alt]) => parseOfac(sdn, alt),
  },
  OFAC_CONS: {
    nombre: 'OFAC — Lista consolidada (no SDN)', vinculante: false, obligatoria: false, cotejo: 'nombre', grupo: 'sanciones',
    archivos: [{ url: `${OFAC}/CONS_PRIM.CSV`, nombre: 'CONS_PRIM.CSV', mime: 'text/csv' }, { url: `${OFAC}/CONS_ALT.CSV`, nombre: 'CONS_ALT.CSV', mime: 'text/csv' }],
    leer: ([prim, alt]) => parseOfac(prim, alt),
  },
  UE: {
    nombre: 'Unión Europea — Sanciones financieras consolidadas', vinculante: false, obligatoria: false, cotejo: 'nombre', grupo: 'sanciones',
    archivos: [{ url: 'https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw', nombre: 'eu_fsf.csv', mime: 'text/csv' }],
    leer: ([csv]) => parseUe(csv),
  },
  UK: {
    nombre: 'Reino Unido — OFSI Consolidated List', vinculante: false, obligatoria: false, cotejo: 'nombre', grupo: 'sanciones',
    archivos: [{ url: 'https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv', nombre: 'ConList.csv', mime: 'text/csv' }],
    leer: ([csv]) => parseUk(csv),
  },
  PEP_SIGEP: {
    nombre: 'PEP de Colombia — SIGEP / Función Pública (Decreto 830 de 2021)', vinculante: false, obligatoria: false, cotejo: 'documento', grupo: 'pep',
    archivos: [{ url: `${DATOS}/3qxn-uc22/rows.csv?accessType=DOWNLOAD`, nombre: 'pep_sigep.csv', mime: 'text/csv' }],
    leer: ([csv]) => parsePepSigep(csv),
  },
  CGR_BOLETIN: {
    nombre: 'Contraloría — Boletín de Responsables Fiscales', vinculante: false, obligatoria: false, cotejo: 'documento', grupo: 'antecedentes',
    // PDF trimestral público (sin CAPTCHA): se revisa cada semana y se acepta hasta con 14 días sin verificar
    cadaHoras: 120, maxDias: 14, binario: true, urlTexto: 'cfiscal.contraloria.gov.co/reportes/consultaboletinestrimestrales.aspx',
    descargar: descargarBoletinCgr,
    leer: ([pdf]) => parseBoletinCgr(pdf),
  },
  SIRI: {
    nombre: 'Procuraduría — Sanciones disciplinarias (SIRI)', vinculante: false, obligatoria: false, cotejo: 'documento', grupo: 'antecedentes',
    archivos: [{ url: `${DATOS}/iaeu-rcn6/rows.csv?accessType=DOWNLOAD`, nombre: 'siri.csv', mime: 'text/csv' }],
    leer: ([csv]) => parseSiri(csv),
  },
};

const TOPE_BYTES = 80 * 1024 * 1024;

const descargar = async ({ url }) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(180000), headers: { 'User-Agent': 'Kernel-Progresemos/1.0 (cumplimiento)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url.split('?')[0]}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > TOPE_BYTES) throw new Error('El archivo supera el tamaño esperado');
  if (!buf.length) throw new Error('El archivo llegó vacío');
  return { buf, modificada: res.headers.get('last-modified') };
};

// Guarda las entradas por tandas (jsonb_to_recordset evita miles de parámetros)
const guardarEntradas = async (client, versionId, fuente, entradas) => {
  for (let i = 0; i < entradas.length; i += 1500) {
    await client.query(
      `INSERT INTO listas_entradas (version_id, fuente, ref, tipo, nombre, alias, documentos, nacimiento, nacionalidades, detalle)
       SELECT $1, $2, x.ref, x.tipo, x.nombre,
              ARRAY(SELECT jsonb_array_elements_text(x.alias)), ARRAY(SELECT jsonb_array_elements_text(x.documentos)),
              ARRAY(SELECT jsonb_array_elements_text(x.nacimiento)), ARRAY(SELECT jsonb_array_elements_text(x.nacionalidades)), x.detalle
         FROM jsonb_to_recordset($3::jsonb) AS x(ref text, tipo text, nombre text, alias jsonb, documentos jsonb, nacimiento jsonb, nacionalidades jsonb, detalle jsonb)`,
      [versionId, fuente, JSON.stringify(entradas.slice(i, i + 1500))]
    );
  }
};

/**
 * Descarga una fuente. Si el contenido es idéntico al de la versión activa solo anota que se verificó (verificada_at); si cambió,
 * guarda la versión nueva (entradas en la base y archivos originales en S3, con su hash) y la activa. Si falla, la versión activa
 * anterior sigue vigente y queda el error registrado.
 */
export const actualizarFuente = async (codigo) => {
  const cfg = FUENTES[codigo];
  if (!cfg) throw new Error(`Fuente desconocida: ${codigo}`);
  const url = cfg.urlTexto ?? cfg.archivos.map((a) => a.url.split('?')[0]).join(' + ');
  try {
    const descargas = cfg.descargar ? await cfg.descargar() : [];
    if (!cfg.descargar) for (const a of cfg.archivos) descargas.push(await descargar(a));
    const sha256 = crypto.createHash('sha256').update(Buffer.concat(descargas.map((d) => d.buf))).digest('hex');
    const bytes = descargas.reduce((n, d) => n + d.buf.length, 0);

    const { rows: [activa] } = await pool.query(`SELECT id, sha256 FROM listas_versiones WHERE fuente = $1 AND activa`, [codigo]);
    if (activa?.sha256 === sha256) {
      await pool.query(`UPDATE listas_versiones SET verificada_at = NOW() WHERE id = $1`, [activa.id]);
      return { fuente: codigo, cambio: false };
    }

    const { publicada, entradas } = await cfg.leer(descargas.map((d) => (cfg.binario ? d.buf : d.buf.toString('utf8'))));
    if (!entradas.length) throw new Error('El archivo no trajo registros: se conserva la versión anterior');
    // Una lista que de un día para otro pierde más de la mitad de sus registros casi seguro llegó dañada
    if (activa) {
      const { rows: [prev] } = await pool.query(`SELECT registros FROM listas_versiones WHERE id = $1`, [activa.id]);
      if (prev.registros > 100 && entradas.length < prev.registros * 0.5) throw new Error(`Bajó de ${prev.registros} a ${entradas.length} registros: se conserva la versión anterior`);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [v] } = await client.query(
        `INSERT INTO listas_versiones (fuente, url, publicada, sha256, bytes, registros, verificada_at)
         VALUES ($1,$2,$3,$4,$5,$6, NOW()) RETURNING id`,
        [codigo, url, publicada || (descargas[0].modificada ? new Date(descargas[0].modificada).toISOString() : null), sha256, bytes, entradas.length]
      );
      await guardarEntradas(client, v.id, codigo, entradas);
      await client.query(`UPDATE listas_versiones SET activa = false WHERE fuente = $1 AND activa`, [codigo]);
      await client.query(`UPDATE listas_versiones SET activa = true WHERE id = $1`, [v.id]);
      // Las entradas de versiones anteriores se quitan (el archivo original queda en S3 para reproducir cualquier consulta)
      await client.query(`DELETE FROM listas_entradas WHERE fuente = $1 AND version_id <> $2`, [codigo, v.id]);
      await client.query('COMMIT');

      // Archivos originales (evidencia de qué versión se consultó); si S3 falla la versión igual queda activa
      const ids = [];
      for (let i = 0; i < descargas.length; i++) {
        try {
          const a = await subirBuffer('listas_snapshot', v.id, descargas[i].buf, { nombre: descargas[i].nombre ?? cfg.archivos[i].nombre, mime: descargas[i].mime ?? cfg.archivos[i].mime });
          ids.push(a.id);
        } catch (err) { logger.warn(`listas: no se pudo guardar el original de ${codigo} en S3: ${err.message}`); }
      }
      if (ids.length) await pool.query(`UPDATE listas_versiones SET archivos = $2::jsonb WHERE id = $1`, [v.id, JSON.stringify(ids)]);
      invalidarCache();
      logger.info(`listas: ${codigo} actualizada (${entradas.length} registros)`);
      return { fuente: codigo, cambio: true, registros: entradas.length };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error(`listas: falló la actualización de ${codigo}: ${err.message}`);
    await pool.query(`INSERT INTO listas_versiones (fuente, url, estado, error) VALUES ($1,$2,'error',$3)`, [codigo, url, String(err.message).slice(0, 500)]).catch(() => {});
    return { fuente: codigo, error: err.message };
  }
};

let actualizando = false;

export const actualizarTodas = async ({ soloVencidas = false } = {}) => {
  if (actualizando) return { ocupado: true };
  actualizando = true;
  try {
    const resultados = [];
    for (const codigo of Object.keys(FUENTES)) {
      if (soloVencidas) {
        const { rows: [v] } = await pool.query(`SELECT verificada_at FROM listas_versiones WHERE fuente = $1 AND activa`, [codigo]);
        if (v && Date.now() - new Date(v.verificada_at).getTime() < (FUENTES[codigo].cadaHoras ?? 20) * 3600 * 1000) continue;
      }
      resultados.push(await actualizarFuente(codigo));
    }
    return { resultados };
  } finally {
    actualizando = false;
  }
};

/** Estado de cada fuente: versión activa, antigüedad y último error (para la pantalla y para decidir si se puede consultar). */
export const estadoFuentes = async () => {
  const [{ rows: activas }, { rows: errores }] = await Promise.all([
    pool.query(`SELECT id, fuente, publicada, descargada_at, verificada_at, sha256, registros FROM listas_versiones WHERE activa`),
    pool.query(`SELECT DISTINCT ON (fuente) fuente, error, descargada_at FROM listas_versiones WHERE estado = 'error' ORDER BY fuente, descargada_at DESC`),
  ]);
  return Object.entries(FUENTES).map(([codigo, cfg]) => {
    const a = activas.find((x) => x.fuente === codigo);
    const e = errores.find((x) => x.fuente === codigo);
    const dias = a ? Math.floor((Date.now() - new Date(a.verificada_at).getTime()) / 86400000) : null;
    return {
      codigo, nombre: cfg.nombre, vinculante: cfg.vinculante, obligatoria: cfg.obligatoria, cotejo: cfg.cotejo, grupo: cfg.grupo,
      disponible: !!a, version_id: a?.id ?? null, publicada: a?.publicada ?? null, verificada_at: a?.verificada_at ?? null, descargada_at: a?.descargada_at ?? null,
      sha256: a?.sha256 ?? null, registros: a?.registros ?? 0, dias_sin_verificar: dias,
      desactualizada: a ? dias > (cfg.maxDias ?? 3) : true,
      ultimo_error: e && (!a || new Date(e.descargada_at) > new Date(a.verificada_at)) ? e.error : null,
    };
  });
};
