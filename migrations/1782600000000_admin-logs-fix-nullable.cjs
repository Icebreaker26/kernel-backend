exports.shorthands = undefined;

// La columna usuario_uuid fue definida como NOT NULL + ON DELETE SET NULL,
// combinación contradictoria. Se elimina la restricción NOT NULL para que
// ON DELETE SET NULL funcione correctamente al borrar un usuario.
exports.up = (pgm) => {
  pgm.alterColumn('admin_logs', 'usuario_uuid', { notNull: false });
};

exports.down = (pgm) => {
  pgm.alterColumn('admin_logs', 'usuario_uuid', { notNull: true });
};
