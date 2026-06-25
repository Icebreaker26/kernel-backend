/**
 * Sincronización desde DB vieja (Railway/platinum) hacia kernel.
 *
 * La DB de Railway es SOLO LECTURA — este script nunca escribe en ella.
 * Es idempotente y seguro de correr múltiples veces (re-sync).
 *
 * Qué sincroniza:
 *   - Empresas:   upsert por codigo (platinum es fuente de verdad)
 *   - Asociados:  upsert por CC — actualiza datos pero PRESERVA password_hash
 *   - Boletos:    diff completo — refleja estado exacto de Railway ahora mismo
 *   - Logs:       solo importa logs con fecha > último log importado por sorteo
 *   - Empresas habilitadas por sorteo: upsert (agrega, NO elimina)
 *   - Sorteos:    NO toca — se gestionan desde kernel
 *
 * Uso:
 *   node scripts/migrate_platinum.js            -- dry-run
 *   node scripts/migrate_platinum.js --run       -- ejecutar
 */

import pg from 'pg';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const DRY_RUN = !process.argv.includes('--run');
const CLEAN   =  process.argv.includes('--clean');

if (DRY_RUN) console.log('=== DRY RUN — pasa --run para ejecutar. ===\n');
if (CLEAN && !DRY_RUN) console.log('=== --clean activo: se borrarán todos los datos antes de sincronizar. ===\n');

const OLD_URL = process.env.PLATINUM_DATABASE_URL;
if (!OLD_URL) { console.error('[ERROR] Falta variable de entorno PLATINUM_DATABASE_URL'); process.exit(1); }
const oldPool = new Pool({ connectionString: OLD_URL, ssl: { rejectUnauthorized: false } });
const newPool = new Pool({ connectionString: process.env.DATABASE_URL });

const log   = (...a) => console.log(...a);
const warn  = (...a) => console.warn('[WARN]', ...a);
const error = (...a) => console.error('[ERROR]', ...a);

function normalizar(str) {
  if (!str) return '';
  return str.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

const ACCION_MAP = {
  COMPRA:                'COMPRA_DIRECTA',
  ANULACION:             'ANULACION_DIRECTA',
  LIBERACION_POR_RETIRO: 'LIBERACION_POR_RETIRO_CSV',
  SINCRO_CSV_COMPLETA:   null,
};

async function main() {
  log('Leyendo datos de Railway...\n');

  // ── Fuente ─────────────────────────────────────────────────────────────────
  const { rows: oldUsuarios } = await oldPool.query(
    `SELECT cc, nombre, apellido, celular, direccion, ciudad,
            clase_cuota::text, empresa_id, empresa_nombre, activo, fecha_registro
     FROM usuarios.usuarios ORDER BY id`
  );

  const empresasMap = new Map(); // codigo → nombre
  for (const u of oldUsuarios) {
    if (u.empresa_id && u.empresa_nombre && !empresasMap.has(u.empresa_id))
      empresasMap.set(u.empresa_id, u.empresa_nombre);
  }

  const { rows: oldSorteos } = await oldPool.query(
    `SELECT id, nombre FROM sorteo.sorteos ORDER BY id`
  );

  const { rows: oldBoletos } = await oldPool.query(
    `SELECT b.numero, b.sorteo_id, b.fecha_asignacion, u.cc AS asociado_cc
     FROM sorteo.boletos b
     LEFT JOIN usuarios.usuarios u ON u.id = b.usuario_id
     ORDER BY b.sorteo_id, b.numero`
  );

  const { rows: oldLogs } = await oldPool.query(
    `SELECT accion, cc_afectada, numero_afectado, detalle, fecha, sorteo_id
     FROM sorteo.logs WHERE sorteo_id IS NOT NULL ORDER BY fecha`
  );

  const { rows: oldEmpresasHab } = await oldPool.query(
    `SELECT sorteo_id, empresa_nombre FROM sorteo.sorteo_empresas_habilitadas`
  );

  // Mapa nombre_normalizado → codigo para empresas habilitadas
  const nombreACodigo = new Map();
  for (const [codigo, nombre] of empresasMap) {
    nombreACodigo.set(normalizar(nombre), codigo);
  }

  log(`Empresas únicas:    ${empresasMap.size}`);
  log(`Asociados:          ${oldUsuarios.length} (${oldUsuarios.filter(u=>u.activo).length} activos)`);
  log(`Sorteos:            ${oldSorteos.length}`);
  log(`Boletos asignados:  ${oldBoletos.filter(b=>b.asociado_cc).length} / ${oldBoletos.length}`);
  log(`Logs:               ${oldLogs.length}`);
  log(`Empr. habilitadas:  ${oldEmpresasHab.length}`);

  // ── Destino — leer sorteos existentes en kernel para mapear IDs ────────────
  const { rows: kernelSorteos } = await newPool.query(`SELECT id, nombre FROM sorteos`);
  const sorteoIdMap = new Map(); // oldId (int) → newUUID
  for (const s of oldSorteos) {
    const ks = kernelSorteos.find(k => k.nombre === s.nombre);
    if (ks) sorteoIdMap.set(s.id, ks.id);
    else warn(`Sorteo "${s.nombre}" (id=${s.id}) no existe en kernel — crea el sorteo primero.`);
  }

  // Fechas del último log importado por sorteo (para no duplicar en re-sync)
  // Con --clean la tabla estará vacía, así que importamos todos
  const ultimoLog = new Map(); // sorteoUUID → Date
  if (!CLEAN) {
    for (const [oldId, newId] of sorteoIdMap) {
      const { rows: [r] } = await newPool.query(
        `SELECT MAX(created_at) AS ultima FROM sorteo_logs WHERE sorteo_id = $1`, [newId]
      );
      if (r.ultima) ultimoLog.set(newId, new Date(r.ultima));
    }
  }

  const logsNuevos = oldLogs.filter(l => {
    const nuevaAccion = ACCION_MAP[l.accion];
    if (!nuevaAccion) return false;
    const newId = sorteoIdMap.get(l.sorteo_id);
    if (!newId) return false;
    const ultima = ultimoLog.get(newId);
    return !ultima || new Date(l.fecha) > ultima;
  });

  const habSinMatch = oldEmpresasHab.filter(e => !nombreACodigo.has(normalizar(e.empresa_nombre)));
  if (habSinMatch.length) {
    warn(`${habSinMatch.length} empresa(s) habilitadas sin match (se omitirán):`);
    habSinMatch.forEach(e => warn(`  "${e.empresa_nombre}"`));
  }

  log('\n=== QUÉ SE VA A SINCRONIZAR ===');
  log(`Empresas upsert:             ${empresasMap.size}`);
  log(`Asociados upsert:            ${oldUsuarios.length} (password preservado si ya existe)`);
  log(`Boletos — diff completo:     ${oldBoletos.filter(b=>b.asociado_cc).length} asignados`);
  log(`Logs nuevos a importar:      ${logsNuevos.length}`);
  log(`Empresas habilitadas upsert: ${oldEmpresasHab.length - habSinMatch.length}`);

  if (DRY_RUN) { log('\nCorre con --run para ejecutar.'); return; }

  const client = await newPool.connect();
  try {
    await client.query('BEGIN');

    // ── Limpieza previa (--clean) ─────────────────────────────────────────────
    if (CLEAN) {
      log('\n=== LIMPIANDO DATOS EXISTENTES ===');
      // Orden respetando FKs: primero hijos, luego padres
      const tablas = [
        'sorteo_logs',
        'sorteo_ganadores',
        'solicitudes_bono',
        'sorteo_empresas',
        'boletos',
        'sorteos',
        'asociados',
        'empresas',
      ];
      for (const t of tablas) {
        const { rowCount } = await client.query(`DELETE FROM ${t}`);
        log(`  ${t}: ${rowCount} filas eliminadas`);
      }
    }

    // ── Empresas ──────────────────────────────────────────────────────────────
    log('\n=== EMPRESAS ===');
    let eIns = 0, eUpd = 0;
    for (const [codigo, nombre] of empresasMap) {
      const { rowCount } = await client.query(
        `INSERT INTO empresas (codigo, nombre, is_active)
         VALUES ($1, $2, true)
         ON CONFLICT (codigo) DO UPDATE SET nombre = EXCLUDED.nombre, updated_at = NOW()
         WHERE empresas.nombre IS DISTINCT FROM EXCLUDED.nombre`,
        [codigo, nombre]
      );
      rowCount > 0 ? (eIns++) : (eUpd++);
    }
    log(`  Insertadas/actualizadas: ${eIns} | Sin cambios: ${eUpd}`);

    // ── Asociados ─────────────────────────────────────────────────────────────
    log('\n=== ASOCIADOS ===');
    const LOTE = 100;
    let aIns = 0, aUpd = 0;

    for (let i = 0; i < oldUsuarios.length; i += LOTE) {
      const lote = oldUsuarios.slice(i, i + LOTE);
      await Promise.all(lote.map(async (u) => {
        // Verificar si ya existe
        const { rows: [ex] } = await client.query(
          `SELECT codigo FROM asociados WHERE codigo = $1`, [u.cc]
        );

        if (ex) {
          // Actualizar todo MENOS password_hash
          await client.query(
            `UPDATE asociados SET
               nombre = $1, apellido = $2, movil = $3, direccion = $4,
               ciudad = $5, clase_cuota = $6, empresa_dsto = $7,
               nombre_empresa = $8, is_active = $9, updated_at = NOW()
             WHERE codigo = $10`,
            [u.nombre, u.apellido, u.celular??null, u.direccion??null,
             u.ciudad??null, u.clase_cuota, u.empresa_id??null,
             u.empresa_nombre??null, u.activo, u.cc]
          );
          aUpd++;
        } else {
          const hash = await bcrypt.hash(u.cc, 4);
          await client.query(
            `INSERT INTO asociados
               (codigo, nombre, apellido, movil, direccion, ciudad,
                clase_cuota, empresa_dsto, nombre_empresa,
                password_hash, is_active, fecha_ingreso)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [u.cc, u.nombre, u.apellido, u.celular??null, u.direccion??null,
             u.ciudad??null, u.clase_cuota, u.empresa_id??null,
             u.empresa_nombre??null, hash, u.activo, u.fecha_registro??null]
          );
          aIns++;
        }
      }));
      process.stdout.write(`\r  Procesados: ${Math.min(i+LOTE, oldUsuarios.length)} / ${oldUsuarios.length}`);
    }
    log(`\n  Nuevos: ${aIns} | Actualizados: ${aUpd}`);

    // ── Sorteos (solo si --clean los borró, o si no existen aún) ─────────────
    log('\n=== SORTEOS ===');
    for (const s of oldSorteos) {
      const estado = s.estado === 'activo' ? 'activo' : 'pausado';
      const { rows: [ins] } = await client.query(
        `INSERT INTO sorteos (nombre, descripcion, estado)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING id`,
        [s.nombre, s.descripcion ?? null, estado]
      );
      if (ins) {
        // Pre-poblar 1000 boletos
        const vals = Array.from({ length: 1000 }, (_, i) => `(${i},'${ins.id}')`).join(',');
        await client.query(`INSERT INTO boletos (numero, sorteo_id) VALUES ${vals} ON CONFLICT DO NOTHING`);
        log(`  Creado: "${s.nombre}" → ${ins.id}`);
      } else {
        log(`  Ya existía: "${s.nombre}"`);
      }
    }

    // Reconstruir sorteoIdMap desde DB (garantiza UUIDs correctos tras clean)
    {
      const { rows: freshSorteos } = await client.query(`SELECT id, nombre FROM sorteos`);
      sorteoIdMap.clear();
      for (const s of oldSorteos) {
        const ks = freshSorteos.find(k => k.nombre === s.nombre);
        if (ks) sorteoIdMap.set(s.id, ks.id);
        else warn(`Sorteo "${s.nombre}" no encontrado tras inserción`);
      }
    }

    // ── Boletos — diff completo por sorteo ────────────────────────────────────
    log('\n=== BOLETOS (diff) ===');
    const kernelCcs = new Set(
      (await client.query(`SELECT codigo FROM asociados`)).rows.map(r => r.codigo)
    );

    for (const [oldId, newId] of sorteoIdMap) {
      // Estado actual de platinum para este sorteo
      const boletosDelSorteo = oldBoletos.filter(b => b.sorteo_id === oldId);

      // Reset todos los boletos del sorteo a libre
      await client.query(
        `UPDATE boletos SET asociado_codigo = NULL, estado = 'libre', fecha_asignacion = NULL
         WHERE sorteo_id = $1 AND estado NOT IN ('pendiente_adquisicion','pendiente_retiro')`,
        [newId]
      );

      // Re-asignar los que tienen dueño
      let asig = 0;
      for (const b of boletosDelSorteo) {
        if (!b.asociado_cc || !kernelCcs.has(b.asociado_cc)) continue;
        await client.query(
          `UPDATE boletos SET asociado_codigo=$1, estado='asignado', fecha_asignacion=$2
           WHERE numero=$3 AND sorteo_id=$4`,
          [b.asociado_cc, b.fecha_asignacion, b.numero, newId]
        );
        asig++;
      }

      const sorteoNombre = oldSorteos.find(s => s.id === oldId)?.nombre ?? newId;
      log(`  "${sorteoNombre}": ${asig} asignados`);
    }

    // ── Empresas habilitadas ──────────────────────────────────────────────────
    log('\n=== EMPRESAS HABILITADAS ===');
    let hOk = 0, hSkip = 0;
    for (const e of oldEmpresasHab) {
      const codigo    = nombreACodigo.get(normalizar(e.empresa_nombre));
      const newSorteoId = sorteoIdMap.get(e.sorteo_id);
      if (!codigo || !newSorteoId) { hSkip++; continue; }
      await client.query(
        `INSERT INTO sorteo_empresas (sorteo_id, empresa_codigo)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [newSorteoId, codigo]
      );
      hOk++;
    }
    log(`  Insertadas: ${hOk} | Sin match: ${hSkip}`);

    // ── Logs nuevos ───────────────────────────────────────────────────────────
    log('\n=== LOGS NUEVOS ===');
    for (const l of logsNuevos) {
      const newSorteoId    = sorteoIdMap.get(l.sorteo_id);
      const nuevaAccion    = ACCION_MAP[l.accion];
      const asociadoCodigo = (l.cc_afectada && l.cc_afectada !== 'SISTEMA') ? l.cc_afectada : null;
      await client.query(
        `INSERT INTO sorteo_logs (sorteo_id, numero, accion, asociado_codigo, detalle, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [newSorteoId, l.numero_afectado??null, nuevaAccion, asociadoCodigo, l.detalle, l.fecha]
      );
    }
    log(`  Importados: ${logsNuevos.length}`);

    // ── Empresa 138 (Cruz Verde) — encoding corrupto en Railway, insertar siempre ──
    await client.query(
      `INSERT INTO empresas (codigo, nombre, is_active)
       VALUES ('138', 'DROGUERÍAS Y FARMACIAS CRUZ VERDE SAS', true)
       ON CONFLICT (codigo) DO UPDATE SET nombre = EXCLUDED.nombre, updated_at = NOW()`
    );
    for (const [oldId, newId] of sorteoIdMap) {
      const { rows: hab } = await oldPool.query(
        `SELECT 1 FROM sorteo.sorteo_empresas_habilitadas
         WHERE sorteo_id = $1 AND empresa_nombre ILIKE '%CRUZ VERDE%'`, [oldId]
      );
      if (hab.length > 0) {
        await client.query(
          `INSERT INTO sorteo_empresas (sorteo_id, empresa_codigo)
           VALUES ($1, '138') ON CONFLICT DO NOTHING`, [newId]
        );
      }
    }
    log('  Cruz Verde (138) sincronizada manualmente.');

    await client.query('COMMIT');
    log('\n✓ Sincronización completada.');

  } catch (err) {
    await client.query('ROLLBACK');
    error('Sync fallido — ROLLBACK ejecutado');
    error(err.message);
    process.exit(1);
  } finally {
    client.release();
  }
}

await main();
await oldPool.end();
await newPool.end();
