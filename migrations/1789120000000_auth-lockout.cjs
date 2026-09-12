/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.addColumns('global_usuarios', {
    failed_attempts: { type: 'integer', notNull: true, default: 0 },
    locked_until:    { type: 'timestamptz', default: null },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('global_usuarios', ['failed_attempts', 'locked_until']);
};
