export const up = (pgm) => {
  pgm.addColumn('campanas', {
    plantilla: { type: 'jsonb', notNull: false, default: null },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('campanas', 'plantilla');
};
