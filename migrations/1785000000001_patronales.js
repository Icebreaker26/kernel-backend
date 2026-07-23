export const up = (pgm) => {
  pgm.sql(`
    -- Historial de cambios de valor_aporte por asociado
    CREATE TABLE asociados_aporte_historial (
      id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
      asociado_codigo  VARCHAR(20) NOT NULL REFERENCES asociados(codigo) ON DELETE CASCADE,
      valor_anterior   NUMERIC(10,2),
      valor_nuevo      NUMERIC(10,2) NOT NULL,
      origen           VARCHAR(10)  NOT NULL CHECK (origen IN ('flexible', 'admin')),
      motivo           TEXT,
      soporte          VARCHAR(255),
      usuario_uuid     UUID        REFERENCES global_usuarios(id) ON DELETE SET NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_aporte_hist_asociado ON asociados_aporte_historial(asociado_codigo);

    -- Configuración de facturación por empresa
    CREATE TABLE patronales_config_empresa (
      empresa_codigo    VARCHAR(50) PRIMARY KEY REFERENCES empresas(codigo) ON DELETE CASCADE,
      facturacion       VARCHAR(10) NOT NULL DEFAULT 'unica'
                          CHECK (facturacion IN ('unica', 'separada')),
      dias_vencimiento  INTEGER     NOT NULL DEFAULT 30,
      email_contacto    VARCHAR(200),
      activa            BOOLEAN     NOT NULL DEFAULT true,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Facturas (cuentas de cobro) por empresa por período
    CREATE TABLE patronales_facturas (
      id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
      empresa_codigo   VARCHAR(50) NOT NULL REFERENCES empresas(codigo) ON DELETE RESTRICT,
      periodo          VARCHAR(7)  NOT NULL,
      tipo_cuota       VARCHAR(10) NOT NULL CHECK (tipo_cuota IN ('mensual', 'quincenal', 'mixta')),
      monto_total      NUMERIC(12,2) NOT NULL,
      estado           VARCHAR(15) NOT NULL DEFAULT 'pendiente'
                         CHECK (estado IN ('pendiente', 'pago_parcial', 'vencida', 'pagada', 'anulada')),
      fecha_emision    DATE        NOT NULL DEFAULT CURRENT_DATE,
      fecha_vencimiento DATE       NOT NULL,
      anulada_motivo   TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (empresa_codigo, periodo, tipo_cuota)
    );

    CREATE INDEX idx_pat_facturas_empresa  ON patronales_facturas(empresa_codigo);
    CREATE INDEX idx_pat_facturas_periodo  ON patronales_facturas(periodo);
    CREATE INDEX idx_pat_facturas_estado   ON patronales_facturas(estado);

    -- Detalle (líneas) de cada factura — snapshot en el momento de causar
    CREATE TABLE patronales_detalle (
      id                      UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
      factura_id              UUID        NOT NULL REFERENCES patronales_facturas(id) ON DELETE CASCADE,
      asociado_codigo         VARCHAR(20) NOT NULL,
      nombre_snapshot         VARCHAR(200) NOT NULL,
      clase_cuota_snapshot    VARCHAR(2)  NOT NULL,
      valor_aporte_snapshot   NUMERIC(10,2) NOT NULL
    );

    CREATE INDEX idx_pat_detalle_factura ON patronales_detalle(factura_id);

    -- Pagos registrados contra una factura (permite parciales)
    CREATE TABLE patronales_pagos (
      id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
      factura_id      UUID        NOT NULL REFERENCES patronales_facturas(id) ON DELETE RESTRICT,
      fecha_pago      DATE        NOT NULL,
      monto           NUMERIC(12,2) NOT NULL CHECK (monto > 0),
      referencia      VARCHAR(255),
      registrado_por  UUID        REFERENCES global_usuarios(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_pat_pagos_factura ON patronales_pagos(factura_id);

    -- Auditoría de acciones sobre el módulo
    CREATE TABLE patronales_logs (
      id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
      accion       VARCHAR(30) NOT NULL
                     CHECK (accion IN ('causar', 'pagar', 'anular', 'config_empresa', 'activar_portal')),
      entidad_id   UUID,
      usuario_uuid UUID        REFERENCES global_usuarios(id) ON DELETE SET NULL,
      detalle      JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_pat_logs_accion ON patronales_logs(accion);

    -- Acceso al portal de empresas
    CREATE TABLE empresas_portal_acceso (
      empresa_codigo  VARCHAR(50) PRIMARY KEY REFERENCES empresas(codigo) ON DELETE CASCADE,
      email           VARCHAR(200) UNIQUE NOT NULL,
      password_hash   TEXT,
      portal_activo   BOOLEAN     NOT NULL DEFAULT false,
      primer_login    BOOLEAN     NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS empresas_portal_acceso     CASCADE;
    DROP TABLE IF EXISTS patronales_logs            CASCADE;
    DROP TABLE IF EXISTS patronales_pagos           CASCADE;
    DROP TABLE IF EXISTS patronales_detalle         CASCADE;
    DROP TABLE IF EXISTS patronales_facturas        CASCADE;
    DROP TABLE IF EXISTS patronales_config_empresa  CASCADE;
    DROP TABLE IF EXISTS asociados_aporte_historial CASCADE;
  `);
};
