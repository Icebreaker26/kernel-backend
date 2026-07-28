export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE patronales_detalle
      ADD COLUMN bonos_monto   NUMERIC(12,2) NOT NULL DEFAULT 0,
      ADD COLUMN bonos_detalle JSONB;
    -- bonos_detalle: [{sorteo, precio_boleto, boletos: [111,222], subtotal}]
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE patronales_detalle
      DROP COLUMN bonos_monto,
      DROP COLUMN bonos_detalle;
  `);
};
