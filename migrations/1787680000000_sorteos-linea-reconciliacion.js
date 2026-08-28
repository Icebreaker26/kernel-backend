export const up = (pgm) => {
  pgm.addColumn('sorteos', {
    linea_reconciliacion: { type: 'varchar', notNull: false, default: null },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('sorteos', 'linea_reconciliacion');
};
