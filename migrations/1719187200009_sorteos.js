export const up = (pgm) => {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

    -- Sorteos
    CREATE TABLE sorteos (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      nombre      VARCHAR(100) NOT NULL,
      descripcion TEXT,
      estado      VARCHAR(20) NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','pausado')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Empresas habilitadas por sorteo
    CREATE TABLE sorteo_empresas (
      sorteo_id      UUID        NOT NULL REFERENCES sorteos(id) ON DELETE CASCADE,
      empresa_codigo VARCHAR(50) NOT NULL REFERENCES empresas(codigo) ON DELETE CASCADE,
      PRIMARY KEY (sorteo_id, empresa_codigo)
    );

    -- Boletos 000-999 por sorteo
    CREATE TABLE boletos (
      numero           INTEGER     NOT NULL CHECK (numero BETWEEN 0 AND 999),
      sorteo_id        UUID        NOT NULL REFERENCES sorteos(id) ON DELETE CASCADE,
      asociado_codigo  VARCHAR(20) REFERENCES asociados(codigo) ON DELETE SET NULL,
      estado           VARCHAR(30) NOT NULL DEFAULT 'libre'
                         CHECK (estado IN ('libre','pendiente_adquisicion','asignado','pendiente_retiro')),
      fecha_asignacion TIMESTAMPTZ,
      PRIMARY KEY (numero, sorteo_id)
    );

    -- Solicitudes del portal de asociados
    CREATE TABLE solicitudes_bono (
      id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
      sorteo_id        UUID        NOT NULL REFERENCES sorteos(id) ON DELETE CASCADE,
      numero           INTEGER     NOT NULL CHECK (numero BETWEEN 0 AND 999),
      asociado_codigo  VARCHAR(20) NOT NULL REFERENCES asociados(codigo) ON DELETE CASCADE,
      tipo             VARCHAR(20) NOT NULL CHECK (tipo IN ('adquisicion','retiro')),
      estado           VARCHAR(20) NOT NULL DEFAULT 'pendiente'
                         CHECK (estado IN ('pendiente','aprobada','rechazada','cancelada')),
      empleado_uuid    UUID        REFERENCES global_usuarios(id) ON DELETE SET NULL,
      notas            TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Auditoría de todas las acciones sobre boletos
    CREATE TABLE sorteo_logs (
      id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
      sorteo_id        UUID        REFERENCES sorteos(id) ON DELETE SET NULL,
      numero           INTEGER,
      accion           VARCHAR(40) NOT NULL CHECK (accion IN (
                         'COMPRA_DIRECTA','ANULACION_DIRECTA',
                         'SOLICITUD_ADQUISICION','APROBACION','RECHAZO',
                         'CANCELACION_ASOCIADO',
                         'SOLICITUD_RETIRO','APROBACION_RETIRO','RECHAZO_RETIRO',
                         'LIBERACION_POR_RETIRO_CSV'
                       )),
      asociado_codigo  VARCHAR(20),
      empleado_uuid    UUID        REFERENCES global_usuarios(id) ON DELETE SET NULL,
      detalle          TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Ganadores oficiales
    CREATE TABLE sorteo_ganadores (
      id                      UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
      sorteo_id               UUID        NOT NULL REFERENCES sorteos(id) ON DELETE CASCADE,
      numero                  INTEGER     NOT NULL,
      asociado_codigo         VARCHAR(20),
      nombre_completo         VARCHAR(200),
      empresa_en_ese_momento  VARCHAR(200),
      fecha_premiacion        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_boletos_sorteo    ON boletos(sorteo_id);
    CREATE INDEX idx_boletos_asociado  ON boletos(asociado_codigo);
    CREATE INDEX idx_solicitudes_estado ON solicitudes_bono(estado);
    CREATE INDEX idx_sorteo_logs_sorteo ON sorteo_logs(sorteo_id);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS sorteo_ganadores  CASCADE;
    DROP TABLE IF EXISTS sorteo_logs       CASCADE;
    DROP TABLE IF EXISTS solicitudes_bono  CASCADE;
    DROP TABLE IF EXISTS boletos           CASCADE;
    DROP TABLE IF EXISTS sorteo_empresas   CASCADE;
    DROP TABLE IF EXISTS sorteos           CASCADE;
  `);
};
