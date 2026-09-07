/**
 * cobros_efectivo: reemplazar unique constraint por (asociado_codigo, sorteo_id, numero_bono).
 * El constraint anterior incluía sync_id, permitiendo duplicados cuando cambiaba el sync.
 * @type {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
  // Eliminar duplicados conservando el registro más antiguo por (asociado_codigo, sorteo_id, numero_bono)
  pgm.sql(`
    DELETE FROM cobros_efectivo
    WHERE id NOT IN (
      SELECT DISTINCT ON (asociado_codigo, sorteo_id, numero_bono) id
      FROM cobros_efectivo
      ORDER BY asociado_codigo, sorteo_id, numero_bono, created_at ASC
    )
  `);

  pgm.dropConstraint('cobros_efectivo', 'cobros_efectivo_unique_bono');

  pgm.addConstraint(
    'cobros_efectivo',
    'cobros_efectivo_unique_bono',
    'UNIQUE (asociado_codigo, sorteo_id, numero_bono)'
  );
};

export const down = (pgm) => {
  pgm.dropConstraint('cobros_efectivo', 'cobros_efectivo_unique_bono');
  pgm.addConstraint(
    'cobros_efectivo',
    'cobros_efectivo_unique_bono',
    'UNIQUE (sync_id, asociado_codigo, tipo_discrepancia, numero_bono)'
  );
};
