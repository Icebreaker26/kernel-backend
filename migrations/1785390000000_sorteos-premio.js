export const up = (pgm) => {
  pgm.addColumn('sorteos', {
    premio: { type: 'text', notNull: false },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('sorteos', 'premio');
};
