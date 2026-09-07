/**
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.createTable('cobros_efectivo', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    asociado_codigo:    { type: 'varchar(20)', notNull: true, references: '"asociados"(codigo)' },
    sorteo_id:          { type: 'uuid', references: '"sorteos"(id)', onDelete: 'SET NULL' },
    numero_bono:        { type: 'integer', notNull: true },
    monto:              { type: 'numeric(10,2)', notNull: true, check: 'monto > 0' },
    tipo_pago:          { type: 'varchar(10)', notNull: true, check: "tipo_pago IN ('banco','caja')" },
    comprobante:        { type: 'varchar(100)', notNull: true },
    comentario:         { type: 'varchar(500)', default: "''" },
    tipo_discrepancia:  { type: 'varchar(30)', notNull: true },
    periodo:            { type: 'varchar(7)', notNull: true },
    sync_id:            { type: 'uuid', references: '"sincronizaciones"(id)', onDelete: 'SET NULL' },
    registrado_por_uuid: { type: 'uuid', notNull: true, references: '"global_usuarios"(id)' },
    created_at:         { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.addIndex('cobros_efectivo', 'sorteo_id');
  pgm.addIndex('cobros_efectivo', 'asociado_codigo');
  pgm.addIndex('cobros_efectivo', 'periodo');
  pgm.addConstraint(
    'cobros_efectivo',
    'cobros_efectivo_unique_bono',
    'UNIQUE (sync_id, asociado_codigo, tipo_discrepancia, numero_bono)'
  );
};

export const down = (pgm) => {
  pgm.dropTable('cobros_efectivo');
};
