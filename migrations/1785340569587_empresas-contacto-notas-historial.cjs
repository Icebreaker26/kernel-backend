exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns('empresas', {
    contacto_nombre:   { type: 'varchar(200)' },
    contacto_telefono: { type: 'varchar(50)' },
    contacto_email:    { type: 'varchar(200)' },
  });

  pgm.createTable('empresa_notas', {
    id:             { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    empresa_codigo: { type: 'varchar(50)', notNull: true, references: '"empresas"(codigo)', onDelete: 'CASCADE' },
    contenido:      { type: 'text', notNull: true },
    usuario_uuid:   { type: 'uuid', references: '"global_usuarios"(id)', onDelete: 'SET NULL' },
    is_active:      { type: 'boolean', default: true },
    created_at:     { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.createIndex('empresa_notas', 'empresa_codigo');
};

exports.down = (pgm) => {
  pgm.dropTable('empresa_notas');
  pgm.dropColumns('empresas', ['contacto_nombre', 'contacto_telefono', 'contacto_email']);
};
