/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.addColumn('asociados', {
    portal_activado_at: { type: 'TIMESTAMPTZ', notNull: false, default: null },
  });

  // Retroactivo: asociados ya activos usan updated_at como aproximación
  pgm.sql(`
    UPDATE asociados
    SET portal_activado_at = updated_at
    WHERE portal_activo = true AND portal_activado_at IS NULL
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.dropColumn('asociados', 'portal_activado_at');
};
