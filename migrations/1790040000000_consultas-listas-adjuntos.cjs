/* eslint-disable camelcase */
// Soportes adjuntos a la consulta en listas: el asesor puede subir el PDF de la consulta hecha en otro proveedor (p. ej. Starsol) como
// redundancia. Cada adjunto guarda quién lo subió, el proveedor y el hash del archivo; el archivo va a S3 y no se borra.
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE captacion_consultas_listas ADD COLUMN IF NOT EXISTS adjuntos JSONB NOT NULL DEFAULT '[]';`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE captacion_consultas_listas DROP COLUMN IF EXISTS adjuntos;`);
};
