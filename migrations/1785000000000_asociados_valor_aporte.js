export const up = (pgm) => {
  pgm.addColumn('asociados', {
    valor_aporte: { type: 'NUMERIC(10,2)', notNull: false, default: null },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('asociados', 'valor_aporte');
};
