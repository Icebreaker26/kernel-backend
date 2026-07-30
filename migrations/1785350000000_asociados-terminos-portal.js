export const up = (pgm) => {
  pgm.addColumn('asociados', {
    acepto_terminos_portal_at: { type: 'TIMESTAMPTZ', notNull: false, default: null },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('asociados', 'acepto_terminos_portal_at');
};
