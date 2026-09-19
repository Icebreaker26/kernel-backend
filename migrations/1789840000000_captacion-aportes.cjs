/* eslint-disable camelcase */
// Sección "Seguros y beneficios adquiridos" del formulario de vinculación.
// valor_aporte y cuota_admision ya existían (los asignaba el asesor); ahora el asociado elige el aporte
// y el sistema fija el resto. Los valores de fondo/seguro/bono se guardan como copia histórica:
// si la tarifa cambia mañana, las solicitudes ya firmadas conservan lo que aceptó el asociado.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE captacion_vinculaciones
      ADD COLUMN periodicidad_descuento VARCHAR(10)
        CHECK (periodicidad_descuento IN ('mensual', 'quincenal')),
      ADD COLUMN valor_fondo_bienestar  NUMERIC(14,2),
      ADD COLUMN seguro_vida_activo     BOOLEAN,
      ADD COLUMN valor_seguro_vida      NUMERIC(14,2),
      ADD COLUMN bono_sorteo_activo     BOOLEAN,
      ADD COLUMN valor_bono_sorteo      NUMERIC(14,2),
      ADD COLUMN seccion_aportes_at     TIMESTAMPTZ,
      ADD COLUMN seccion_aportes_autor  VARCHAR(20);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE captacion_vinculaciones
      DROP COLUMN IF EXISTS periodicidad_descuento,
      DROP COLUMN IF EXISTS valor_fondo_bienestar,
      DROP COLUMN IF EXISTS seguro_vida_activo,
      DROP COLUMN IF EXISTS valor_seguro_vida,
      DROP COLUMN IF EXISTS bono_sorteo_activo,
      DROP COLUMN IF EXISTS valor_bono_sorteo,
      DROP COLUMN IF EXISTS seccion_aportes_at,
      DROP COLUMN IF EXISTS seccion_aportes_autor;
  `);
};
