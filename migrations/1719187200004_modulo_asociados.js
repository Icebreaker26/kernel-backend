export const up = (pgm) => {
  pgm.sql(`
    INSERT INTO modulos (nombre, descripcion)
    VALUES ('asociados', 'Gestión e importación de asociados de la cooperativa')
    ON CONFLICT (nombre) DO NOTHING;
  `);
};

export const down = (pgm) => {
  pgm.sql(`DELETE FROM modulos WHERE nombre = 'asociados';`);
};
