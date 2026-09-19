/**
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
exports.up = (pgm) => {
  pgm.createTable('captacion_stand_sessions', {
    id:             { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    token:          { type: 'varchar(64)', notNull: true, unique: true },
    asesor_uuid:    { type: 'uuid', notNull: true, references: 'global_usuarios(id)', onDelete: 'CASCADE' },
    empresa_codigo: { type: 'varchar(20)', notNull: true },
    expira_at:      { type: 'timestamptz', notNull: true },
    is_active:      { type: 'boolean', notNull: true, default: true },
    created_at:     { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex('captacion_stand_sessions', 'token');
  pgm.createIndex('captacion_stand_sessions', 'asesor_uuid');
};

exports.down = (pgm) => {
  pgm.dropTable('captacion_stand_sessions');
};
