/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  // F-panel: quién ejecutó el pago de cada factura (auditoría segregación de funciones)
  pgm.addColumn('tesoreria_facturas', {
    pagada_por: {
      type: 'uuid',
      references: '"global_usuarios"(id)',
      onDelete: 'SET NULL',
    },
  });

  // F-04 forced-logout: sesiones anteriores a esta marca son inválidas
  pgm.addColumn('global_usuarios', {
    sessions_valid_from: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('tesoreria_facturas', 'pagada_por');
  pgm.dropColumn('global_usuarios', 'sessions_valid_from');
};
