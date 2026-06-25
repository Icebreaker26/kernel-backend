export const up = (pgm) => {
  pgm.sql(`
    INSERT INTO modulos (nombre, descripcion)
    VALUES ('sorteos', 'Gestión de sorteos y bonos de la cooperativa')
    ON CONFLICT DO NOTHING;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DELETE FROM permisos WHERE modulo_id = (SELECT id FROM modulos WHERE nombre = 'sorteos');
    DELETE FROM modulos WHERE nombre = 'sorteos';
  `);
};
