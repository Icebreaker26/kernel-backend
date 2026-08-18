export const up = (pgm) => {
  pgm.createTable('asociado_descuentos', {
    id:              { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    asociado_codigo: { type: 'varchar', notNull: true },
    linea_id:        { type: 'integer', notNull: true },
    nombre_linea:    { type: 'varchar(120)', notNull: true },
    valor:           { type: 'numeric(12,2)' },
    updated_at:      { type: 'timestamptz', default: pgm.func('NOW()') },
  });
  pgm.addConstraint('asociado_descuentos', 'asociado_descuentos_pkey_uq', 'UNIQUE (asociado_codigo, linea_id)');
  pgm.createIndex('asociado_descuentos', 'asociado_codigo');
};

export const down = (pgm) => {
  pgm.dropTable('asociado_descuentos');
};
