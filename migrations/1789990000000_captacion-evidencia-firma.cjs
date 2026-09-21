/* eslint-disable camelcase */
// Evidencia de la firma electrónica de la vinculación:
//  - captacion_textos_consentimiento: texto íntegro de cada versión de lo que la persona aceptó (habeas data, declaración, firma
//    electrónica). Es inmutable: no se actualiza ni se borra, así se puede demostrar exactamente qué leyó al firmar.
//  - captacion_otp.user_agent: dispositivo desde el que se pidió el código.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE captacion_textos_consentimiento (
      tipo       VARCHAR(40)  NOT NULL,
      version    VARCHAR(40)  NOT NULL,
      texto      TEXT         NOT NULL,
      hash       CHAR(64)     NOT NULL,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tipo, version)
    );

    CREATE FUNCTION captacion_textos_inmutables() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'captacion_textos_consentimiento es inmutable (% de % %)', TG_OP, OLD.tipo, OLD.version;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER captacion_textos_no_modificar
      BEFORE UPDATE OR DELETE ON captacion_textos_consentimiento
      FOR EACH ROW EXECUTE FUNCTION captacion_textos_inmutables();

    ALTER TABLE captacion_otp ADD COLUMN IF NOT EXISTS user_agent TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE captacion_otp DROP COLUMN IF EXISTS user_agent;
    DROP TRIGGER IF EXISTS captacion_textos_no_modificar ON captacion_textos_consentimiento;
    DROP FUNCTION IF EXISTS captacion_textos_inmutables();
    DROP TABLE IF EXISTS captacion_textos_consentimiento;
  `);
};
