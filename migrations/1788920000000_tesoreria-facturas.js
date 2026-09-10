export const up = (pgm) => {
  pgm.sql(`
    -- Catálogo de proveedores / acreedores
    CREATE TABLE tesoreria_proveedores (
      id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
      nombre      VARCHAR(150) NOT NULL,
      nit         VARCHAR(20),
      email       VARCHAR(150),
      telefono    VARCHAR(30),
      tipo_pago   VARCHAR(12)  NOT NULL CHECK (tipo_pago IN ('recurrente', 'unico')),
      frecuencia  VARCHAR(12)  CHECK (frecuencia IN ('mensual', 'bimestral', 'trimestral', 'semestral', 'anual')),
      categoria   VARCHAR(80),
      notas       TEXT,
      is_active   BOOLEAN      NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      CONSTRAINT prov_frecuencia_check CHECK (
        (tipo_pago = 'recurrente' AND frecuencia IS NOT NULL) OR
        (tipo_pago = 'unico'      AND frecuencia IS NULL)
      )
    );

    CREATE INDEX idx_tsr_prov_tipo ON tesoreria_proveedores(tipo_pago);

    -- Facturas recibidas pendientes de aprobación y pago
    CREATE TABLE tesoreria_facturas (
      id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
      proveedor_id    UUID          NOT NULL REFERENCES tesoreria_proveedores(id) ON DELETE RESTRICT,
      monto           NUMERIC(14,2) NOT NULL CHECK (monto > 0),
      fecha_recibida  DATE          NOT NULL DEFAULT CURRENT_DATE,
      fecha_vencimiento DATE        NOT NULL,
      descripcion     TEXT,
      soporte         VARCHAR(255),
      estado          VARCHAR(22)   NOT NULL DEFAULT 'pendiente_aprobacion'
                        CHECK (estado IN ('pendiente_aprobacion', 'aprobada', 'pagada', 'rechazada')),
      cuenta_pago_id  UUID          REFERENCES tesoreria_cuentas(id) ON DELETE SET NULL,
      movimiento_id   UUID          REFERENCES tesoreria_movimientos(id) ON DELETE SET NULL,
      aprobado_por    UUID          REFERENCES global_usuarios(id) ON DELETE SET NULL,
      aprobado_at     TIMESTAMPTZ,
      rechazo_motivo  TEXT,
      registrado_por  UUID          REFERENCES global_usuarios(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_tsr_fact_proveedor ON tesoreria_facturas(proveedor_id);
    CREATE INDEX idx_tsr_fact_estado    ON tesoreria_facturas(estado);
    CREATE INDEX idx_tsr_fact_venc      ON tesoreria_facturas(fecha_vencimiento);

    -- Módulo control_interno
    INSERT INTO modulos (nombre, descripcion)
      VALUES ('control_interno', 'Aprobación de facturas y control de pagos')
      ON CONFLICT (nombre) DO NOTHING;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS tesoreria_facturas   CASCADE;
    DROP TABLE IF EXISTS tesoreria_proveedores CASCADE;
    DELETE FROM modulos WHERE nombre = 'control_interno';
  `);
};
