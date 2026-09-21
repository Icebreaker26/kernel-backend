import pool from '../../../db/database.js';

/**
 * Protocolo de la llamada. Son preguntas cuya respuesta está en el formulario que llenó la persona y que NO salen de la foto de
 * la cédula (quien tenga solo la cédula no las sabe). El asesor compara lo que responde con lo que aparece en la solicitud.
 */
export const PROTOCOLO_VOZ = [
  { clave: 'empresa',      pregunta: '¿En qué empresa trabaja?' },
  { clave: 'cargo',        pregunta: '¿Qué cargo tiene?' },
  { clave: 'aporte',       pregunta: '¿Qué valor de aporte eligió y con qué periodicidad?' },
  { clave: 'beneficiario', pregunta: 'Nombre de uno de sus beneficiarios' },
  { clave: 'referencia',   pregunta: 'Nombre de una de las personas que dio como referencia' },
];
export const MIN_PREGUNTAS_COINCIDEN = 3;

const CLAVE_CONFIG = 'exigir_validacion_voz';

// Mientras la cooperativa no lo active, la validación se puede registrar pero no bloquea la entrega.
export const validacionVozExigida = async () => {
  const { rows: [r] } = await pool.query(`SELECT valor FROM captacion_config WHERE clave = $1`, [CLAVE_CONFIG]);
  return r?.valor === 'true';
};

export const guardarExigencia = (exigida, usuarioId) => pool.query(
  `INSERT INTO captacion_config (clave, valor, actualizado_por) VALUES ($1, $2, $3)
   ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_por = EXCLUDED.actualizado_por, updated_at = NOW()`,
  [CLAVE_CONFIG, exigida ? 'true' : 'false', usuarioId]
);

/**
 * La validación vale si es "validada", posterior a la firma y a ESE mismo celular: si después cambian el número, hay que llamar de nuevo.
 */
export const validacionVigente = async (vinculacionId) => {
  const { rows: [r] } = await pool.query(
    `SELECT vv.id, vv.created_at
       FROM captacion_validaciones_voz vv
       JOIN captacion_vinculaciones v ON v.id = vv.vinculacion_id
       JOIN captacion_prospectos p ON p.id = v.prospecto_id
      WHERE vv.vinculacion_id = $1 AND vv.resultado = 'validada'
        AND vv.celular_llamado = p.celular AND vv.created_at >= v.firma_at
      ORDER BY vv.created_at DESC LIMIT 1`, [vinculacionId]
  );
  return r ?? null;
};
