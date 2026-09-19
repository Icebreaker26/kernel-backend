/* eslint-disable camelcase */
// Autorización de tratamiento de datos (Ley 1581 de 2012) registrada por el TITULAR en el formulario,
// con versión del texto, fecha e IP. Hasta ahora el kiosco y el enlace de grupo la marcaban como aceptada
// al crear el prospecto, sin que la persona hubiera visto nada.
//   habeas_data_origen: 'titular' = la aceptó la persona en el formulario; 'asesor' = la declaró el asesor
//   al crear el prospecto (no basta: el formulario se la vuelve a pedir a la persona).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE captacion_prospectos
      ADD COLUMN habeas_data_origen  VARCHAR(10) CHECK (habeas_data_origen IN ('titular', 'asesor')),
      ADD COLUMN habeas_data_version VARCHAR(20),
      ADD COLUMN habeas_data_ip      VARCHAR(45);

    -- Ya firmaron: aceptaron la declaración con su firma, que incluye el tratamiento de datos
    UPDATE captacion_prospectos p
       SET habeas_data_origen = 'titular', habeas_data_version = 'firma-v1.0',
           habeas_data_at = v.firma_at, acepta_habeas_data = true
      FROM captacion_vinculaciones v
     WHERE v.prospecto_id = p.id AND v.seccion_firma_at IS NOT NULL AND p.habeas_data_origen IS NULL;

    -- Creados desde el kiosco o el enlace de grupo y sin firmar: nadie aceptó nada todavía
    UPDATE captacion_prospectos p
       SET acepta_habeas_data = false, habeas_data_at = NULL
     WHERE p.habeas_data_origen IS NULL
       AND EXISTS (SELECT 1 FROM captacion_eventos e WHERE e.prospecto_id = p.id AND e.tipo IN ('stand_init', 'enlace_publico_init'));

    -- El resto los creó un asesor declarando el consentimiento
    UPDATE captacion_prospectos SET habeas_data_origen = 'asesor'
     WHERE habeas_data_origen IS NULL AND acepta_habeas_data = true;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE captacion_prospectos
      DROP COLUMN IF EXISTS habeas_data_origen,
      DROP COLUMN IF EXISTS habeas_data_version,
      DROP COLUMN IF EXISTS habeas_data_ip;
  `);
};
