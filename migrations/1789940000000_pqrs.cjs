/* eslint-disable camelcase */
// PQRS (peticiones, quejas, reclamos, sugerencias y felicitaciones) recibidas desde el sitio público.
//  - pqrs: cada solicitud, con radicado (PQRS-AAAA-000001), estado, responsable, fecha límite y respuesta.
//    El código de seguimiento se entrega una sola vez a quien radica; aquí solo se guarda su hash.
//  - pqrs_eventos: historial (creación, cambios de estado, asignaciones, notas internas, respuesta).
// Módulo 'pqrs' con permisos READ (ver) y WRITE (gestionar).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE SEQUENCE pqrs_radicado_seq;

    CREATE TABLE pqrs (
      id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      radicado          VARCHAR(20)  NOT NULL UNIQUE,
      codigo_hash       VARCHAR(64)  NOT NULL,
      tipo              VARCHAR(15)  NOT NULL CHECK (tipo IN ('peticion', 'queja', 'reclamo', 'sugerencia', 'felicitacion')),
      estado            VARCHAR(15)  NOT NULL DEFAULT 'recibida' CHECK (estado IN ('recibida', 'en_revision', 'respondida', 'cerrada')),
      nombre            VARCHAR(120) NOT NULL,
      email             VARCHAR(254) NOT NULL,
      telefono          VARCHAR(20),
      empresa           VARCHAR(120),
      asunto            VARCHAR(150) NOT NULL,
      mensaje           TEXT         NOT NULL,
      acepta_habeas_data BOOLEAN     NOT NULL DEFAULT false,
      habeas_data_version VARCHAR(20),
      ip                VARCHAR(45),
      asignado_a        UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      vence_at          DATE         NOT NULL,
      respuesta         TEXT,
      respondida_at     TIMESTAMPTZ,
      respondida_por    UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      cerrada_at        TIMESTAMPTZ,
      is_active         BOOLEAN      NOT NULL DEFAULT true,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_pqrs_estado ON pqrs (estado, created_at DESC) WHERE is_active;
    CREATE INDEX idx_pqrs_asignado ON pqrs (asignado_a) WHERE is_active;

    CREATE TABLE pqrs_eventos (
      id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      pqrs_id    UUID         NOT NULL REFERENCES pqrs(id) ON DELETE CASCADE,
      tipo       VARCHAR(30)  NOT NULL,
      autor_uuid UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      detalle    TEXT,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_pqrs_eventos ON pqrs_eventos (pqrs_id, created_at);

    INSERT INTO modulos (nombre, descripcion)
    VALUES ('pqrs', 'Peticiones, quejas, reclamos, sugerencias y felicitaciones')
    ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS pqrs_eventos;
    DROP TABLE IF EXISTS pqrs;
    DROP SEQUENCE IF EXISTS pqrs_radicado_seq;
    DELETE FROM permisos WHERE modulo_id IN (SELECT id FROM modulos WHERE nombre = 'pqrs');
    DELETE FROM modulos WHERE nombre = 'pqrs';
  `);
};
