export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tesoreria_facturas
      ADD COLUMN IF NOT EXISTS retencion_fuente NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS retencion_ica    NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS retencion_iva    NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS monto_neto       NUMERIC(14,2)
        GENERATED ALWAYS AS (monto - retencion_fuente - retencion_ica - retencion_iva) STORED;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tesoreria_facturas
      DROP COLUMN IF EXISTS monto_neto,
      DROP COLUMN IF EXISTS retencion_fuente,
      DROP COLUMN IF EXISTS retencion_ica,
      DROP COLUMN IF EXISTS retencion_iva;
  `);
};
