/* eslint-disable camelcase */
// Flexible del maestro de cartera de SOLIDO: el agente lo exporta (Cartera → Menu Asociados → Consulta flexible del maestro de cartera →
// Excel → CSV UTF-8) y lo sube a Kernel. NO se aplica solo: queda `recibida` hasta que una persona con permiso lo revise y apruebe
// (el análisis y la aplicación son los mismos del sync manual de CSV de asociados).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE rpa_flexibles (
      id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      estado          VARCHAR(20) NOT NULL DEFAULT 'solicitada'
                        CHECK (estado IN ('solicitada','ejecutando','recibida','aplicando','aplicada','rechazada','fallida','cancelada')),
      solicitada_por  UUID REFERENCES global_usuarios(id),
      agente_id       UUID REFERENCES rpa_agentes(id),
      nombre_archivo  VARCHAR(200),
      tamano_bytes    INTEGER,
      sha256          CHAR(64),
      filas           INTEGER,
      csv             BYTEA,
      error           TEXT,
      resultado       JSONB,
      revisada_por    UUID REFERENCES global_usuarios(id),
      revisada_at     TIMESTAMPTZ,
      nota            TEXT,
      iniciada_at     TIMESTAMPTZ,
      recibida_at     TIMESTAMPTZ,
      is_active       BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Solo una exportación en curso a la vez (solicitada o ejecutándose)
    CREATE UNIQUE INDEX rpa_flexibles_una_en_curso ON rpa_flexibles ((true)) WHERE is_active AND estado IN ('solicitada','ejecutando');
    CREATE INDEX rpa_flexibles_estado ON rpa_flexibles (estado, created_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS rpa_flexibles CASCADE;`);
};
