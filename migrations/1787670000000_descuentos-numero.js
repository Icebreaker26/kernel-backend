export const up = (pgm) => {
  pgm.dropConstraint('asociado_descuentos', 'asociado_descuentos_pkey_uq');
  pgm.addColumn('asociado_descuentos', {
    numero: { type: 'varchar(40)', notNull: false },
  });
  // Unicidad real: un número de crédito por asociado (cuando el CSV lo provee)
  pgm.addConstraint(
    'asociado_descuentos',
    'asociado_descuentos_uq_numero',
    'UNIQUE (asociado_codigo, numero)',
  );
};

export const down = (pgm) => {
  pgm.dropConstraint('asociado_descuentos', 'asociado_descuentos_uq_numero');
  pgm.dropColumn('asociado_descuentos', 'numero');
  pgm.addConstraint(
    'asociado_descuentos',
    'asociado_descuentos_pkey_uq',
    'UNIQUE (asociado_codigo, linea_id)',
  );
};
