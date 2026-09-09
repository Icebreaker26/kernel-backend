export const up = (pgm) => {
  pgm.sql(`
    INSERT INTO modulos (nombre, descripcion)
    VALUES ('contable', 'Área Contable — registro y seguimiento de facturas de proveedores')
    ON CONFLICT (nombre) DO NOTHING;
  `);
};

export const down = (pgm) => {
  pgm.sql(`DELETE FROM modulos WHERE nombre = 'contable'`);
};
