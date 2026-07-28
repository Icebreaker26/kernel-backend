export const up = (pgm) => {
  pgm.addColumn('sorteo_ganadores', {
    mes_premiacion: { type: 'date', notNull: true, default: pgm.func('date_trunc(\'month\', CURRENT_DATE)') },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('sorteo_ganadores', 'mes_premiacion');
};
