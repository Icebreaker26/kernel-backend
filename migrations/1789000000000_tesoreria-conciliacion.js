/**
 * Conciliación bancaria — Opción B
 *
 * - Agrega estado 'autorizada' a tesoreria_facturas para separar
 *   "aprobada para pago" de "confirmada por el banco".
 * - Agrega factura_id a tesoreria_movimientos para enlazar cada
 *   movimiento de extracto con la factura que lo originó.
 */

export const up = (pgm) => {
  // 1. Nuevo estado 'autorizada' en facturas
  // El CHECK original solo tenía 4 estados; lo reemplazamos por uno con 5.
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
  `);

  // 2. FK factura_id en movimientos (nullable — la mayoría no tiene factura)
  pgm.addColumn('tesoreria_movimientos', {
    factura_id: {
      type: 'uuid',
      references: '"tesoreria_facturas"(id)',
      onDelete: 'SET NULL',
      notNull: false,
    },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('tesoreria_movimientos', 'factura_id');

  pgm.sql(`
    ALTER TABLE tesoreria_facturas
      DROP CONSTRAINT IF EXISTS tesoreria_facturas_estado_check;

    ALTER TABLE tesoreria_facturas
      ADD CONSTRAINT tesoreria_facturas_estado_check
      CHECK (estado IN (
        'pendiente_aprobacion',
        'aprobada',
        'pagada',
        'rechazada'
      ));
  `);
};
