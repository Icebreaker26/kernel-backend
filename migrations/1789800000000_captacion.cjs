/* eslint-disable camelcase */
exports.up = (pgm) => {
  // ── Tablas principales ────────────────────────────────────────────────────

  pgm.sql(`
    CREATE TABLE captacion_prospectos (
      id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      empresa_codigo   VARCHAR(50) NOT NULL REFERENCES empresas(codigo) ON DELETE RESTRICT,
      asesor_uuid      UUID        NOT NULL REFERENCES global_usuarios(id) ON DELETE RESTRICT,

      nombres          VARCHAR(100) NOT NULL,
      apellidos        VARCHAR(100) NOT NULL,
      cedula           VARCHAR(20)  NOT NULL,
      celular          VARCHAR(20)  NOT NULL,
      correo           VARCHAR(150),

      token_hash       VARCHAR(64)  UNIQUE NOT NULL,
      token_expira_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '30 days',

      ping_count       INT          NOT NULL DEFAULT 0,
      ping_at          TIMESTAMPTZ,

      estado           VARCHAR(30)  NOT NULL DEFAULT 'nuevo',

      convertido_at       TIMESTAMPTZ,
      sincronizacion_id   UUID REFERENCES sincronizaciones(id) ON DELETE SET NULL,

      is_active        BOOLEAN      NOT NULL DEFAULT true,
      created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_captacion_prospectos_asesor  ON captacion_prospectos(asesor_uuid);
    CREATE INDEX idx_captacion_prospectos_cedula  ON captacion_prospectos(cedula);
    CREATE INDEX idx_captacion_prospectos_empresa ON captacion_prospectos(empresa_codigo);
    CREATE INDEX idx_captacion_prospectos_estado  ON captacion_prospectos(estado);

    CREATE TABLE captacion_toques (
      id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      prospecto_id  UUID        NOT NULL REFERENCES captacion_prospectos(id) ON DELETE CASCADE,
      asesor_uuid   UUID        NOT NULL REFERENCES global_usuarios(id) ON DELETE RESTRICT,
      resultado     VARCHAR(30) NOT NULL,
      notas         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE captacion_vinculaciones (
      id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      prospecto_id  UUID        NOT NULL REFERENCES captacion_prospectos(id) ON DELETE RESTRICT,
      estado        VARCHAR(30) NOT NULL DEFAULT 'borrador',

      -- Sección 2: información personal
      tipo_documento          VARCHAR(5),
      ciudad_expedicion       VARCHAR(100),
      fecha_expedicion        DATE,
      fecha_nacimiento        DATE,
      ciudad_nacimiento       VARCHAR(100),
      departamento_nacimiento VARCHAR(100),
      direccion_residencia    TEXT,
      ciudad_residencia       VARCHAR(100),
      departamento_residencia VARCHAR(100),
      telefono_fijo           VARCHAR(20),
      genero                  CHAR(1),
      nivel_academico         VARCHAR(80),
      profesion               VARCHAR(100),
      estado_civil            VARCHAR(20),
      tipo_vivienda           VARCHAR(20),
      estrato                 SMALLINT,
      cabeza_de_hogar         BOOLEAN,
      personas_a_cargo        SMALLINT,
      instruccion_cooperativa BOOLEAN,
      declarante_de_renta     BOOLEAN,
      conyuge_nombre          VARCHAR(200),
      conyuge_cedula          VARCHAR(20),
      conyuge_fecha_nacimiento DATE,
      conyuge_actividad       VARCHAR(100),

      -- Sección 3: información laboral
      cargo                   VARCHAR(100),
      fecha_ingreso           DATE,
      tipo_contrato           VARCHAR(30),
      direccion_trabajo       TEXT,
      telefono_trabajo        VARCHAR(20),
      ciudad_trabajo          VARCHAR(100),
      departamento_trabajo    VARCHAR(100),
      maneja_recursos_publicos BOOLEAN,
      maneja_recursos_desc    TEXT,

      -- Sección 4: PEP / SARLAFT
      pep_maneja_recursos_publicos BOOLEAN,
      pep_reconocimiento_publico   BOOLEAN,
      pep_poder_publico            BOOLEAN,
      pep_vinculo_expuesto         BOOLEAN,
      debida_diligencia_ampliada   BOOLEAN NOT NULL DEFAULT false,

      -- Sección 5: situación financiera
      actividad_financiera     VARCHAR(100),
      ciiu                     VARCHAR(10),
      ingresos_mensuales       NUMERIC(14,2),
      egresos_mensuales        NUMERIC(14,2),
      otros_ingresos           NUMERIC(14,2),
      otros_ingresos_desc      VARCHAR(200),
      total_activos            NUMERIC(14,2),
      total_pasivos            NUMERIC(14,2),
      origen_fondos            TEXT,
      moneda_extranjera        BOOLEAN DEFAULT false,
      moneda_extranjera_detalle JSONB,

      -- Valores (asesor)
      valor_aporte             NUMERIC(14,2),
      cuota_admision           NUMERIC(14,2),

      -- Documentos
      cedula_frente_id  UUID REFERENCES archivos(id) ON DELETE SET NULL,
      cedula_reverso_id UUID REFERENCES archivos(id) ON DELETE SET NULL,

      -- Firma digital
      firma_png               TEXT,
      firma_trazos            JSONB,
      firma_at                TIMESTAMPTZ,
      firma_ip                VARCHAR(45),
      firma_user_agent        TEXT,
      firma_doc_hash          VARCHAR(64),
      version_consentimiento  VARCHAR(20),

      -- Snapshot inmutable al momento de firmar
      formulario_snapshot     JSONB,

      -- Checklist de secciones (quién + cuándo)
      seccion_personal_at          TIMESTAMPTZ,
      seccion_personal_autor       VARCHAR(20),
      seccion_laboral_at           TIMESTAMPTZ,
      seccion_laboral_autor        VARCHAR(20),
      seccion_pep_at               TIMESTAMPTZ,
      seccion_pep_autor            VARCHAR(20),
      seccion_financiera_at        TIMESTAMPTZ,
      seccion_financiera_autor     VARCHAR(20),
      seccion_beneficiarios_at     TIMESTAMPTZ,
      seccion_referencias_at       TIMESTAMPTZ,
      seccion_documentos_at        TIMESTAMPTZ,
      seccion_documentos_autor     VARCHAR(20),
      seccion_firma_at             TIMESTAMPTZ,

      -- Entrega
      entregada_at    TIMESTAMPTZ,
      entregada_por   UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,

      is_active   BOOLEAN     NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_captacion_vinc_prospecto ON captacion_vinculaciones(prospecto_id);
    CREATE INDEX idx_captacion_vinc_estado    ON captacion_vinculaciones(estado);

    CREATE TABLE captacion_beneficiarios (
      id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      vinculacion_id  UUID     NOT NULL REFERENCES captacion_vinculaciones(id) ON DELETE CASCADE,
      orden           SMALLINT NOT NULL,
      identificacion  VARCHAR(20),
      nombres         VARCHAR(200),
      porcentaje      NUMERIC(5,2),
      fecha_nacimiento DATE,
      parentesco      VARCHAR(50),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE captacion_referencias (
      id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      vinculacion_id UUID        NOT NULL REFERENCES captacion_vinculaciones(id) ON DELETE CASCADE,
      tipo           VARCHAR(20) NOT NULL,
      nombres        VARCHAR(200),
      telefono_fijo  VARCHAR(20),
      celular        VARCHAR(20),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE captacion_eventos (
      id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      prospecto_id   UUID        NOT NULL REFERENCES captacion_prospectos(id) ON DELETE CASCADE,
      vinculacion_id UUID        REFERENCES captacion_vinculaciones(id) ON DELETE CASCADE,
      tipo           VARCHAR(50) NOT NULL,
      seccion        VARCHAR(30),
      autor_tipo     VARCHAR(20),
      autor_uuid     UUID,
      ip             VARCHAR(45),
      user_agent     TEXT,
      payload        JSONB,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_captacion_eventos_prospecto ON captacion_eventos(prospecto_id);
  `);

  // ── ACL ───────────────────────────────────────────────────────────────────
  pgm.sql(`
    INSERT INTO modulos (nombre, descripcion)
      VALUES ('captacion', 'Captación de asociados')
      ON CONFLICT DO NOTHING;

    INSERT INTO acciones (nombre)
      VALUES ('ENTREGAR')
      ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS captacion_eventos      CASCADE;
    DROP TABLE IF EXISTS captacion_referencias  CASCADE;
    DROP TABLE IF EXISTS captacion_beneficiarios CASCADE;
    DROP TABLE IF EXISTS captacion_vinculaciones CASCADE;
    DROP TABLE IF EXISTS captacion_toques       CASCADE;
    DROP TABLE IF EXISTS captacion_prospectos   CASCADE;
    DELETE FROM modulos WHERE nombre = 'captacion';
  `);
};
