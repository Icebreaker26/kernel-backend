export const up = (pgm) => {
  pgm.sql(`
    INSERT INTO modulos (nombre, descripcion)
    VALUES ('admin', 'Gestión de usuarios y permisos del sistema')
    ON CONFLICT (nombre) DO NOTHING;
  `);
};

export const down = (pgm) => {
  pgm.sql(`DELETE FROM modulos WHERE nombre = 'admin';`);
};
