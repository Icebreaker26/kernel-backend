/* eslint-disable camelcase */
// Validación de identidad por llamada de voz: un asesor llama al celular registrado, hace preguntas que solo el titular sabría,
// confirma su voluntad de asociarse y de firmar, y deja el resultado. Cada intento queda (no se edita ni se reescribe).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE captacion_validaciones_voz (
      id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      vinculacion_id    UUID         NOT NULL REFERENCES captacion_vinculaciones(id) ON DELETE CASCADE,
      asesor_uuid       UUID         NOT NULL REFERENCES global_usuarios(id),
      resultado         VARCHAR(20)  NOT NULL CHECK (resultado IN ('validada','no_contesta','no_coincide')),
      celular_llamado   VARCHAR(20)  NOT NULL,
      preguntas         JSONB        NOT NULL DEFAULT '[]',
      confirma_voluntad BOOLEAN      NOT NULL DEFAULT false,
      grabada           BOOLEAN      NOT NULL DEFAULT false,
      observaciones     TEXT,
      ip                VARCHAR(64),
      user_agent        TEXT,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_captacion_validaciones_voz_vinc ON captacion_validaciones_voz (vinculacion_id, created_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS captacion_validaciones_voz;`);
};
