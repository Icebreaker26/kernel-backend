export const up = (pgm) => {
  pgm.sql(`
    -- Reemplazar el UNIQUE total por un índice parcial que excluye anuladas
    -- Así una factura anulada no bloquea re-facturar el mismo período
    ALTER TABLE patronales_facturas
      DROP CONSTRAINT patronales_facturas_empresa_codigo_periodo_tipo_cuota_key;

    CREATE UNIQUE INDEX patronales_facturas_activa_unique
      ON patronales_facturas (empresa_codigo, periodo, tipo_cuota)
      WHERE estado <> 'anulada';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS patronales_facturas_activa_unique;
    ALTER TABLE patronales_facturas
      ADD CONSTRAINT patronales_facturas_empresa_codigo_periodo_tipo_cuota_key
      UNIQUE (empresa_codigo, periodo, tipo_cuota);
  `);
};
