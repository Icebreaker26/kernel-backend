/* eslint-disable camelcase */
// Búsqueda automática en fuentes abiertas (noticias y web): el sistema busca por el nombre del asociado con palabras de riesgo y guarda
// los enlaces y el resumen breve de cada resultado para que el asesor los revise; van también en el PDF de la constancia.
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE captacion_consultas_listas ADD COLUMN IF NOT EXISTS busquedas JSONB;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE captacion_consultas_listas DROP COLUMN IF EXISTS busquedas;`);
};
