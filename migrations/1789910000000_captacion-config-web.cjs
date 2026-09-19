/* eslint-disable camelcase */
// Configuración del módulo de captación que se elige desde la interfaz (no por variables de entorno).
//   clave 'web_asesor_uuid': asesor al que se asignan las solicitudes de la página pública /asociate.
// Acción nueva CONFIGURAR: quien la tenga (o el rol admin) puede cambiar esa configuración desde la pestaña
// de prospectos. Se asigna a los usuarios desde la pantalla normal de permisos.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE captacion_config (
      clave           VARCHAR(50) PRIMARY KEY,
      valor           TEXT,
      actualizado_por UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO acciones (nombre) VALUES ('CONFIGURAR') ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS captacion_config;
    DELETE FROM permisos WHERE accion_id IN (SELECT id FROM acciones WHERE nombre = 'CONFIGURAR');
    DELETE FROM acciones WHERE nombre = 'CONFIGURAR';
  `);
};
