/* eslint-disable camelcase */
// El asesor ya no digita el "monto a desembolsar": lo calcula Cartera al cerrar (valor solicitado − aval − firma electrónica).
// Mientras no se complete el crédito el monto queda vacío; al completarlo se guarda el desembolso neto.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE credito_solicitudes ALTER COLUMN monto_desembolso DROP NOT NULL;
    ALTER TABLE credito_solicitudes DROP CONSTRAINT IF EXISTS chk_credito_motivo_dif;
    -- Solo los créditos que aún no se completaron pierden el monto digitado (era una copia del valor solicitado con o sin descuento)
    UPDATE credito_solicitudes SET monto_desembolso = NULL, motivo_diferencia = NULL WHERE estado <> 'completada';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE credito_solicitudes SET monto_desembolso = valor_solicitado WHERE monto_desembolso IS NULL;
    ALTER TABLE credito_solicitudes ALTER COLUMN monto_desembolso SET NOT NULL;
    ALTER TABLE credito_solicitudes ADD CONSTRAINT chk_credito_motivo_dif CHECK (monto_desembolso = valor_solicitado OR motivo_diferencia IS NOT NULL);
  `);
};
