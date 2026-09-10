/**
 * Agrega fecha_pago a tesoreria_facturas para el flujo de autorización.
 * Antes, la fecha de pago vivía solo en el movimiento; ahora se registra
 * también en la factura al autorizarla (fecha esperada de pago).
 */

export const up = (pgm) => {
  pgm.addColumn('tesoreria_facturas', {
    fecha_pago: { type: 'date', notNull: false },
  });
};

export const down = (pgm) => {
  pgm.dropColumn('tesoreria_facturas', 'fecha_pago');
};
