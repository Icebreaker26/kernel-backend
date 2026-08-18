export const up = (pgm) => {
  pgm.addColumn('sorteos', {
    tipo_pago: {
      type: 'varchar(10)',
      notNull: true,
      default: 'recurrente',
    },
  });

  pgm.addConstraint('sorteos', 'sorteos_tipo_pago_check', `CHECK (tipo_pago IN ('recurrente', 'unico'))`);
};

export const down = (pgm) => {
  pgm.dropConstraint('sorteos', 'sorteos_tipo_pago_check');
  pgm.dropColumn('sorteos', 'tipo_pago');
};
