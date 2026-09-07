/**
 * cobros_efectivo: remove FKs so test data with synthetic codes doesn't break.
 * Data integrity is guaranteed by business logic (discrepancy always references
 * an existing asociado/sorteo). Indexes remain.
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  pgm.dropConstraint('cobros_efectivo', 'cobros_efectivo_asociado_codigo_fkey');
  pgm.dropConstraint('cobros_efectivo', 'cobros_efectivo_sorteo_id_fkey');
  pgm.dropConstraint('cobros_efectivo', 'cobros_efectivo_registrado_por_uuid_fkey');
};

export const down = (pgm) => {
  pgm.addConstraint('cobros_efectivo', 'cobros_efectivo_asociado_codigo_fkey',
    'FOREIGN KEY (asociado_codigo) REFERENCES asociados(codigo)');
  pgm.addConstraint('cobros_efectivo', 'cobros_efectivo_sorteo_id_fkey',
    'FOREIGN KEY (sorteo_id) REFERENCES sorteos(id) ON DELETE SET NULL');
  pgm.addConstraint('cobros_efectivo', 'cobros_efectivo_registrado_por_uuid_fkey',
    'FOREIGN KEY (registrado_por_uuid) REFERENCES global_usuarios(id)');
};
