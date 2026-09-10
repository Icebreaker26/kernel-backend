export const up = (pgm) => {
  pgm.sql(`
    -- La referencia bancaria NO es suficiente para identificar una transacción
    -- de forma única. El banco puede reutilizar el mismo código para varias
    -- operaciones distintas. La clave real es (cuenta, referencia, fecha, monto).
    DROP INDEX IF EXISTS uq_tsr_mov_cuenta_ref_bancaria;

    CREATE UNIQUE INDEX uq_tsr_mov_ref_fecha_monto
      ON tesoreria_movimientos(cuenta_id, referencia_bancaria, fecha, monto)
      WHERE referencia_bancaria IS NOT NULL;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS uq_tsr_mov_ref_fecha_monto;

    CREATE UNIQUE INDEX uq_tsr_mov_cuenta_ref_bancaria
      ON tesoreria_movimientos(cuenta_id, referencia_bancaria)
      WHERE referencia_bancaria IS NOT NULL;
  `);
};
