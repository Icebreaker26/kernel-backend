/* eslint-disable camelcase */
// Devolver a subsanar: el asesor marca qué está mal (cédula, firma o datos) con un motivo; la solicitud queda "por subsanar" y no
// se puede entregar hasta que se resuelva. Si se devuelve la firma, la anterior se archiva en captacion_firmas_historial (no se pierde).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE captacion_subsanaciones (
      id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      vinculacion_id UUID        NOT NULL REFERENCES captacion_vinculaciones(id) ON DELETE CASCADE,
      asesor_uuid    UUID        NOT NULL REFERENCES global_usuarios(id),
      items          TEXT[]      NOT NULL,
      motivo         TEXT        NOT NULL,
      correo_enviado BOOLEAN     NOT NULL DEFAULT false,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resuelta_at    TIMESTAMPTZ,
      resuelta_por   VARCHAR(20)
    );
    -- Solo una subsanación abierta por solicitud
    CREATE UNIQUE INDEX uq_captacion_subsanacion_abierta ON captacion_subsanaciones (vinculacion_id) WHERE resuelta_at IS NULL;
    CREATE INDEX idx_captacion_subsanaciones_vinc ON captacion_subsanaciones (vinculacion_id, created_at DESC);

    CREATE TABLE captacion_firmas_historial (
      id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      vinculacion_id UUID        NOT NULL REFERENCES captacion_vinculaciones(id) ON DELETE CASCADE,
      subsanacion_id UUID        REFERENCES captacion_subsanaciones(id) ON DELETE SET NULL,
      datos          JSONB       NOT NULL,
      archivada_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_captacion_firmas_historial_vinc ON captacion_firmas_historial (vinculacion_id, archivada_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS captacion_firmas_historial;
    DROP TABLE IF EXISTS captacion_subsanaciones;
  `);
};
