export const up = async (pgm) => {
  pgm.addColumn('asociados', {
    solicitud_portal_at: {
      type: 'TIMESTAMPTZ',
      notNull: false,
      default: null,
    },
  });
};

export const down = async (pgm) => {
  pgm.dropColumn('asociados', 'solicitud_portal_at');
};
