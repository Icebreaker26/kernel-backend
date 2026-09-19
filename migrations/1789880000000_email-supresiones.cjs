/* eslint-disable camelcase */
// Rebotes y quejas de Amazon SES (llegan por SNS a /api/email/ses-eventos).
//  - email_supresiones: direcciones a las que ya no se envía (rebote permanente o queja). Borrado lógico:
//    is_active = false la reactiva (p. ej. si el buzón se corrigió).
//  - email_ses_eventos: bitácora de cada notificación recibida, incluidos los rebotes temporales.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE email_supresiones (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      email       VARCHAR(254) NOT NULL,
      motivo      VARCHAR(10)  NOT NULL CHECK (motivo IN ('rebote', 'queja')),
      detalle     JSONB,
      is_active   BOOLEAN      NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX uq_email_supresiones_email ON email_supresiones (lower(email));

    CREATE TABLE email_ses_eventos (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tipo        VARCHAR(20)  NOT NULL CHECK (tipo IN ('rebote_permanente', 'rebote_temporal', 'queja')),
      email       VARCHAR(254) NOT NULL,
      message_id  VARCHAR(200),
      payload     JSONB,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_email_ses_eventos_email ON email_ses_eventos (lower(email), created_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS email_ses_eventos;
    DROP TABLE IF EXISTS email_supresiones;
  `);
};
