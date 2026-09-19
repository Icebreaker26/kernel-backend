/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE captacion_prospectos
      ADD COLUMN acepta_habeas_data  BOOLEAN    NOT NULL DEFAULT false,
      ADD COLUMN habeas_data_at      TIMESTAMPTZ,
      ADD COLUMN interes_principal   VARCHAR(30);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE captacion_prospectos
      DROP COLUMN IF EXISTS acepta_habeas_data,
      DROP COLUMN IF EXISTS habeas_data_at,
      DROP COLUMN IF EXISTS interes_principal;
  `);
};
