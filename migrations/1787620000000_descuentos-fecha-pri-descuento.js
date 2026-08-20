export const up = (pgm) => {
  pgm.addColumns('asociado_descuentos', {
    fecha_pri_descuento: { type: 'DATE', notNull: false },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('asociado_descuentos', ['fecha_pri_descuento']);
};
