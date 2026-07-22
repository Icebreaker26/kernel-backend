export const up = (pgm) => {
  pgm.alterColumn('asociados', 'password_hash', { notNull: false, default: null });
  pgm.addColumns('asociados', {
    portal_activo: { type: 'boolean', notNull: true, default: false },
    primer_login:  { type: 'boolean', notNull: true, default: false },
    fecha_ingreso: { type: 'timestamptz' },
  }, { ifNotExists: true });
};

export const down = (pgm) => {
  pgm.dropColumns('asociados', ['portal_activo', 'primer_login', 'fecha_ingreso'], { ifExists: true });
};
