/* eslint-disable camelcase */
// Enlace para grupos "libre": sin empresa fija (empresa_codigo NULL). Quien lo abre elige su empresa, como en /asociate,
// y la solicitud queda a nombre del asesor que lo generó. Uno por asesor; no caduca.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE captacion_enlaces_publicos ALTER COLUMN empresa_codigo DROP NOT NULL;
    CREATE UNIQUE INDEX uq_captacion_enlace_libre ON captacion_enlaces_publicos (asesor_uuid) WHERE empresa_codigo IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS uq_captacion_enlace_libre;
    DELETE FROM captacion_enlaces_publicos WHERE empresa_codigo IS NULL;
    ALTER TABLE captacion_enlaces_publicos ALTER COLUMN empresa_codigo SET NOT NULL;
  `);
};
