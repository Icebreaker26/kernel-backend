import pool from '../../../db/database.js';
import logger from '../../../config/logger.js';

/**
 * Prospecto "sin identificar": lo crea el kiosco de stand cuando alguien toca "Quiero asociarme"
 * (cédula placeholder STAND_xxxx y nombre vacío) y sigue así hasta que la persona escribe su
 * nombre y su documento en el primer paso del formulario. Mientras tanto no es una persona real
 * para el asesor: se oculta de la lista y no cuenta en sus estadísticas.
 * Fragmento SQL para usar sobre una tabla con alias `p`.
 */
export const SQL_SIN_IDENTIFICAR = `(p.cedula LIKE 'STAND_%' AND p.nombres = '')`;

/**
 * Da de baja (borrado lógico) los prospectos sin identificar que llevan más de `horas` sin
 * que nadie los complete. Solo toca los que no tienen ninguna vinculación iniciada.
 * `asesorUuid` limita el alcance (lo usan los tests); el programador lo llama sin él.
 */
export const limpiarProspectosSinIdentificar = async ({ horas = 24, asesorUuid = null } = {}) => {
  const { rowCount } = await pool.query(
    `UPDATE captacion_prospectos p
        SET is_active = false, updated_at = NOW()
      WHERE p.is_active = true
        AND ${SQL_SIN_IDENTIFICAR}
        AND p.created_at < NOW() - make_interval(hours => $1)
        AND ($2::uuid IS NULL OR p.asesor_uuid = $2)
        AND NOT EXISTS (SELECT 1 FROM captacion_vinculaciones v WHERE v.prospecto_id = p.id)`,
    [horas, asesorUuid]
  );
  if (rowCount > 0) logger.info(`Captación: ${rowCount} prospecto(s) del stand sin identificar dados de baja (> ${horas} h)`);
  return rowCount;
};
