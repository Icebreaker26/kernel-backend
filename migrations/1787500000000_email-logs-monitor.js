export const up = (pgm) => {
  pgm.createTable('email_logs', {
    id:              { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    tipo:            { type: 'varchar(50)',  notNull: true },
    destinatario:    { type: 'varchar(255)', notNull: true },
    asociado_codigo: { type: 'varchar(50)' },
    estado:          { type: 'varchar(20)',  notNull: true, default: "'enviado'" },
    error_msg:       { type: 'text' },
    created_at:      { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.createIndex('email_logs', 'created_at');
  pgm.createIndex('email_logs', 'estado');

  pgm.sql(`
    INSERT INTO modulos (nombre, descripcion) VALUES ('monitor', 'Monitoreo del portal y emails') ON CONFLICT DO NOTHING;
  `);
};

export const down = (pgm) => {
  pgm.dropTable('email_logs');
  pgm.sql(`DELETE FROM modulos WHERE nombre = 'monitor';`);
};
