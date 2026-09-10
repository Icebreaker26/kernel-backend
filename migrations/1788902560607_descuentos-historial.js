export const up = (pgm) => {
  // Nuevas columnas en asociado_descuentos para borrado lógico y trazabilidad del sync
  pgm.addColumns('asociado_descuentos', {
    is_active:         { type: 'boolean', notNull: true, default: true },
    ultima_vez_en_csv: { type: 'timestamptz' },
    origen:            { type: 'varchar(10)', notNull: true, default: 'csv' },
  });

  // Tabla de historial de cambios en descuentos
  pgm.createTable('asociado_descuentos_historial', {
    id:              { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    asociado_codigo: { type: 'varchar', notNull: true },
    linea_id:        { type: 'integer', notNull: true },
    nombre_linea:    { type: 'varchar(120)', notNull: true },
    numero:          { type: 'varchar(40)' },
    campo:           { type: 'varchar(40)', notNull: true },
    valor_anterior:  { type: 'numeric(14,2)' },
    valor_nuevo:     { type: 'numeric(14,2)' },
    fuente:          { type: 'varchar(10)', notNull: true, default: 'csv' },
    sync_id:         { type: 'uuid' },
    usuario_uuid:    { type: 'uuid' },
    changed_at:      { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex('asociado_descuentos_historial', ['asociado_codigo', 'linea_id', 'changed_at']);
};

export const down = (pgm) => {
  pgm.dropTable('asociado_descuentos_historial');
  pgm.dropColumns('asociado_descuentos', ['is_active', 'ultima_vez_en_csv', 'origen']);
};
