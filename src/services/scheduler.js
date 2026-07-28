import pool from '../db/database.js';
import logger from '../config/logger.js';
import { notificarAdmins } from './notificationService.js';

let _timer = null;

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
