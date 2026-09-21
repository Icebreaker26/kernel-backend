/* eslint-disable camelcase */
// Solicitud de vinculación diligenciada en papel: el asesor digita el formato físico y sube el escaneo firmado
// a mano, que hace de evidencia de la firma y de la autorización de datos (reemplaza el OTP y la firma digital).
// origen_solicitud: 'digital' (flujo de siempre) | 'fisico'. En las físicas no aplica la validación por voz.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE captacion_vinculaciones
      ADD COLUMN origen_solicitud        TEXT NOT NULL DEFAULT 'digital' CHECK (origen_solicitud IN ('digital', 'fisico')),
      ADD COLUMN firma_fisica_archivo_id UUID REFERENCES archivos(id) ON DELETE SET NULL,
      ADD COLUMN firma_fisica_hash       TEXT,
      ADD COLUMN firma_fisica_fecha      DATE,
      ADD COLUMN fisico_digitado_por     UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      ADD COLUMN fisico_observaciones    TEXT;
    CREATE INDEX idx_captacion_vinc_origen ON captacion_vinculaciones (origen_solicitud) WHERE origen_solicitud = 'fisico';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_captacion_vinc_origen;
    ALTER TABLE captacion_vinculaciones
      DROP COLUMN IF EXISTS fisico_observaciones,
      DROP COLUMN IF EXISTS fisico_digitado_por,
      DROP COLUMN IF EXISTS firma_fisica_fecha,
      DROP COLUMN IF EXISTS firma_fisica_hash,
      DROP COLUMN IF EXISTS firma_fisica_archivo_id,
      DROP COLUMN IF EXISTS origen_solicitud;
  `);
};
