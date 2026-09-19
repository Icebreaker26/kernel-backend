/* eslint-disable camelcase */
// Agrega columna token (texto plano) para poder reconstruir el link de WhatsApp.
// token_hash queda como índice de lookup seguro; token permite regenerar la URL.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE captacion_prospectos
      ADD COLUMN token VARCHAR(64) UNIQUE;

    CREATE INDEX idx_captacion_prospectos_token ON captacion_prospectos(token);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_captacion_prospectos_token;
    ALTER TABLE captacion_prospectos DROP COLUMN IF EXISTS token;
  `);
};
