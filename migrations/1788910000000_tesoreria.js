export const up = (pgm) => {
  pgm.sql(`
    -- Cuentas: banco, caja menor, tarjeta de crédito
    CREATE TABLE tesoreria_cuentas (
      id            UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
      nombre        VARCHAR(100)  NOT NULL,
      tipo          VARCHAR(10)   NOT NULL CHECK (tipo IN ('banco', 'caja', 'tarjeta')),
      entidad       VARCHAR(100),
      numero        VARCHAR(50),
      saldo_inicial NUMERIC(14,2) NOT NULL DEFAULT 0,
      moneda        VARCHAR(3)    NOT NULL DEFAULT 'COP',
      is_active     BOOLEAN       NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );

    -- Categorías de movimientos
    CREATE TABLE tesoreria_categorias (
      id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
      nombre      VARCHAR(80) NOT NULL UNIQUE,
      tipo        VARCHAR(8)  NOT NULL CHECK (tipo IN ('ingreso', 'egreso', 'traslado')),
      color       VARCHAR(7)  NOT NULL DEFAULT '#64748b',
      is_active   BOOLEAN     NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Períodos contables (cierre explícito)
    CREATE TABLE tesoreria_periodos (
      id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
      nombre       VARCHAR(50) NOT NULL,
      fecha_inicio DATE        NOT NULL,
      fecha_fin    DATE        NOT NULL,
      estado       VARCHAR(10) NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto', 'cerrado')),
      cerrado_por  UUID        REFERENCES global_usuarios(id) ON DELETE SET NULL,
      cerrado_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT periodos_fechas_check CHECK (fecha_fin >= fecha_inicio)
    );

    -- Movimientos de tesorería (inmutables al cerrar período)
    CREATE TABLE tesoreria_movimientos (
      id                   UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
      tipo                 VARCHAR(10)   NOT NULL CHECK (tipo IN ('ingreso', 'egreso', 'traslado')),
      monto                NUMERIC(14,2) NOT NULL CHECK (monto > 0),
      fecha                DATE          NOT NULL,
      descripcion          TEXT,
      referencia           VARCHAR(100),
      cuenta_id            UUID          NOT NULL REFERENCES tesoreria_cuentas(id) ON DELETE RESTRICT,
      cuenta_destino_id    UUID          REFERENCES tesoreria_cuentas(id) ON DELETE RESTRICT,
      categoria_id         UUID          REFERENCES tesoreria_categorias(id) ON DELETE SET NULL,
      periodo_id           UUID          REFERENCES tesoreria_periodos(id) ON DELETE RESTRICT,
      registrado_por       UUID          REFERENCES global_usuarios(id) ON DELETE SET NULL,
      corrige_movimiento_id UUID         REFERENCES tesoreria_movimientos(id) ON DELETE SET NULL,
      origen               VARCHAR(20)   NOT NULL DEFAULT 'manual' CHECK (origen IN ('manual', 'pdf')),
      created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_tsr_mov_cuenta    ON tesoreria_movimientos(cuenta_id);
    CREATE INDEX idx_tsr_mov_periodo   ON tesoreria_movimientos(periodo_id);
    CREATE INDEX idx_tsr_mov_fecha     ON tesoreria_movimientos(fecha);
    CREATE INDEX idx_tsr_mov_tipo      ON tesoreria_movimientos(tipo);

    -- Módulo y permisos
    INSERT INTO modulos (nombre, descripcion)
      VALUES ('tesoreria', 'Gestión de cuentas, movimientos y flujo de caja')
      ON CONFLICT (nombre) DO NOTHING;

    INSERT INTO acciones (nombre) VALUES ('READ')   ON CONFLICT DO NOTHING;
    INSERT INTO acciones (nombre) VALUES ('WRITE')  ON CONFLICT DO NOTHING;
    INSERT INTO acciones (nombre) VALUES ('DELETE') ON CONFLICT DO NOTHING;

    -- Categorías base
    INSERT INTO tesoreria_categorias (nombre, tipo, color) VALUES
      ('Aportes asociados',       'ingreso',  '#22c55e'),
      ('Cuotas de crédito',       'ingreso',  '#16a34a'),
      ('Intereses de crédito',    'ingreso',  '#15803d'),
      ('Bonos / sorteos',         'ingreso',  '#4ade80'),
      ('Otros ingresos',          'ingreso',  '#86efac'),
      ('Pago a proveedor',        'egreso',   '#ef4444'),
      ('Nómina y prestaciones',   'egreso',   '#dc2626'),
      ('Servicios públicos',      'egreso',   '#b91c1c'),
      ('Desembolso de crédito',   'egreso',   '#f97316'),
      ('Gastos administrativos',  'egreso',   '#fb923c'),
      ('Retiro de aportes',       'egreso',   '#fbbf24'),
      ('Otros egresos',           'egreso',   '#a78bfa'),
      ('Traslado entre cuentas',  'traslado', '#38bdf8');
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS tesoreria_movimientos CASCADE;
    DROP TABLE IF EXISTS tesoreria_periodos    CASCADE;
    DROP TABLE IF EXISTS tesoreria_categorias  CASCADE;
    DROP TABLE IF EXISTS tesoreria_cuentas     CASCADE;
    DELETE FROM modulos WHERE nombre = 'tesoreria';
  `);
};
