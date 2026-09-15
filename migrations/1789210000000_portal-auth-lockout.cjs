/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  // 1. Columnas de contexto en auth_intentos para portales de asociados y empresas
  pgm.addColumns('auth_intentos', {
    contexto: {
      type: 'varchar(10)',
      notNull: true,
      default: pgm.func("'empleado'"),
      check: "contexto IN ('empleado','asociado','empresa')",
    },
    identificador: { type: 'varchar(100)' }, // codigo del asociado / email de empresa
  });
  pgm.createIndex('auth_intentos', ['contexto', 'ip', 'created_at']);

  // 2. Lockout de cuenta para asociados
  pgm.addColumns('asociados', {
    failed_attempts: { type: 'integer', notNull: true, default: 0 },
    locked_until:    { type: 'timestamptz', default: null },
  });

  // 3. Lockout de cuenta para empresas en portal patronal
  pgm.addColumns('empresas_portal_acceso', {
    failed_attempts: { type: 'integer', notNull: true, default: 0 },
    locked_until:    { type: 'timestamptz', default: null },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('empresas_portal_acceso', ['failed_attempts', 'locked_until']);
  pgm.dropColumns('asociados', ['failed_attempts', 'locked_until']);
  pgm.dropIndex('auth_intentos', ['contexto', 'ip', 'created_at']);
  pgm.dropColumns('auth_intentos', ['contexto', 'identificador']);
};
