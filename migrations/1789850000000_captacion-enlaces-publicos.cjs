/* eslint-disable camelcase */
// Enlace público de presentación para compartir en grupos (WhatsApp, etc.).
// Uno por asesor y empresa: no caduca ni se anula al abrir un kiosco (a diferencia de las sesiones de stand).
// Quien lo abre ve la presentación de la cooperativa y, si toca "Quiero asociarme", se crea su prospecto
// asignado al asesor.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE captacion_enlaces_publicos (
      id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      token          VARCHAR(64) NOT NULL UNIQUE,
      asesor_uuid    UUID        NOT NULL REFERENCES global_usuarios(id) ON DELETE RESTRICT,
      empresa_codigo VARCHAR(50) NOT NULL REFERENCES empresas(codigo)    ON DELETE RESTRICT,
      is_active      BOOLEAN     NOT NULL DEFAULT true,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (asesor_uuid, empresa_codigo)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS captacion_enlaces_publicos;`);
};
