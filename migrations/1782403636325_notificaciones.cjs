exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('notificaciones', {
    id:              { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    usuario_uuid:    { type: 'uuid', references: '"global_usuarios"(id)', onDelete: 'CASCADE', notNull: false },
    asociado_codigo: { type: 'varchar(20)', references: '"asociados"(codigo)', onDelete: 'CASCADE', notNull: false },
    tipo:            { type: 'varchar(50)', notNull: true },
    mensaje:         { type: 'text', notNull: true },
    modulo:          { type: 'varchar(50)', notNull: true },
    leida:           { type: 'boolean', notNull: true, default: false },
    created_at:      { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('notificaciones', 'chk_notif_destinatario', `
    CHECK (
      (usuario_uuid IS NOT NULL AND asociado_codigo IS NULL) OR
      (usuario_uuid IS NULL AND asociado_codigo IS NOT NULL)
    )
  `);

  pgm.createIndex('notificaciones', ['usuario_uuid', 'leida']);
  pgm.createIndex('notificaciones', ['asociado_codigo', 'leida']);

  pgm.sql(`
    INSERT INTO modulos (nombre, descripcion)
    VALUES ('notificaciones', 'Centro de notificaciones del sistema')
    ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('notificaciones');
  pgm.sql(`DELETE FROM modulos WHERE nombre = 'notificaciones'`);
};
