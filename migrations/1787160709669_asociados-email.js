export const up = (pgm) => {
  pgm.addColumn('asociados', {
    email: { type: 'varchar(255)', notNull: false },
  });
  pgm.addConstraint('asociados', 'asociados_email_unique', 'UNIQUE (email)');
};

export const down = (pgm) => {
  pgm.dropConstraint('asociados', 'asociados_email_unique');
  pgm.dropColumn('asociados', 'email');
};
