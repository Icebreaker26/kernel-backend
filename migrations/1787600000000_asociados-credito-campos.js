// Añade campos de crédito a asociado_descuentos (valor_obligacion, num_cuotas, fecha_vencimiento, tasa_interes).
export const up = (pgm) => {
  pgm.addColumns('asociado_descuentos', {
    valor_obligacion: { type: 'NUMERIC(14,2)', notNull: false },
    num_cuotas:       { type: 'INTEGER',       notNull: false },
    fecha_vencimiento:{ type: 'DATE',          notNull: false },
    tasa_interes:     { type: 'NUMERIC(8,4)',   notNull: false },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('asociado_descuentos', ['valor_obligacion', 'num_cuotas', 'fecha_vencimiento', 'tasa_interes']);
};
