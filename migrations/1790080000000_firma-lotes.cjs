/* eslint-disable camelcase */
// Firma por lotes: una misma tanda (hasta 10 documentos) firmada de una sola pasada por los mismos firmantes.
// Cada documento conserva su propio folio y sello; lote_id los agrupa en el log.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE firma_eventos
      ADD COLUMN lote_id    UUID,
      ADD COLUMN lote_pos   INTEGER,
      ADD COLUMN lote_total INTEGER;
    CREATE INDEX idx_firma_eventos_lote ON firma_eventos (lote_id) WHERE lote_id IS NOT NULL;

    -- Los datos del lote también quedan inmutables (el resto de reglas del log se conserva)
    CREATE OR REPLACE FUNCTION firma_eventos_solo_agregar() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'firma_eventos es de solo agregar';
      END IF;
      -- empleado_id sí puede cambiar (pasa a NULL si se elimina al usuario); h_final solo se fija una vez
      IF (OLD.h_final IS NOT NULL AND (NEW.h_final IS DISTINCT FROM OLD.h_final OR NEW.final_at IS DISTINCT FROM OLD.final_at))
         OR NEW.folio IS DISTINCT FROM OLD.folio OR NEW.h_original IS DISTINCT FROM OLD.h_original
         OR NEW.firmantes IS DISTINCT FROM OLD.firmantes OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.lote_id IS DISTINCT FROM OLD.lote_id OR NEW.lote_pos IS DISTINCT FROM OLD.lote_pos
         OR NEW.lote_total IS DISTINCT FROM OLD.lote_total THEN
        RAISE EXCEPTION 'firma_eventos solo permite fijar h_final una vez';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_firma_eventos_lote;
    ALTER TABLE firma_eventos DROP COLUMN IF EXISTS lote_total, DROP COLUMN IF EXISTS lote_pos, DROP COLUMN IF EXISTS lote_id;
  `);
};
