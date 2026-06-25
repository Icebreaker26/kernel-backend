export const up = (pgm) => {
  pgm.createTable('asociados', {
    codigo:          { type: 'varchar(20)', primaryKey: true },
    apellido:        { type: 'varchar(120)', notNull: true },
    nombre:          { type: 'varchar(120)', notNull: true },
    direccion:       { type: 'varchar(255)' },
    movil:           { type: 'varchar(20)' },
    clase_cuota:     { type: 'varchar(60)' },
    empresa_dsto:    { type: 'varchar(120)' },
    nombre_empresa:  { type: 'varchar(120)' },
    ciudad:          { type: 'varchar(80)' },
    password_hash:   { type: 'text', notNull: true },
    is_active:       { type: 'boolean', default: true },
    created_at:      { type: 'timestamptz', default: pgm.func('now()') },
    updated_at:      { type: 'timestamptz', default: pgm.func('now()') },
  });
};

export const down = (pgm) => {
  pgm.dropTable('asociados');
};
