/* eslint-disable camelcase */
// Firma electrónica presencial (utilidad genérica). No se guarda el PDF ni la firma ni la huella: solo un log mínimo
// con los hashes del documento, los datos de identificación de los firmantes y el empleado que asistió.
// El log es de solo agregar: no se borra, y h_final se puede fijar una única vez (para poder verificar el PDF descargado).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE firma_eventos (
      id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      folio          UUID NOT NULL UNIQUE DEFAULT uuid_generate_v4(),
      h_original     CHAR(64) NOT NULL,
      h_final        CHAR(64),
      nombre_archivo TEXT NOT NULL,
      paginas        INTEGER NOT NULL,
      empleado_id    UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      firmantes      JSONB NOT NULL,
      ip             TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      final_at       TIMESTAMPTZ
    );
    CREATE INDEX idx_firma_eventos_final ON firma_eventos (h_final) WHERE h_final IS NOT NULL;
    CREATE INDEX idx_firma_eventos_empleado ON firma_eventos (empleado_id, created_at DESC);

    CREATE OR REPLACE FUNCTION firma_eventos_solo_agregar() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'firma_eventos es de solo agregar';
      END IF;
      -- empleado_id sí puede cambiar (pasa a NULL si se elimina al usuario); h_final solo se fija una vez
      IF (OLD.h_final IS NOT NULL AND (NEW.h_final IS DISTINCT FROM OLD.h_final OR NEW.final_at IS DISTINCT FROM OLD.final_at))
         OR NEW.folio IS DISTINCT FROM OLD.folio OR NEW.h_original IS DISTINCT FROM OLD.h_original
         OR NEW.firmantes IS DISTINCT FROM OLD.firmantes OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'firma_eventos solo permite fijar h_final una vez';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER trg_firma_eventos_solo_agregar BEFORE UPDATE OR DELETE ON firma_eventos
      FOR EACH ROW EXECUTE FUNCTION firma_eventos_solo_agregar();

    INSERT INTO modulos (nombre, descripcion)
    VALUES ('firma', 'Firma electrónica presencial de documentos (tableta y huellero)')
    ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_firma_eventos_solo_agregar ON firma_eventos;
    DROP FUNCTION IF EXISTS firma_eventos_solo_agregar();
    DROP TABLE IF EXISTS firma_eventos;
    DELETE FROM permisos WHERE modulo_id IN (SELECT id FROM modulos WHERE nombre = 'firma');
    DELETE FROM modulos WHERE nombre = 'firma';
  `);
};
