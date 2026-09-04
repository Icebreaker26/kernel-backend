export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE patronales_detalle
      ALTER COLUMN clase_cuota_snapshot TYPE VARCHAR(20);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE patronales_detalle
      ALTER COLUMN clase_cuota_snapshot TYPE VARCHAR(2)
      USING LEFT(clase_cuota_snapshot, 2);
  `);
};
