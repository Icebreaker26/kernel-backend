/* eslint-disable camelcase */
// Cola de correos transaccionales (hoy: PQRS). Si el correo no puede salir (relay y SES caídos o sin configurar), en vez de
// perderse queda aquí y un proceso lo reintenta con esperas crecientes hasta que haya canal.
//  - html/texto pueden llevar datos sensibles (p. ej. el código de seguimiento): se borran al terminar el envío.
//  - No es una entidad de negocio: se depura por antigüedad (borrado físico) en vez de is_active.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE email_cola (
      id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tipo            VARCHAR(50)  NOT NULL,
      destinatario    VARCHAR(254) NOT NULL,
      asunto          VARCHAR(300) NOT NULL,
      html            TEXT,
      texto           TEXT,
      referencia_tipo VARCHAR(30),
      referencia_id   UUID,
      estado          VARCHAR(12)  NOT NULL DEFAULT 'pendiente'
                      CHECK (estado IN ('pendiente', 'enviando', 'enviado', 'fallido', 'suprimido')),
      intentos        INTEGER      NOT NULL DEFAULT 0,
      proximo_intento TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      ultimo_error    TEXT,
      enviado_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_email_cola_pendientes ON email_cola (proximo_intento) WHERE estado = 'pendiente';
    CREATE INDEX idx_email_cola_referencia ON email_cola (referencia_tipo, referencia_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS email_cola;`);
};
