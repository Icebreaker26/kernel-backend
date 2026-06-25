export const up = (pgm) => {
  pgm.sql(`
    INSERT INTO modulos (nombre, descripcion)
    VALUES ('perfil', 'Gestión del perfil propio del usuario')
    ON CONFLICT DO NOTHING;

    -- Todo usuario autenticado puede leer y editar su propio perfil
    INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
    SELECT u.id, m.id, a.id
    FROM global_usuarios u, modulos m, acciones a
    WHERE m.nombre = 'perfil'
      AND a.nombre IN ('READ', 'WRITE')
    ON CONFLICT DO NOTHING;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DELETE FROM permisos
    WHERE modulo_id = (SELECT id FROM modulos WHERE nombre = 'perfil');
    DELETE FROM modulos WHERE nombre = 'perfil';
  `);
};
