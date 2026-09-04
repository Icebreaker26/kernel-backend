export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE patronales_detalle
      ADD COLUMN IF NOT EXISTS conceptos JSONB;

    ALTER TABLE patronales_facturas
      ADD COLUMN IF NOT EXISTS quincena SMALLINT CHECK (quincena IN (1, 2));

    -- Reemplazar el índice único con uno que incluya quincena
    DROP INDEX IF EXISTS patronales_facturas_empresa_codigo_periodo_tipo_cuota_key;
    DROP INDEX IF EXISTS idx_patronales_facturas_unique;

    CREATE UNIQUE INDEX idx_patronales_facturas_unique
      ON patronales_facturas (empresa_codigo, periodo, tipo_cuota, COALESCE(quincena, 0))
      WHERE estado <> 'anulada';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_patronales_facturas_unique;

    ALTER TABLE patronales_facturas DROP COLUMN IF EXISTS quincena;
    ALTER TABLE patronales_detalle  DROP COLUMN IF EXISTS conceptos;

    CREATE UNIQUE INDEX idx_patronales_facturas_unique
      ON patronales_facturas (empresa_codigo, periodo, tipo_cuota)
      WHERE estado <> 'anulada';
  `);
};
