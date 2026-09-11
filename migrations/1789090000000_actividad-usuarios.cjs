exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('global_usuarios', {
    last_active_at: { type: 'timestamptz' },
  });

  pgm.createTable('global_actividad', {
    id:          { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    usuario_id:  { type: 'uuid', notNull: true, references: '"global_usuarios"(id)', onDelete: 'CASCADE' },
    modulo:      { type: 'varchar(50)',  notNull: true },
    metodo:      { type: 'varchar(10)',  notNull: true },
    endpoint:    { type: 'varchar(200)', notNull: true },
    status_code: { type: 'smallint' },
    duracion_ms: { type: 'integer' },
    ip:          { type: 'varchar(45)' },
    created_at:  { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('global_actividad', ['usuario_id', 'created_at']);
  pgm.createIndex('global_actividad', ['modulo', 'created_at']);
  pgm.createIndex('global_actividad', 'created_at');
};

exports.down = (pgm) => {
  pgm.dropTable('global_actividad');
  pgm.dropColumn('global_usuarios', 'last_active_at');
};
