export const up = (pgm) => {
  pgm.addColumns('asociados', {
    fecha_nacimiento: { type: 'DATE' },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('asociados', ['fecha_nacimiento']);
};
