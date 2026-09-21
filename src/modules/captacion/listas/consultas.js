import pool from '../../../db/database.js';

const CLAVE_CONFIG = 'exigir_consulta_listas';

// Mientras la cooperativa no lo active, la consulta se puede hacer y validar pero no bloquea la entrega.
export const consultaListasExigida = async () => {
  const { rows: [r] } = await pool.query(`SELECT valor FROM captacion_config WHERE clave = $1`, [CLAVE_CONFIG]);
  return r?.valor === 'true';
};

export const guardarExigenciaListas = (exigida, usuarioId) => pool.query(
  `INSERT INTO captacion_config (clave, valor, actualizado_por) VALUES ($1, $2, $3)
   ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_por = EXCLUDED.actualizado_por, updated_at = NOW()`,
  [CLAVE_CONFIG, exigida ? 'true' : 'false', usuarioId]
);

/**
 * La consulta vale para entregar si el Oficial de Cumplimiento la validó y se hizo con los mismos datos de identidad que hoy tiene
 * la solicitud (si después se corrige la cédula o el nombre, hay que consultar de nuevo).
 */
export const consultaVigente = async (vinculacionId) => {
  const { rows: [r] } = await pool.query(
    `SELECT c.id, c.validada_at
       FROM captacion_consultas_listas c
       JOIN captacion_vinculaciones v ON v.id = c.vinculacion_id
       JOIN captacion_prospectos p ON p.id = v.prospecto_id
      WHERE c.vinculacion_id = $1 AND c.estado = 'validada'
        AND c.cedula = p.cedula AND c.nombres = p.nombres AND c.apellidos = p.apellidos
      ORDER BY c.validada_at DESC LIMIT 1`, [vinculacionId]
  );
  return r ?? null;
};
