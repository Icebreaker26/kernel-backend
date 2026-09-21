/* eslint-disable camelcase */
// Consulta en listas restrictivas y fuentes abiertas (SARLAFT) antes de vincular a un asociado.
//  - listas_versiones / listas_entradas: copia local de las listas públicas (ONU, OFAC, UE, Reino Unido, PEP SIGEP, SIRI). De cada
//    descarga queda la versión con su hash; el archivo original va a S3. Solo la versión activa conserva sus entradas.
//  - captacion_consultas_listas: cada consulta que hace el asesor (coincidencias, sus decisiones, consultas manuales, PDF en S3) y la
//    validación posterior del Oficial de Cumplimiento.
//  - acción VALIDAR del módulo captación: quien puede validar las consultas (el Oficial de Cumplimiento).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE listas_versiones (
      id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      fuente        VARCHAR(20)  NOT NULL,
      url           TEXT         NOT NULL,
      publicada     VARCHAR(60),
      descargada_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      verificada_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      sha256        CHAR(64),
      bytes         BIGINT,
      registros     INTEGER      NOT NULL DEFAULT 0,
      activa        BOOLEAN      NOT NULL DEFAULT false,
      estado        VARCHAR(8)   NOT NULL DEFAULT 'ok' CHECK (estado IN ('ok', 'error')),
      error         TEXT,
      archivos      JSONB        NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX uq_listas_version_activa ON listas_versiones (fuente) WHERE activa;
    CREATE INDEX idx_listas_versiones_fuente ON listas_versiones (fuente, descargada_at DESC);

    CREATE TABLE listas_entradas (
      id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      version_id     UUID        NOT NULL REFERENCES listas_versiones(id) ON DELETE CASCADE,
      fuente         VARCHAR(20) NOT NULL,
      ref            VARCHAR(80),
      tipo           VARCHAR(10) NOT NULL,
      nombre         TEXT        NOT NULL,
      alias          TEXT[]      NOT NULL DEFAULT '{}',
      documentos     TEXT[]      NOT NULL DEFAULT '{}',
      nacimiento     TEXT[]      NOT NULL DEFAULT '{}',
      nacionalidades TEXT[]      NOT NULL DEFAULT '{}',
      detalle        JSONB       NOT NULL DEFAULT '{}'
    );
    CREATE INDEX idx_listas_entradas_version ON listas_entradas (version_id);
    CREATE INDEX idx_listas_entradas_docs ON listas_entradas USING GIN (documentos);

    CREATE TABLE captacion_consultas_listas (
      id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      vinculacion_id          UUID         NOT NULL REFERENCES captacion_vinculaciones(id) ON DELETE CASCADE,
      asesor_uuid             UUID         NOT NULL REFERENCES global_usuarios(id),
      cedula                  VARCHAR(30)  NOT NULL,
      nombres                 VARCHAR(150) NOT NULL,
      apellidos               VARCHAR(150) NOT NULL,
      fecha_nacimiento        DATE,
      estado                  VARCHAR(10)  NOT NULL DEFAULT 'en_curso'
                              CHECK (estado IN ('en_curso', 'cerrada', 'validada', 'observada', 'anulada')),
      versiones               JSONB        NOT NULL DEFAULT '{}',
      coincidencias           JSONB        NOT NULL DEFAULT '[]',
      manual                  JSONB        NOT NULL DEFAULT '{}',
      declaracion_pep         JSONB,
      parametros              JSONB        NOT NULL DEFAULT '{}',
      conclusion              VARCHAR(20),
      datos_hash              CHAR(64),
      pdf_archivo_id          UUID,
      pdf_hash                CHAR(64),
      cerrada_at              TIMESTAMPTZ,
      validada_por            UUID REFERENCES global_usuarios(id),
      validada_at             TIMESTAMPTZ,
      observaciones_oficial   TEXT,
      ip                      VARCHAR(64),
      user_agent              TEXT,
      created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_captacion_consultas_vinc ON captacion_consultas_listas (vinculacion_id, created_at DESC);
    CREATE INDEX idx_captacion_consultas_estado ON captacion_consultas_listas (estado, cerrada_at);

    INSERT INTO acciones (nombre) VALUES ('VALIDAR') ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS captacion_consultas_listas;
    DROP TABLE IF EXISTS listas_entradas;
    DROP TABLE IF EXISTS listas_versiones;
  `);
};
