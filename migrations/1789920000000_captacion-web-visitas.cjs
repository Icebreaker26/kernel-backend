/* eslint-disable camelcase */
// Visitas a la página pública /asociate, para medir el embudo del botón "Asóciate aquí" del sitio:
// visitas -> inician (web_init) -> se identifican -> firman.
// Solo se guarda la fecha: sin IP, sin agente de usuario ni identificadores de la persona.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE captacion_web_visitas (
      id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_captacion_web_visitas_fecha ON captacion_web_visitas (created_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS captacion_web_visitas;`);
};
