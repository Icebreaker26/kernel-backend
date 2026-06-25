export const up = (pgm) => {
  pgm.createTable('empresas', {
    codigo:        { type: 'varchar(60)', primaryKey: true },
    nombre:        { type: 'varchar(120)', notNull: true },
    is_active:     { type: 'boolean', default: true },
    fecha_ingreso: { type: 'timestamptz' },
    fecha_retiro:  { type: 'timestamptz' },
    created_at:    { type: 'timestamptz', default: pgm.func('now()') },
    updated_at:    { type: 'timestamptz', default: pgm.func('now()') },
  });

  pgm.sql(`
    INSERT INTO modulos (nombre, descripcion)
    VALUES ('empresas', 'Empresas de descuento vinculadas a asociados')
    ON CONFLICT (nombre) DO NOTHING;
  `);
};

export const down = (pgm) => {
  pgm.dropTable('empresas');
  pgm.sql(`DELETE FROM modulos WHERE nombre = 'empresas';`);
};
