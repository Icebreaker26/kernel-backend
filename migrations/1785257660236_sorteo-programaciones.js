export const up = (pgm) => {
  pgm.createTable('sorteo_programaciones', {
    id:                { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    sorteo_id:         { type: 'uuid', notNull: true, references: '"sorteos"', onDelete: 'CASCADE' },
    fecha_cierre:      { type: 'timestamptz', notNull: true },
    fecha_apertura:    { type: 'timestamptz', notNull: true },
    ejecutado_cierre:  { type: 'boolean', notNull: true, default: false },
    ejecutado_apertura:{ type: 'boolean', notNull: true, default: false },
    created_at:        { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('sorteo_programaciones', 'sorteo_id');
  pgm.createIndex('sorteo_programaciones', ['ejecutado_cierre', 'fecha_cierre']);
  pgm.createIndex('sorteo_programaciones', ['ejecutado_apertura', 'fecha_apertura']);
};

export const down = (pgm) => {
  pgm.dropTable('sorteo_programaciones');
};
