export const up = (pgm) => {
  pgm.addColumn('asociados', {
    sessions_valid_from: { type: 'TIMESTAMPTZ', default: null },
  });
  pgm.addColumn('empresas_portal_acceso', {
    sessions_valid_from: { type: 'TIMESTAMPTZ', default: null },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('asociados', 'sessions_valid_from');
  pgm.dropColumn('empresas_portal_acceso', 'sessions_valid_from');
};
