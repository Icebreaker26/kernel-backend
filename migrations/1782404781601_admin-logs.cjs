exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('admin_logs', {
    id:            { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    usuario_uuid:  { type: 'uuid', notNull: true, references: '"global_usuarios"(id)', onDelete: 'SET NULL' },
    accion:        { type: 'varchar(60)', notNull: true },
    objetivo_tipo: { type: 'varchar(20)', notNull: true }, // 'usuario' | 'asociado'
    objetivo_id:   { type: 'varchar(100)', notNull: true },
    objetivo_nombre: { type: 'varchar(200)' },
    detalle:       { type: 'text' },
    created_at:    { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('admin_logs', 'usuario_uuid');
  pgm.createIndex('admin_logs', 'created_at');
};

exports.down = (pgm) => {
  pgm.dropTable('admin_logs');
};
