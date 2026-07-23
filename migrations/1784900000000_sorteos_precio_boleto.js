export const up = async (pgm) => {
  pgm.addColumn('sorteos', {
    precio_boleto: { type: 'NUMERIC(10,2)', notNull: true, default: 0 },
  });
};

export const down = async (pgm) => {
  pgm.dropColumn('sorteos', 'precio_boleto');
};
