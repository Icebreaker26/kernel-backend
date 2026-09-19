/* eslint-disable camelcase */
// Verificación de identidad para firmar: código de un solo uso (OTP) enviado al correo del asociado.
// Reemplaza al step-up por "últimos 4 dígitos de la cédula", que no prueba que quien firma controle
// un canal propio (Decreto 2364 de 2012, art. 4: los datos de la firma deben ser exclusivos del firmante).
// Solo se guarda el hash del código; `firma_verificacion` deja el canal usado como evidencia.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE captacion_otp (
      id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      prospecto_id  UUID         NOT NULL REFERENCES captacion_prospectos(id) ON DELETE CASCADE,
      canal         VARCHAR(10)  NOT NULL DEFAULT 'correo',
      destino       VARCHAR(200) NOT NULL,
      codigo_hash   VARCHAR(64)  NOT NULL,
      expira_at     TIMESTAMPTZ  NOT NULL,
      intentos      SMALLINT     NOT NULL DEFAULT 0,
      usado_at      TIMESTAMPTZ,
      ip            VARCHAR(45),
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_captacion_otp_prospecto ON captacion_otp(prospecto_id, created_at DESC);

    ALTER TABLE captacion_vinculaciones ADD COLUMN firma_verificacion JSONB;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE captacion_vinculaciones DROP COLUMN IF EXISTS firma_verificacion;
    DROP TABLE IF EXISTS captacion_otp;
  `);
};
