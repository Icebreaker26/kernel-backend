export const up = (pgm) => {
  pgm.sql(`
    INSERT INTO modulos (nombre, descripcion)
    VALUES ('patronales', 'Cuentas de cobro y facturación de aportes a empresas')
    ON CONFLICT (nombre) DO NOTHING;

    INSERT INTO acciones (nombre) VALUES ('READ')   ON CONFLICT DO NOTHING;
    INSERT INTO acciones (nombre) VALUES ('WRITE')  ON CONFLICT DO NOTHING;
    INSERT INTO acciones (nombre) VALUES ('DELETE') ON CONFLICT DO NOTHING;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DELETE FROM modulos WHERE nombre = 'patronales';
  `);
};
