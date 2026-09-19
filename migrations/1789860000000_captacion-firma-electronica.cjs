/* eslint-disable camelcase */
// Evidencia de firma electrónica (Ley 527 de 1999, Decreto 2364 de 2012):
//  - consentimiento explícito del asociado a firmar electrónicamente, con la versión del texto aceptado;
//  - copia sellada del PDF (Formato No. 5) generada en el momento de firmar, con su hash SHA-256.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE captacion_vinculaciones
      ADD COLUMN firma_electronica_at      TIMESTAMPTZ,
      ADD COLUMN firma_electronica_version VARCHAR(20),
      ADD COLUMN firma_pdf_archivo_id      UUID REFERENCES archivos(id) ON DELETE SET NULL,
      ADD COLUMN firma_pdf_hash            VARCHAR(64),
      ADD COLUMN firma_pdf_at              TIMESTAMPTZ;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE captacion_vinculaciones
      DROP COLUMN IF EXISTS firma_electronica_at,
      DROP COLUMN IF EXISTS firma_electronica_version,
      DROP COLUMN IF EXISTS firma_pdf_archivo_id,
      DROP COLUMN IF EXISTS firma_pdf_hash,
      DROP COLUMN IF EXISTS firma_pdf_at;
  `);
};
