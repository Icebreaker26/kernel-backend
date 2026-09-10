export const up = (pgm) => {
  pgm.sql(`
    -- Columnas de datos bancarios activos (verificados por CI) en el proveedor
    ALTER TABLE tesoreria_proveedores
      ADD COLUMN IF NOT EXISTS banco             VARCHAR(80),
      ADD COLUMN IF NOT EXISTS tipo_cuenta       VARCHAR(12) CHECK (tipo_cuenta IN ('ahorros', 'corriente')),
      ADD COLUMN IF NOT EXISTS numero_cuenta     VARCHAR(30),
      ADD COLUMN IF NOT EXISTS titular_cuenta    VARCHAR(150),
      ADD COLUMN IF NOT EXISTS datos_bancarios_estado VARCHAR(20) NOT NULL DEFAULT 'sin_datos'
        CHECK (datos_bancarios_estado IN ('sin_datos', 'pendiente_ci', 'verificado', 'rechazado'));

    -- Historial de solicitudes de datos bancarios
    CREATE TABLE IF NOT EXISTS tesoreria_proveedores_datos_bancarios (
      id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
      proveedor_id    UUID         NOT NULL REFERENCES tesoreria_proveedores(id) ON DELETE CASCADE,
      banco           VARCHAR(80)  NOT NULL,
      tipo_cuenta     VARCHAR(12)  NOT NULL CHECK (tipo_cuenta IN ('ahorros', 'corriente')),
      numero_cuenta   VARCHAR(30)  NOT NULL,
      titular_cuenta  VARCHAR(150) NOT NULL,
      estado          VARCHAR(20)  NOT NULL DEFAULT 'pendiente_ci'
        CHECK (estado IN ('pendiente_ci', 'verificado', 'rechazado')),
      motivo_rechazo  TEXT,
      solicitado_por  UUID REFERENCES global_usuarios(id),
      verificado_por  UUID REFERENCES global_usuarios(id),
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      verificado_at   TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_datos_bancarios_proveedor ON tesoreria_proveedores_datos_bancarios(proveedor_id);
    CREATE INDEX IF NOT EXISTS idx_datos_bancarios_estado    ON tesoreria_proveedores_datos_bancarios(estado);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS tesoreria_proveedores_datos_bancarios;
    ALTER TABLE tesoreria_proveedores
      DROP COLUMN IF EXISTS banco,
      DROP COLUMN IF EXISTS tipo_cuenta,
      DROP COLUMN IF EXISTS numero_cuenta,
      DROP COLUMN IF EXISTS titular_cuenta,
      DROP COLUMN IF EXISTS datos_bancarios_estado;
  `);
};
