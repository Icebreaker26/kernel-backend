export const up = (pgm) => {
  pgm.addColumns('tesoreria_movimientos', {
    tercero_nombre: { type: 'varchar(200)', notNull: false },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('tesoreria_movimientos', ['tercero_nombre']);
};
