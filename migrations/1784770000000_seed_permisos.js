export const up = (pgm) => {
  pgm.sql(`
    INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
    SELECT u.id, m.id, a.id
    FROM global_usuarios u, modulos m, acciones a
    WHERE u.email = 'alejandro.torres0826@gmail.com'
    ON CONFLICT DO NOTHING;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DELETE FROM permisos
    WHERE usuario_uuid = (SELECT id FROM global_usuarios WHERE email = 'alejandro.torres0826@gmail.com');
  `);
};
