export const up = (pgm) => {
  pgm.addColumn('asociados', {
    valor_aporte_desde: { type: 'DATE', notNull: false },
  });
  // Asociados que ya tienen cuota asignada: inician desde hoy
  // El administrador puede ajustar la fecha retroactivamente
  pgm.sql(`
    UPDATE asociados SET valor_aporte_desde = CURRENT_DATE WHERE valor_aporte IS NOT NULL
  `);
};

export const down = (pgm) => {
  pgm.dropColumn('asociados', 'valor_aporte_desde');
};
