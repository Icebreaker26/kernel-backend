export const up = (pgm) => {
  pgm.addColumns('asociados', {
    fecha_ingreso: { type: 'timestamptz' },
    fecha_retiro:  { type: 'timestamptz' },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('asociados', ['fecha_ingreso', 'fecha_retiro']);
};
