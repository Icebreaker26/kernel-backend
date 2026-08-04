export const up = (pgm) => {
  pgm.sql(`
    INSERT INTO modulos (nombre, descripcion)
    VALUES ('gerencia', 'Centro de mando gerencial — KPIs y métricas consolidadas')
    ON CONFLICT (nombre) DO NOTHING;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DELETE FROM permisos WHERE modulo_id = (SELECT id FROM modulos WHERE nombre = 'gerencia');
    DELETE FROM modulos WHERE nombre = 'gerencia';
  `);
};
