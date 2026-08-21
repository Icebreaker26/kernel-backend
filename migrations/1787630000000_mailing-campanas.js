export const up = (pgm) => {
  pgm.createTable('campanas', {
    id:                 { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    asunto:             { type: 'text', notNull: true },
    cuerpo_html:        { type: 'text', notNull: true },
    cuerpo_texto:       { type: 'text' },
    estado:             { type: 'text', notNull: true, default: 'borrador',
                          check: "estado IN ('borrador','enviando','enviada','error')" },
    destinatarios_total: { type: 'integer', default: 0 },
    enviados:           { type: 'integer', default: 0 },
    errores:            { type: 'integer', default: 0 },
    creado_por:         { type: 'uuid', references: 'global_usuarios(id)', onDelete: 'SET NULL' },
    enviada_at:         { type: 'timestamptz' },
    created_at:         { type: 'timestamptz', default: pgm.func('NOW()') },
    updated_at:         { type: 'timestamptz', default: pgm.func('NOW()') },
    is_active:          { type: 'boolean', default: true },
  });

  pgm.sql(`
    INSERT INTO modulos (nombre, descripcion) VALUES ('mailing', 'Campañas de correo') ON CONFLICT DO NOTHING;
    INSERT INTO acciones (nombre) VALUES ('READ')  ON CONFLICT DO NOTHING;
    INSERT INTO acciones (nombre) VALUES ('WRITE') ON CONFLICT DO NOTHING;
    INSERT INTO acciones (nombre) VALUES ('DELETE') ON CONFLICT DO NOTHING;
  `);
};

export const down = (pgm) => {
  pgm.dropTable('campanas');
  pgm.sql(`DELETE FROM modulos WHERE nombre = 'mailing';`);
};
