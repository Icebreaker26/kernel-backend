export const up = (pgm) => {
  pgm.createTable('cola_mailing', {
    id:              { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    campana_id:      { type: 'uuid', notNull: true, references: '"campanas"', onDelete: 'CASCADE' },
    email:           { type: 'text', notNull: true },
    asociado_codigo: { type: 'text', notNull: true },
    estado:          { type: 'text', notNull: true, default: "'pendiente'", check: "estado IN ('pendiente','enviado','error')" },
    error_msg:       { type: 'text' },
    created_at:      { type: 'timestamptz', default: pgm.func('NOW()') },
    procesado_at:    { type: 'timestamptz' },
  });

  pgm.createIndex('cola_mailing', ['campana_id', 'estado']);
  pgm.createIndex('cola_mailing', 'estado');
};

export const down = (pgm) => {
  pgm.dropTable('cola_mailing');
};
