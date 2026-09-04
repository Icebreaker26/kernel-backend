export const up = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS patronales_facturas_activa_unique;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX patronales_facturas_activa_unique
      ON patronales_facturas (empresa_codigo, periodo, tipo_cuota)
      WHERE estado <> 'anulada';
  `);
};
