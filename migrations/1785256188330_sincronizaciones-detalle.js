export const up = (pgm) => {
  pgm.addColumns('sincronizaciones', {
    boletos_liberados: { type: 'integer', notNull: true, default: 0 },
    detalle:           { type: 'jsonb',   notNull: false },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('sincronizaciones', ['boletos_liberados', 'detalle']);
};
