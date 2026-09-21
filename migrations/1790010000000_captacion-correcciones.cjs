/* eslint-disable camelcase */
// Correcciones de identidad hechas por el asesor (p. ej. un número de cédula mal escrito): queda quién, cuándo, por qué, el valor
// anterior y el nuevo, y el PDF sellado que había antes (se conserva; el nuevo se sella con los datos corregidos).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE captacion_correcciones (
      id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      vinculacion_id    UUID        NOT NULL REFERENCES captacion_vinculaciones(id) ON DELETE CASCADE,
      asesor_uuid       UUID        NOT NULL REFERENCES global_usuarios(id),
      antes             JSONB       NOT NULL,
      despues           JSONB       NOT NULL,
      motivo            TEXT        NOT NULL,
      pdf_anterior_id   UUID,
      pdf_anterior_hash VARCHAR(64),
      ip                VARCHAR(64),
      user_agent        TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_captacion_correcciones_vinc ON captacion_correcciones (vinculacion_id, created_at DESC);

    -- El asesor compara cédula y nombre de la solicitud con la foto de la cédula y deja el resultado:
    -- 'confirmada' (coincide tal cual) o 'corregida' (los escribió como aparecen en la cédula).
    CREATE TABLE captacion_verificaciones_identidad (
      id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      vinculacion_id UUID        NOT NULL REFERENCES captacion_vinculaciones(id) ON DELETE CASCADE,
      asesor_uuid    UUID        NOT NULL REFERENCES global_usuarios(id),
      cedula         VARCHAR(30) NOT NULL,
      nombres        VARCHAR(150) NOT NULL,
      apellidos      VARCHAR(150) NOT NULL,
      origen         VARCHAR(12) NOT NULL CHECK (origen IN ('confirmada', 'corregida')),
      correccion_id  UUID REFERENCES captacion_correcciones(id) ON DELETE SET NULL,
      ip             VARCHAR(64),
      user_agent     TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_captacion_verif_identidad_vinc ON captacion_verificaciones_identidad (vinculacion_id, created_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS captacion_verificaciones_identidad;
    DROP TABLE IF EXISTS captacion_correcciones;
  `);
};
