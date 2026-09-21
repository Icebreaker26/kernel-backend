/* eslint-disable camelcase */
// Campañas de correo para personas que NO son asociadas (p. ej. jornadas presenciales con aliados).
// - mailing_contactos: quien deja su correo en el evento, con la autorización de tratamiento de datos (Ley 1581).
// - campanas.audiencia: 'asociados' (comportamiento de siempre) | 'contactos' (solo mailing_contactos).
//   Es una columna aparte a propósito: un segmento vacío en 'asociados' significa "todos", y una campaña
//   de contactos nunca debe poder caer por error en toda la base de asociados.
// - cola_mailing: un destinatario es un asociado o un contacto, nunca ambos.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE mailing_contactos (
      id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      nombre             VARCHAR(150) NOT NULL,
      email              VARCHAR(254) NOT NULL,
      telefono           VARCHAR(30),
      jornada            VARCHAR(150) NOT NULL,
      autorizacion_datos BOOLEAN NOT NULL CHECK (autorizacion_datos = true),
      autorizacion_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      creado_por         UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      is_active          BOOLEAN NOT NULL DEFAULT true,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX uq_mailing_contactos_email_jornada
      ON mailing_contactos (lower(email), lower(jornada)) WHERE is_active;
    CREATE INDEX idx_mailing_contactos_jornada ON mailing_contactos (jornada) WHERE is_active;

    ALTER TABLE campanas
      ADD COLUMN audiencia TEXT NOT NULL DEFAULT 'asociados'
      CHECK (audiencia IN ('asociados', 'contactos'));

    ALTER TABLE cola_mailing ALTER COLUMN asociado_codigo DROP NOT NULL;
    ALTER TABLE cola_mailing ADD COLUMN contacto_id UUID REFERENCES mailing_contactos(id) ON DELETE SET NULL;
    ALTER TABLE cola_mailing ADD CONSTRAINT cola_mailing_destinatario_check
      CHECK (num_nonnulls(asociado_codigo, contacto_id) = 1);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM cola_mailing WHERE contacto_id IS NOT NULL;
    ALTER TABLE cola_mailing DROP CONSTRAINT IF EXISTS cola_mailing_destinatario_check;
    ALTER TABLE cola_mailing DROP COLUMN IF EXISTS contacto_id;
    ALTER TABLE cola_mailing ALTER COLUMN asociado_codigo SET NOT NULL;
    ALTER TABLE campanas DROP COLUMN IF EXISTS audiencia;
    DROP TABLE IF EXISTS mailing_contactos;
  `);
};
