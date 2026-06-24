/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

  pgm.createTable('global_usuarios', {
    id:            { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    nombre:        { type: 'varchar(120)', notNull: true },
    email:         { type: 'varchar(200)', notNull: true, unique: true },
    password_hash: { type: 'text', notNull: true },
    rol:           { type: 'varchar(60)', notNull: true, default: 'usuario' },
    is_active:     { type: 'boolean', default: true },
    is_approved:   { type: 'boolean', default: false },
    created_at:    { type: 'timestamptz', default: pgm.func('now()') },
    updated_at:    { type: 'timestamptz', default: pgm.func('now()') },
  });

  pgm.createTable('modulos', {
    id:          { type: 'serial', primaryKey: true },
    nombre:      { type: 'varchar(80)', notNull: true, unique: true },
    descripcion: { type: 'text' },
  });

  pgm.createTable('acciones', {
    id:     { type: 'serial', primaryKey: true },
    nombre: { type: 'varchar(40)', notNull: true, unique: true },
  });

  pgm.createTable('permisos', {
    id:           { type: 'serial', primaryKey: true },
    usuario_uuid: { type: 'uuid', notNull: true, references: 'global_usuarios(id)', onDelete: 'CASCADE' },
    modulo_id:    { type: 'integer', notNull: true, references: 'modulos(id)', onDelete: 'CASCADE' },
    accion_id:    { type: 'integer', notNull: true, references: 'acciones(id)', onDelete: 'CASCADE' },
  });

  pgm.addConstraint('permisos', 'permisos_unique', 'UNIQUE (usuario_uuid, modulo_id, accion_id)');

  pgm.sql(`
    INSERT INTO acciones (nombre) VALUES ('READ'), ('WRITE'), ('DELETE') ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('permisos');
  pgm.dropTable('acciones');
  pgm.dropTable('modulos');
  pgm.dropTable('global_usuarios');
};
