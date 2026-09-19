/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('security_lockdown_shadow', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    // Datos del lockdown que HABRÍA bloqueado la request
    lockdown_nivel:   { type: 'smallint', notNull: true },
    lockdown_alcance: { type: 'varchar(12)', notNull: true },
    lockdown_objetivo:{ type: 'varchar(100)', notNull: true },
    lockdown_motivo:  { type: 'varchar(200)', notNull: true },
    // Datos de la request que no fue bloqueada
    request_method:   { type: 'varchar(10)' },
    request_path:     { type: 'varchar(500)' },
    request_ip:       { type: 'inet' },
    usuario_uuid:     {
      type: 'uuid',
      references: '"global_usuarios"(id)',
      onDelete: 'SET NULL',
    },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('security_lockdown_shadow', 'created_at');
  pgm.createIndex('security_lockdown_shadow', 'request_ip');
  pgm.createIndex('security_lockdown_shadow', 'usuario_uuid');
};

exports.down = (pgm) => {
  pgm.dropTable('security_lockdown_shadow');
};
