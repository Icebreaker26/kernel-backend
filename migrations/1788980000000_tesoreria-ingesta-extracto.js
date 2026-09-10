export const up = (pgm) => {
  pgm.sql(`
    -- Campo para el código único del banco (X9 del extracto PWXL)
    ALTER TABLE tesoreria_movimientos
      ADD COLUMN IF NOT EXISTS referencia_bancaria VARCHAR(100),
      ADD COLUMN IF NOT EXISTS tipo_bancario       VARCHAR(10),
      ADD COLUMN IF NOT EXISTS oficina_bancaria    VARCHAR(80),
      ADD COLUMN IF NOT EXISTS detalles_banco      TEXT;

    -- Garantiza que no se dupliquen transacciones del mismo banco en la misma cuenta
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tsr_mov_cuenta_ref_bancaria
      ON tesoreria_movimientos(cuenta_id, referencia_bancaria)
      WHERE referencia_bancaria IS NOT NULL;

    -- Actualizar el check de origen para incluir 'extracto'
    ALTER TABLE tesoreria_movimientos
      DROP CONSTRAINT IF EXISTS tesoreria_movimientos_origen_check;

    ALTER TABLE tesoreria_movimientos
      ADD CONSTRAINT tesoreria_movimientos_origen_check
      CHECK (origen IN ('manual', 'extracto'));

    -- Log de cada importación
    CREATE TABLE tesoreria_extractos (
      id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
      cuenta_id       UUID          NOT NULL REFERENCES tesoreria_cuentas(id) ON DELETE RESTRICT,
      fecha_desde     DATE          NOT NULL,
      fecha_hasta     DATE          NOT NULL,
      total_filas     INTEGER       NOT NULL DEFAULT 0,
      importadas      INTEGER       NOT NULL DEFAULT 0,
      omitidas        INTEGER       NOT NULL DEFAULT 0,
      nombre_archivo  VARCHAR(200),
      importado_por   UUID          REFERENCES global_usuarios(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS tesoreria_extractos CASCADE;

    ALTER TABLE tesoreria_movimientos
      DROP CONSTRAINT IF EXISTS tesoreria_movimientos_origen_check;

    ALTER TABLE tesoreria_movimientos
      ADD CONSTRAINT tesoreria_movimientos_origen_check
      CHECK (origen IN ('manual', 'pdf'));

    DROP INDEX IF EXISTS uq_tsr_mov_cuenta_ref_bancaria;

    ALTER TABLE tesoreria_movimientos
      DROP COLUMN IF EXISTS referencia_bancaria,
      DROP COLUMN IF EXISTS tipo_bancario,
      DROP COLUMN IF EXISTS oficina_bancaria,
      DROP COLUMN IF EXISTS detalles_banco;
  `);
};
