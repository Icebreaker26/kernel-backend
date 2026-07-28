export const up = (pgm) => {
  pgm.addColumns('asociados', {
    fecha_credito:       { type: 'DATE' },
    fecha_pri_descuento: { type: 'DATE' },
    saldo_aporte:        { type: 'NUMERIC(12,2)' },
    fecha_reingreso:     { type: 'DATE' },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('asociados', [
    'fecha_credito',
    'fecha_pri_descuento',
    'saldo_aporte',
    'fecha_reingreso',
  ]);
};
