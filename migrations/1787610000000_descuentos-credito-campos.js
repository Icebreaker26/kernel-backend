// Añade saldo_credito a asociado_descuentos para registrar el saldo pendiente de cada crédito.
export const up = (pgm) => {
  pgm.addColumns('asociado_descuentos', {
    saldo_credito: { type: 'NUMERIC(14,2)', notNull: false },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('asociado_descuentos', ['saldo_credito']);
};
