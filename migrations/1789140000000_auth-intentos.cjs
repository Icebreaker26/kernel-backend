/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('auth_intentos', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    email:      { type: 'varchar(150)', notNull: true },
    usuario_id: { type: 'uuid', references: '"global_usuarios"(id)', onDelete: 'SET NULL' },
    exitoso:    { type: 'boolean', notNull: true },
    motivo:     { type: 'varchar(30)' }, // 'ok'|'password'|'bloqueado'|'inactivo'|'no_existe'
    ip:         { type: 'varchar(45)' },
    user_agent: { type: 'varchar(255)' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('auth_intentos', ['ip', 'created_at']);
  pgm.createIndex('auth_intentos', ['email', 'created_at']);
  pgm.createIndex('auth_intentos', 'created_at');
};

exports.down = (pgm) => {
  pgm.dropTable('auth_intentos');
};
