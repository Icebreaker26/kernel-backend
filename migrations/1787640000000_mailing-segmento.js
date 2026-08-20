export const up = (pgm) => {
  pgm.addColumn('campanas', {
    segmento: {
      type: 'jsonb',
      notNull: true,
      default: pgm.func(`'{"tipo":"todos"}'::jsonb`),
    },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('campanas', 'segmento');
};
