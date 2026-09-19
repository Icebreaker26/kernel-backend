/* eslint-disable camelcase */
// Baja voluntaria de campañas y avisos institucionales (enlace "Dejar de recibir avisos" del pie de correo).
// Solo afecta a la cola de mailing: los códigos de firma y las credenciales del portal siguen enviándose.
// Borrado lógico: is_active = false reactiva el envío (el asociado puede volver a suscribirse).
// 'omitido' en cola_mailing = destinatario que se dio de baja antes de que le tocara el envío.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE email_bajas (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      email       VARCHAR(254) NOT NULL,
      is_active   BOOLEAN      NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX uq_email_bajas_email ON email_bajas (lower(email));

    ALTER TABLE cola_mailing DROP CONSTRAINT IF EXISTS cola_mailing_estado_check;
    ALTER TABLE cola_mailing ADD CONSTRAINT cola_mailing_estado_check
      CHECK (estado IN ('pendiente', 'enviado', 'error', 'omitido'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE cola_mailing SET estado = 'error' WHERE estado = 'omitido';
    ALTER TABLE cola_mailing DROP CONSTRAINT IF EXISTS cola_mailing_estado_check;
    ALTER TABLE cola_mailing ADD CONSTRAINT cola_mailing_estado_check
      CHECK (estado IN ('pendiente', 'enviado', 'error'));
    DROP TABLE IF EXISTS email_bajas;
  `);
};
