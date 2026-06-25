export const up = (pgm) => {
  pgm.createTable('sincronizaciones', {
    id:           { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    usuario_uuid: { type: 'uuid', notNull: true, references: 'global_usuarios(id)', onDelete: 'SET NULL' },
    archivo:      { type: 'varchar(255)', notNull: true },
    total:        { type: 'integer', notNull: true },
    nuevos:       { type: 'integer', notNull: true },
    actualizados: { type: 'integer', notNull: true },
    retirados:    { type: 'integer', notNull: true },
    errores:      { type: 'integer', notNull: true },
    created_at:   { type: 'timestamptz', default: pgm.func('now()') },
  });

  pgm.sql(`
    INSERT INTO modulos (nombre, descripcion)
    VALUES ('sincronizaciones', 'Auditoría de sincronizaciones de padrón')
    ON CONFLICT (nombre) DO NOTHING;
  `);
};

export const down = (pgm) => {
  pgm.dropTable('sincronizaciones');
  pgm.sql(`DELETE FROM modulos WHERE nombre = 'sincronizaciones';`);
};
