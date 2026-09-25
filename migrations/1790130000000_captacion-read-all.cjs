/* eslint-disable camelcase */
// Acción READ_ALL en captación: ver y abrir (solo lectura) las vinculaciones de todos los asesores.
// Se asigna por usuario en la tabla permisos; el admin la tiene implícita.
exports.up = (pgm) => {
  pgm.sql(`INSERT INTO acciones (nombre) VALUES ('READ_ALL') ON CONFLICT (nombre) DO NOTHING;`);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM permisos WHERE accion_id = (SELECT id FROM acciones WHERE nombre = 'READ_ALL');
    DELETE FROM acciones WHERE nombre = 'READ_ALL';
  `);
};
