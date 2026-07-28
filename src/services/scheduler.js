import pool from '../db/database.js';
import logger from '../config/logger.js';
import { notificarAdmins } from './notificationService.js';

const ejecutarCierres = async () => {
  const { rows } = await pool.query(
    `UPDATE sorteo_programaciones p
        SET ejecutado_cierre = true
       FROM sorteos s
      WHERE p.sorteo_id = s.id
        AND p.fecha_cierre <= NOW()
        AND p.ejecutado_cierre = false
      RETURNING p.id, p.sorteo_id, s.nombre AS sorteo_nombre`
  );

  for (const prog of rows) {
    await pool.query(
      `UPDATE sorteos SET estado = 'pausado', updated_at = NOW() WHERE id = $1`,
      [prog.sorteo_id]
    );
    await pool.query(
      `INSERT INTO sorteo_logs (sorteo_id, numero, accion, asociado_codigo, empleado_uuid, detalle)
       VALUES ($1, NULL, 'AUTO_CIERRE', NULL, NULL, 'Cierre automático programado')`,
      [prog.sorteo_id]
    );
    notificarAdmins({
      tipo: 'sorteo_auto_cierre',
      mensaje: `Sorteo "${prog.sorteo_nombre}" pausado automáticamente`,
      modulo: 'sorteos',
    }).catch(() => {});
    logger.info(`Scheduler: sorteo ${prog.sorteo_id} cerrado automáticamente`);
  }
};

const ejecutarAperturas = async () => {
  const { rows } = await pool.query(
    `UPDATE sorteo_programaciones p
        SET ejecutado_apertura = true
       FROM sorteos s
      WHERE p.sorteo_id = s.id
        AND p.fecha_apertura <= NOW()
        AND p.ejecutado_apertura = false
        AND p.ejecutado_cierre = true
      RETURNING p.id, p.sorteo_id, s.nombre AS sorteo_nombre`
  );

  for (const prog of rows) {
    await pool.query(
      `UPDATE sorteos SET estado = 'activo', updated_at = NOW() WHERE id = $1`,
      [prog.sorteo_id]
    );
    await pool.query(
      `INSERT INTO sorteo_logs (sorteo_id, numero, accion, asociado_codigo, empleado_uuid, detalle)
       VALUES ($1, NULL, 'AUTO_APERTURA', NULL, NULL, 'Apertura automática programada')`,
      [prog.sorteo_id]
    );
    notificarAdmins({
      tipo: 'sorteo_auto_apertura',
      mensaje: `Sorteo "${prog.sorteo_nombre}" reactivado automáticamente`,
      modulo: 'sorteos',
    }).catch(() => {});
    logger.info(`Scheduler: sorteo ${prog.sorteo_id} abierto automáticamente`);
  }
};

const tick = async () => {
  try {
    await ejecutarCierres();
    await ejecutarAperturas();
  } catch (err) {
    logger.error(`Scheduler error: ${err.message}`);
  }
};

export const startScheduler = () => {
  tick(); // ejecutar inmediatamente al arrancar
  setInterval(tick, 60_000);
  logger.info('Scheduler de programaciones iniciado (intervalo 60s)');
};
