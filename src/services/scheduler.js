import pool from '../db/database.js';
import logger from '../config/logger.js';
import { notificarAdmins } from './notificationService.js';
import { runAnomalyDetector } from './anomalyDetector.js';

let _timer = null;
let _dailyTimer = null;
let _anomalyTimer = null;

// Job de detección de anomalías cada 5 min (reprogramado con setTimeout para evitar solapamiento)
const scheduleAnomaly = () => {
  _anomalyTimer = setTimeout(async () => {
    await runAnomalyDetector();
    scheduleAnomaly();
  }, 5 * 60_000);
};

export const startAnomalyDetector = async () => {
  await runAnomalyDetector(); // ejecución inicial al arrancar
  scheduleAnomaly();
  logger.info('Monitor de anomalías de seguridad iniciado (cada 5 min)');
};

export const ejecutarPendientes = async () => {
  // Cierres vencidos
  const { rows: cierres } = await pool.query(
    `UPDATE sorteo_programaciones p
        SET ejecutado_cierre = true
       FROM sorteos s
      WHERE p.sorteo_id = s.id
        AND p.fecha_cierre <= NOW()
        AND p.ejecutado_cierre = false
      RETURNING p.id, p.sorteo_id, s.nombre AS sorteo_nombre`
  );
  for (const prog of cierres) {
    await pool.query(`UPDATE sorteos SET estado = 'pausado', updated_at = NOW() WHERE id = $1`, [prog.sorteo_id]);
    await pool.query(
      `INSERT INTO sorteo_logs (sorteo_id, numero, accion, asociado_codigo, empleado_uuid, detalle)
       VALUES ($1, NULL, 'AUTO_CIERRE', NULL, NULL, 'Cierre automático programado')`,
      [prog.sorteo_id]
    );
    notificarAdmins({ tipo: 'sorteo_auto_cierre', mensaje: `Sorteo "${prog.sorteo_nombre}" pausado automáticamente`, modulo: 'sorteos' }).catch(() => {});
    logger.info(`Scheduler: sorteo ${prog.sorteo_id} cerrado automáticamente`);
  }

  // Aperturas vencidas
  const { rows: aperturas } = await pool.query(
    `UPDATE sorteo_programaciones p
        SET ejecutado_apertura = true
       FROM sorteos s
      WHERE p.sorteo_id = s.id
        AND p.fecha_apertura <= NOW()
        AND p.ejecutado_apertura = false
        AND p.ejecutado_cierre = true
      RETURNING p.id, p.sorteo_id, s.nombre AS sorteo_nombre`
  );
  for (const prog of aperturas) {
    await pool.query(`UPDATE sorteos SET estado = 'activo', updated_at = NOW() WHERE id = $1`, [prog.sorteo_id]);
    await pool.query(
      `INSERT INTO sorteo_logs (sorteo_id, numero, accion, asociado_codigo, empleado_uuid, detalle)
       VALUES ($1, NULL, 'AUTO_APERTURA', NULL, NULL, 'Apertura automática programada')`,
      [prog.sorteo_id]
    );
    notificarAdmins({ tipo: 'sorteo_auto_apertura', mensaje: `Sorteo "${prog.sorteo_nombre}" reactivado automáticamente`, modulo: 'sorteos' }).catch(() => {});
    logger.info(`Scheduler: sorteo ${prog.sorteo_id} abierto automáticamente`);
  }
};

const programarSiguiente = async () => {
  // Próximo evento pendiente (cierre o apertura)
  const { rows: [next] } = await pool.query(`
    SELECT LEAST(
      MIN(fecha_cierre)   FILTER (WHERE ejecutado_cierre = false),
      MIN(fecha_apertura) FILTER (WHERE ejecutado_apertura = false AND ejecutado_cierre = true)
    ) AS proxima
    FROM sorteo_programaciones
  `);

  if (!next?.proxima) return; // sin eventos pendientes

  const ms = new Date(next.proxima).getTime() - Date.now();
  const delay = Math.max(ms, 0); // si ya venció, disparar de inmediato

  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(async () => {
    try {
      await ejecutarPendientes();
    } catch (err) {
      logger.error(`Scheduler error: ${err.message}`);
    }
    await programarSiguiente(); // reprogramar para el próximo evento
  }, delay);

  const en = delay < 1000 ? 'ahora' : `en ${Math.round(delay / 60000)} min`;
  logger.info(`Scheduler: próximo evento ${en} (${new Date(next.proxima).toISOString()})`);
};

export const startScheduler = async () => {
  try {
    await ejecutarPendientes(); // ejecutar eventos vencidos al arrancar
    await programarSiguiente();
    logger.info('Scheduler de programaciones iniciado (mode: setTimeout exacto)');
  } catch (err) {
    logger.error(`Scheduler init error: ${err.message}`);
  }
};

// Llamar esto desde el controller cada vez que se crea o elimina una programación
export const reprogramar = () => programarSiguiente().catch((err) => logger.error(`Scheduler reprogramar: ${err.message}`));

// ── Vencimiento de aprobaciones tesorería ──────────────────────────────────────

const verificarVencimientosTesoreria = async () => {
  try {
    const { rows: vencidas } = await pool.query(`
      UPDATE tesoreria_facturas
         SET estado = 'pendiente_aprobacion',
             aprobado_por = NULL, aprobado_at = NULL,
             aprobacion_vence_at = NULL,
             updated_at = NOW()
       WHERE estado = 'aprobada'
         AND aprobacion_vence_at IS NOT NULL
         AND aprobacion_vence_at < NOW()
      RETURNING id
    `);
    if (vencidas.length > 0) {
      logger.info(`Scheduler tesorería: ${vencidas.length} aprobación(es) vencida(s) revertidas`);
      notificarAdmins({
        tipo: 'aprobacion_vencida',
        mensaje: `${vencidas.length} factura(s) con aprobación vencida han vuelto a pendiente`,
        modulo: 'tesoreria',
      }).catch(() => {});
    }
  } catch (err) {
    logger.error(`Scheduler tesorería vencimientos: ${err.message}`);
  }
};

const msHastaMedioNoche = () => {
  const ahora = new Date();
  const medioNoche = new Date(ahora);
  medioNoche.setHours(24, 0, 0, 0);
  return medioNoche.getTime() - ahora.getTime();
};

const startDiarioTesoreria = () => {
  if (_dailyTimer) clearTimeout(_dailyTimer);
  _dailyTimer = setTimeout(async () => {
    await verificarVencimientosTesoreria();
    startDiarioTesoreria(); // reprogramar para el siguiente día
  }, msHastaMedioNoche());
  logger.info(`Scheduler tesorería: vencimientos programados en ${Math.round(msHastaMedioNoche() / 60000)} min`);
};

export const startSchedulerTesoreria = async () => {
  await verificarVencimientosTesoreria(); // revisar al arrancar
  startDiarioTesoreria();
};
