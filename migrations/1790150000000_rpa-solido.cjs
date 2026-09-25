/* eslint-disable camelcase */
// Módulo rpa: carga de asociados a SOLIDO por interfaz (un agente en el PC de SOLIDO consulta esta cola).
//
//  - global_usuarios.cedula      cédula del empleado; SOLIDO la pide como "Asesor" de cada asociado.
//  - rpa_agentes                 un agente = un PC con SOLIDO. Se autentica con un token propio (solo se guarda su hash).
//                                `permite_guardar` es el interruptor del lado del servidor: mientras esté en false el agente
//                                solo llena en seco (sin pulsar Guardar en SOLIDO).
//  - rpa_equivalencias           texto de Kernel → código de SOLIDO (ciudad, profesión, cargo, empresa…).
//  - rpa_jobs                    un job por asociado. El payload NO se guarda: se arma al reclamarlo con los datos y las
//                                equivalencias vigentes. Una vinculación solo puede tener un job abierto a la vez.
//  - rpa_capturas                pantallazos que sube el agente (llevan datos personales: se purgan a los 30 días).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE global_usuarios ADD COLUMN cedula VARCHAR(20);
    CREATE UNIQUE INDEX uq_global_usuarios_cedula ON global_usuarios(cedula) WHERE cedula IS NOT NULL;

    ALTER TABLE captacion_vinculaciones
      ADD COLUMN solido_estado     VARCHAR(20),
      ADD COLUMN solido_cargado_at TIMESTAMPTZ;

    CREATE TABLE rpa_agentes (
      id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      nombre          VARCHAR(80) NOT NULL UNIQUE,
      token_hash      VARCHAR(64) NOT NULL UNIQUE,
      pausado         BOOLEAN     NOT NULL DEFAULT false,
      permite_guardar BOOLEAN     NOT NULL DEFAULT false,
      ultimo_latido   TIMESTAMPTZ,
      version         VARCHAR(30),
      huella_ui       VARCHAR(64),
      is_active       BOOLEAN     NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE rpa_equivalencias (
      id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      catalogo       VARCHAR(30)  NOT NULL,
      texto_norm     VARCHAR(200) NOT NULL,
      texto_original VARCHAR(200),
      codigo_solido  VARCHAR(30)  NOT NULL,
      descripcion    VARCHAR(200),
      creado_por     UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      is_active      BOOLEAN     NOT NULL DEFAULT true,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT rpa_equivalencias_uq UNIQUE (catalogo, texto_norm)
    );

    CREATE TABLE rpa_jobs (
      id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tipo                VARCHAR(30) NOT NULL DEFAULT 'cargar_asociado',
      vinculacion_id      UUID NOT NULL REFERENCES captacion_vinculaciones(id) ON DELETE RESTRICT,
      cedula              VARCHAR(20) NOT NULL,
      estado              VARCHAR(30) NOT NULL DEFAULT 'pendiente'
        CHECK (estado IN ('requiere_datos','pendiente','llenando','listo_para_aprobar','aprobado','guardando',
                          'cargado','ya_existe','revision_humana','fallido','cancelado')),
      faltantes           JSONB,
      agente_id           UUID REFERENCES rpa_agentes(id) ON DELETE SET NULL,
      intentos            SMALLINT    NOT NULL DEFAULT 0,
      resultado           JSONB,
      error               TEXT,
      aprobado_por        UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      aprobado_at         TIMESTAMPTZ,
      guardar_iniciado_at TIMESTAMPTZ,
      creado_por          UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      terminado_at        TIMESTAMPTZ,
      is_active           BOOLEAN     NOT NULL DEFAULT true,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Un solo job abierto por vinculación: evita cargar dos veces al mismo asociado
    CREATE UNIQUE INDEX uq_rpa_jobs_abierto ON rpa_jobs(vinculacion_id)
      WHERE estado IN ('requiere_datos','pendiente','llenando','listo_para_aprobar','aprobado','guardando','revision_humana');
    CREATE INDEX idx_rpa_jobs_estado ON rpa_jobs(estado);
    CREATE INDEX idx_rpa_jobs_cedula ON rpa_jobs(cedula);

    CREATE TABLE rpa_capturas (
      id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      job_id     UUID        NOT NULL REFERENCES rpa_jobs(id) ON DELETE CASCADE,
      etiqueta   VARCHAR(60) NOT NULL,
      mime       VARCHAR(30) NOT NULL DEFAULT 'image/jpeg',
      datos      BYTEA       NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_rpa_capturas_job ON rpa_capturas(job_id);
  `);

  pgm.sql(`
    INSERT INTO modulos (nombre, descripcion) VALUES ('rpa', 'Carga automática de asociados a SOLIDO') ON CONFLICT DO NOTHING;
    INSERT INTO acciones (nombre) VALUES ('READ')    ON CONFLICT DO NOTHING;
    INSERT INTO acciones (nombre) VALUES ('WRITE')   ON CONFLICT DO NOTHING;
    INSERT INTO acciones (nombre) VALUES ('APROBAR') ON CONFLICT DO NOTHING;
    INSERT INTO acciones (nombre) VALUES ('ADMIN')   ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS rpa_capturas     CASCADE;
    DROP TABLE IF EXISTS rpa_jobs         CASCADE;
    DROP TABLE IF EXISTS rpa_equivalencias CASCADE;
    DROP TABLE IF EXISTS rpa_agentes      CASCADE;
    ALTER TABLE captacion_vinculaciones DROP COLUMN IF EXISTS solido_estado, DROP COLUMN IF EXISTS solido_cargado_at;
    DROP INDEX IF EXISTS uq_global_usuarios_cedula;
    ALTER TABLE global_usuarios DROP COLUMN IF EXISTS cedula;
    DELETE FROM modulos WHERE nombre = 'rpa';
  `);
};
