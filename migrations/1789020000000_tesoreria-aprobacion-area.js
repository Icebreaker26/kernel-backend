/**
 * Flujo de aprobación por área responsable:
 * pendiente_aprobacion → aprobada (área) → verificada (CI) → autorizada → pagada
 *
 * - Agrega responsable_id (FK a global_usuarios) a tesoreria_facturas
 * - Agrega verificada_por y verificada_at para trazabilidad de CI
 * - Amplía el CHECK de estado para incluir 'verificada'
 */
export const up = (pgm) => {
  pgm.addColumns('tesoreria_facturas', {
    responsable_id: {
      type: 'uuid',
      references: '"global_usuarios"(id)',
      onDelete: 'SET NULL',
      notNull: false,
    },
    verificada_por: {
      type: 'uuid',
      references: '"global_usuarios"(id)',
      onDelete: 'SET NULL',
      notNull: false,
    },
    verificada_at: { type: 'timestamptz', notNull: false },
  });

  pgm.sql(`
    ALTER TABLE tesoreria_facturas
      DROP CONSTRAINT IF EXISTS tesoreria_facturas_estado_check;
    ALTER TABLE tesoreria_facturas
      ADD CONSTRAINT tesoreria_facturas_estado_check
      CHECK (estado IN (
        'pendiente_aprobacion',
        'aprobada',
        'verificada',
        'autorizada',
        'pagada',
        'rechazada'
      ));
    CREATE INDEX IF NOT EXISTS idx_tsr_fact_responsable ON tesoreria_facturas(responsable_id);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tesoreria_facturas
      DROP CONSTRAINT IF EXISTS tesoreria_facturas_estado_check;
    ALTER TABLE tesoreria_facturas
      ADD CONSTRAINT tesoreria_facturas_estado_check
      CHECK (estado IN (
        'pendiente_aprobacion',
        'aprobada',
        'autorizada',
        'pagada',
        'rechazada'
      ));
    DROP INDEX IF EXISTS idx_tsr_fact_responsable;
  `);
  pgm.dropColumns('tesoreria_facturas', ['responsable_id', 'verificada_por', 'verificada_at']);
};
