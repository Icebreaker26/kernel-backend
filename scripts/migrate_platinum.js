/**
 * Migración desde DB vieja (Railway/Platinum) hacia Kernel.
 * Platinum ya no se actualiza — este es un script de migración, no de sincronización continua.
 *
 * La DB de Railway es SOLO LECTURA — este script nunca escribe en ella.
 * Es idempotente: seguro de correr múltiples veces.
 *
 * Qué importa:
 *   - Empresas:            upsert por codigo; is_active derivado de sus asociados
 *   - Asociados:           upsert por CC; PRESERVA password_hash, valor_aporte, valor_aporte_desde
 *   - Boletos:             importa asignados de Platinum solo en boletos libres de Kernel
 *                          (nunca sobreescribe lo ya gestionado en Kernel)
 *   - Logs de sorteos:     solo los nuevos (fecha > último importado por sorteo)
 *   - Empresas habilitadas: upsert por sorteo (agrega, no elimina)
 *   - Sorteos:             crea si no existen en Kernel; si ya existen, NO los toca
 *
 * NOTA: precio_boleto de sorteos NO viene de Platinum (campo Kernel-only).
 *       Configurar manualmente en Sorteos antes de causar facturas de patronales.
 *
 * Uso:
 *   node scripts/migrate_platinum.js                   -- dry-run (muestra qué haría)
 *   node scripts/migrate_platinum.js --run             -- ejecutar (importación segura)
 *   node scripts/migrate_platinum.js --run --clean     -- limpiar todo y re-importar desde cero
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

  // codigo → { nombre, is_active } — activa si tiene al menos un asociado activo
  const empresasMap = new Map();
  for (const u of oldUsuarios) {
    if (!u.empresa_id || !u.empresa_nombre) continue;
    const prev = empresasMap.get(u.empresa_id);
    if (!prev) {
      empresasMap.set(u.empresa_id, { nombre: u.empresa_nombre, is_active: !!u.activo });
    } else if (u.activo) {
      prev.is_active = true;
    }
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
  for (const [codigo, { nombre }] of empresasMap) {
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

    // ── Preservar datos gestionados en Kernel antes de limpiar ────────────────
    // valor_aporte, historial y boletos de Kernel no vienen de Platinum
    const savedAportes       = new Map(); // CC → valor_aporte
    const savedAporteDesde   = new Map(); // CC → valor_aporte_desde
    const savedHistorial     = [];
    const savedBoletos       = [];        // [{sorteo_nombre, numero, asociado_codigo, fecha_asignacion}]

    if (CLEAN) {
      const { rows: ap } = await client.query(
        `SELECT codigo, valor_aporte, valor_aporte_desde FROM asociados
          WHERE valor_aporte IS NOT NULL`
      );
      for (const r of ap) {
        savedAportes.set(r.codigo, r.valor_aporte);
        if (r.valor_aporte_desde) savedAporteDesde.set(r.codigo, r.valor_aporte_desde);
      }

      const { rows: hist } = await client.query(
        `SELECT id, asociado_codigo, valor_anterior, valor_nuevo, motivo, usuario_uuid, created_at
         FROM asociados_aporte_historial ORDER BY created_at`
      );
      savedHistorial.push(...hist);

      // Boletos asignados en Kernel — se restauran si Platinum no los cubre
      const { rows: bols } = await client.query(
        `SELECT s.nombre AS sorteo_nombre, b.numero, b.asociado_codigo, b.fecha_asignacion
           FROM boletos b
           JOIN sorteos s ON s.id = b.sorteo_id
          WHERE b.estado = 'asignado'`
      );
      savedBoletos.push(...bols);

      log(`\n  Preservando: ${savedAportes.size} valor_aporte, ${savedHistorial.length} historial de aportes, ${savedBoletos.length} boletos asignados`);
    }

    // ── Limpieza previa (--clean) ─────────────────────────────────────────────
    if (CLEAN) {
      log('\n=== LIMPIANDO DATOS EXISTENTES ===');
      // Orden respetando FKs: primero hijos, luego padres
      const tablas = [
        'patronales_pagos',
        'patronales_detalle',
        'patronales_logs',
        'patronales_facturas',
        'sorteo_logs',
        'sorteo_ganadores',
        'solicitudes_bono',
        'sorteo_empresas',
        'boletos',
        'sorteos',
        'asociados_aporte_historial',
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
    for (const [codigo, { nombre, is_active }] of empresasMap) {
      const { rowCount } = await client.query(
        `INSERT INTO empresas (codigo, nombre, is_active)
         VALUES ($1, $2, $3)
         ON CONFLICT (codigo) DO UPDATE
           SET nombre    = EXCLUDED.nombre,
               is_active = EXCLUDED.is_active,
               updated_at = NOW()`,
        [codigo, nombre, is_active]
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

    // ── Restaurar datos Kernel después de --clean ─────────────────────────────
    if (CLEAN && (savedAportes.size > 0 || savedHistorial.length > 0)) {
      log('\n=== RESTAURANDO DATOS KERNEL ===');
      for (const [codigo, valor] of savedAportes) {
        await client.query(
          `UPDATE asociados SET valor_aporte = $1, valor_aporte_desde = $2 WHERE codigo = $3`,
          [valor, savedAporteDesde.get(codigo) ?? null, codigo]
        );
      }
      log(`  valor_aporte restaurado: ${savedAportes.size} asociados`);

      for (const h of savedHistorial) {
        await client.query(
          `INSERT INTO asociados_aporte_historial
             (id, asociado_codigo, valor_anterior, valor_nuevo, motivo, usuario_uuid, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [h.id, h.asociado_codigo, h.valor_anterior, h.valor_nuevo, h.motivo, h.usuario_uuid, h.created_at]
        );
      }
      log(`  historial de aportes restaurado: ${savedHistorial.length} entradas`);
    }

    // ── Sorteos ────────────────────────────────────────────────────────────────
    log('\n=== SORTEOS ===');
    for (const s of oldSorteos) {
      if (sorteoIdMap.has(s.id)) {
        // Ya existe: asegurar que esté activo (versiones anteriores lo creaban como 'pausado')
        await client.query(
          `UPDATE sorteos SET estado = 'activo', updated_at = NOW()
           WHERE id = $1 AND estado = 'pausado'`,
          [sorteoIdMap.get(s.id)]
        );
        log(`  Ya mapeado: "${s.nombre}" (activado si estaba pausado)`);
        continue;
      }
      // Sin match: insertar — Platinum es un sistema vivo, todos activos
      const estado = 'activo';
      const { rows: [ins] } = await client.query(
        `INSERT INTO sorteos (nombre, descripcion, estado)
         VALUES ($1, $2, $3) RETURNING id`,
        [s.nombre, s.descripcion ?? null, estado]
      );
      const vals = Array.from({ length: 1000 }, (_, i) => `(${i},'${ins.id}')`).join(',');
      await client.query(`INSERT INTO boletos (numero, sorteo_id) VALUES ${vals} ON CONFLICT DO NOTHING`);
      sorteoIdMap.set(s.id, ins.id);
      log(`  Creado: "${s.nombre}" → ${ins.id}`);
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

    // ── Boletos — importación desde Platinum (migración, no sincronización continua)
    // Platinum ya no se actualiza. Regla: solo asigna boletos libres en Kernel.
    // Los boletos ya asignados en Kernel (gestionados desde la app) nunca se tocan.
    log('\n=== BOLETOS (importación desde Platinum) ===');
    const kernelCcs = new Set(
      (await client.query(`SELECT codigo FROM asociados`)).rows.map(r => r.codigo)
    );

    // Mapa nombre_sorteo → UUID kernel (para restauración post-clean por nombre, no por ID)
    const sorteoNombreAId = new Map();
    for (const [oldId, newId] of sorteoIdMap) {
      const nombre = oldSorteos.find(s => s.id === oldId)?.nombre;
      if (nombre) sorteoNombreAId.set(nombre, newId);
    }

    for (const [oldId, newId] of sorteoIdMap) {
      const boletosDelSorteo = oldBoletos.filter(b => b.sorteo_id === oldId);

      let asig = 0;
      for (const b of boletosDelSorteo) {
        if (!b.asociado_cc || !kernelCcs.has(b.asociado_cc)) continue;
        // AND estado='libre' → no sobreescribe asignaciones de Kernel
        const { rowCount } = await client.query(
          `UPDATE boletos SET asociado_codigo=$1, estado='asignado', fecha_asignacion=$2
           WHERE numero=$3 AND sorteo_id=$4 AND estado='libre'`,
          [b.asociado_cc, b.fecha_asignacion, b.numero, newId]
        );
        if (rowCount > 0) asig++;
      }

      const sorteoNombre = oldSorteos.find(s => s.id === oldId)?.nombre ?? newId;
      log(`  "${sorteoNombre}": ${asig} asignados`);
    }

    // Para --clean: restaurar boletos que Platinum no cubrió (gestionados en Kernel antes del clean)
    if (CLEAN && savedBoletos.length > 0) {
      let restaurados = 0;
      for (const b of savedBoletos) {
        const sorteoId = sorteoNombreAId.get(b.sorteo_nombre);
        if (!sorteoId || !kernelCcs.has(b.asociado_codigo)) continue;
        const { rowCount } = await client.query(
          `UPDATE boletos SET asociado_codigo=$1, estado='asignado', fecha_asignacion=$2
           WHERE numero=$3 AND sorteo_id=$4 AND estado='libre'`,
          [b.asociado_codigo, b.fecha_asignacion, b.numero, sorteoId]
        );
        if (rowCount > 0) restaurados++;
      }
      if (restaurados > 0) log(`  Boletos Kernel restaurados (no estaban en Platinum): ${restaurados}`);
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
