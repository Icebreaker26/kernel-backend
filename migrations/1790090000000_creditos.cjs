/* eslint-disable camelcase */
// Módulo Créditos (solicitud → firma → autorización de la empresa → entrega a Cartera) y bandeja de Cartera.
//
// Diseño:
//  - Firma y autorización de la empresa son pistas INDEPENDIENTES y en orden variable; no hay un estado lineal. El estado guardado
//    (`estado`) solo cambia por decisiones humanas; "listo para Cartera" se DERIVA en la vista v_credito_pistas (única fuente de la regla).
//  - Los documentos a firmar son los que el asesor sube como 'a_firmar'; la firma está completa cuando cada uno tiene su 'firmado' vigente.
//  - La autorización se guarda por rondas (la empresa puede rechazar y volver a pedirse); la que decide es la última.
//  - credito_eventos es la línea de tiempo: solo se agrega, nunca se modifica ni se borra.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE email_cola ADD COLUMN reply_to VARCHAR(254);

    CREATE SEQUENCE credito_radicado_seq;

    CREATE TABLE credito_categorias (
      id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      codigo     VARCHAR(30) NOT NULL UNIQUE,
      nombre     VARCHAR(80) NOT NULL,
      linea_id   INTEGER,          -- línea del catálogo del CSV de descuentos (para conciliar el crédito desembolsado)
      orden      INTEGER NOT NULL DEFAULT 0,
      is_active  BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO credito_categorias (codigo, nombre, linea_id, orden) VALUES
      ('libre_inversion', 'Libre inversión',   1006, 1),
      ('caja_rapida',     'Caja rápida',       1015, 2),
      ('paga_facil',      'Paga fácil',        1036, 3),
      ('calamidad',       'Calamidad',         1008, 4),
      ('educacion',       'Educación',         1028, 5),
      ('vehiculo',        'Vehículo',          1009, 6),
      ('vivienda',        'Vivienda',          1010, 7),
      ('fidelizacion',    'Fidelización',      1029, 8),
      ('refinanciacion',  'Refinanciación',    1016, 9),
      ('otro',            'Otro',              NULL, 99);

    -- Política de cada empresa. Sin fila = por defecto pide autorización, momento indiferente (lo más seguro).
    --   antes_firma / indiferente: el correo sale al radicar. despues_firma: sale cuando la firma queda completa.
    CREATE TABLE credito_config_empresa (
      empresa_codigo        VARCHAR(60) PRIMARY KEY REFERENCES empresas(codigo) ON DELETE CASCADE,
      requiere_autorizacion BOOLEAN NOT NULL DEFAULT true,
      momento_autorizacion  VARCHAR(20) NOT NULL DEFAULT 'indiferente'
                            CHECK (momento_autorizacion IN ('antes_firma', 'despues_firma', 'indiferente')),
      emails_autorizacion   TEXT[] NOT NULL DEFAULT '{}',
      updated_by            UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE credito_solicitudes (
      id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      radicado              VARCHAR(20) NOT NULL UNIQUE,
      clave_idempotencia    UUID UNIQUE,            -- evita duplicar la solicitud si se envía dos veces
      asociado_codigo       VARCHAR(20) NOT NULL REFERENCES asociados(codigo) ON DELETE RESTRICT,
      empresa_codigo        VARCHAR(60) NOT NULL REFERENCES empresas(codigo) ON DELETE RESTRICT,   -- copia de la empresa al radicar
      categoria_id          UUID NOT NULL REFERENCES credito_categorias(id),
      asesor_uuid           UUID NOT NULL REFERENCES global_usuarios(id),
      canal_origen          VARCHAR(12) NOT NULL CHECK (canal_origen IN ('whatsapp', 'presencial')),
      valor_solicitado      NUMERIC(14,2) NOT NULL CHECK (valor_solicitado > 0),
      monto_desembolso      NUMERIC(14,2) NOT NULL CHECK (monto_desembolso > 0),
      motivo_diferencia     TEXT,
      cuotas                INTEGER CHECK (cuotas IS NULL OR cuotas > 0),
      cuota_mensual         NUMERIC(14,2) CHECK (cuota_mensual IS NULL OR cuota_mensual > 0),
      forma_desembolso      VARCHAR(15) NOT NULL CHECK (forma_desembolso IN ('transferencia', 'cheque', 'efectivo')),
      modalidad_firma       VARCHAR(10) NOT NULL CHECK (modalidad_firma IN ('presencial', 'externa')),
      proveedor_externo     VARCHAR(80),
      autorizacion_requerida BOOLEAN NOT NULL,      -- resuelta al radicar (config de la empresa o excepción del asesor)
      autorizacion_momento  VARCHAR(20) NOT NULL CHECK (autorizacion_momento IN ('antes_firma', 'despues_firma', 'indiferente')),
      override_motivo       TEXT,
      observaciones         TEXT,
      estado                VARCHAR(12) NOT NULL DEFAULT 'en_tramite'
                            CHECK (estado IN ('en_tramite', 'entregada', 'recibida', 'devuelta', 'rechazada', 'desistida')),
      entregada_at          TIMESTAMPTZ,
      entregada_por         UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      recibida_at           TIMESTAMPTZ,
      recibida_por          UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      devuelta_at           TIMESTAMPTZ,
      devuelta_motivo       TEXT,
      cierre_motivo         TEXT,
      is_active             BOOLEAN NOT NULL DEFAULT true,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_credito_monto CHECK (monto_desembolso <= valor_solicitado),
      CONSTRAINT chk_credito_motivo_dif CHECK (monto_desembolso = valor_solicitado OR motivo_diferencia IS NOT NULL)
    );
    CREATE INDEX idx_credito_sol_asesor  ON credito_solicitudes (asesor_uuid, created_at DESC);
    CREATE INDEX idx_credito_sol_estado  ON credito_solicitudes (estado, created_at DESC);
    CREATE INDEX idx_credito_sol_asoc    ON credito_solicitudes (asociado_codigo);

    CREATE TABLE credito_documentos (
      id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      solicitud_id UUID NOT NULL REFERENCES credito_solicitudes(id) ON DELETE RESTRICT,
      clase        VARCHAR(20) NOT NULL CHECK (clase IN ('a_firmar', 'firmado', 'evidencia_externa', 'adjunto')),
      tipo         VARCHAR(30) NOT NULL,   -- pagare, carta_instrucciones, autorizacion_descuento, solicitud_credito, otro | desprendible_nomina, certificado_bancario, otro_adjunto
      nombre       VARCHAR(255) NOT NULL,
      archivo_id   UUID NOT NULL REFERENCES archivos(id),
      sha256       CHAR(64) NOT NULL,
      borrador_id  UUID REFERENCES credito_documentos(id),   -- en 'firmado' / 'evidencia_externa': el documento a firmar que cubre
      folio        UUID,                                     -- firma presencial: folio del motor de firma (firma_eventos)
      lote_id      UUID,
      proveedor    VARCHAR(80),                              -- firma externa
      id_transaccion VARCHAR(120),
      fecha_firma  DATE,
      vigente      BOOLEAN NOT NULL DEFAULT true,
      invalidado_motivo TEXT,
      subido_por   UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_credito_doc_sol ON credito_documentos (solicitud_id, clase);
    -- Un documento a firmar tiene, como mucho, un firmado vigente
    CREATE UNIQUE INDEX uq_credito_doc_firmado ON credito_documentos (borrador_id) WHERE clase = 'firmado' AND vigente;

    CREATE TABLE credito_autorizaciones (
      id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      solicitud_id       UUID NOT NULL REFERENCES credito_solicitudes(id) ON DELETE RESTRICT,
      estado             VARCHAR(16) NOT NULL
                         CHECK (estado IN ('sin_destinatario', 'solicitada', 'aprobada', 'rechazada', 'invalidada')),
      enviada_a          TEXT[] NOT NULL DEFAULT '{}',
      enviada_at         TIMESTAMPTZ,
      canal              VARCHAR(12) NOT NULL DEFAULT 'correo' CHECK (canal IN ('correo', 'telefono', 'fisico', 'otro')),
      fecha_autorizacion DATE,            -- la fecha que trae el soporte (no la del registro)
      registrada_at      TIMESTAMPTZ,
      archivo_id         UUID REFERENCES archivos(id),
      cuota_autorizada   NUMERIC(14,2),
      motivo_rechazo     TEXT,
      registrado_por     UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_autorizacion_soporte CHECK (estado <> 'aprobada' OR (fecha_autorizacion IS NOT NULL AND archivo_id IS NOT NULL))
    );
    CREATE INDEX idx_credito_aut_sol ON credito_autorizaciones (solicitud_id, created_at DESC);

    CREATE TABLE credito_eventos (
      id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      solicitud_id UUID NOT NULL REFERENCES credito_solicitudes(id) ON DELETE RESTRICT,
      tipo         VARCHAR(40) NOT NULL,
      detalle      JSONB NOT NULL DEFAULT '{}',
      autor_tipo   VARCHAR(10) NOT NULL DEFAULT 'empleado' CHECK (autor_tipo IN ('empleado', 'empresa', 'sistema')),
      autor_uuid   UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      ip           TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_credito_ev_sol ON credito_eventos (solicitud_id, created_at);

    -- Línea de tiempo inmutable: solo se agrega (autor_uuid puede pasar a NULL si se elimina al usuario)
    CREATE OR REPLACE FUNCTION credito_eventos_solo_agregar() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'credito_eventos es de solo agregar'; END IF;
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.solicitud_id IS DISTINCT FROM OLD.solicitud_id OR NEW.tipo IS DISTINCT FROM OLD.tipo
         OR NEW.detalle IS DISTINCT FROM OLD.detalle OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'credito_eventos es de solo agregar';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER trg_credito_eventos_solo_agregar BEFORE UPDATE OR DELETE ON credito_eventos
      FOR EACH ROW EXECUTE FUNCTION credito_eventos_solo_agregar();

    -- ÚNICA definición de "listo para Cartera". El backend y las bandejas leen esto; no se recalcula en otro lado.
    CREATE VIEW v_credito_pistas AS
    SELECT
      s.id AS solicitud_id,
      COALESCE(f.a_firmar, 0)  AS a_firmar,
      COALESCE(f.firmados, 0)  AS firmados,
      (COALESCE(f.a_firmar, 0) > 0 AND COALESCE(f.firmados, 0) = f.a_firmar) AS firma_completa,
      s.autorizacion_requerida,
      a.estado                 AS autorizacion_estado,
      (NOT s.autorizacion_requerida OR COALESCE(a.estado = 'aprobada', false)) AS autorizacion_ok,
      COALESCE(d.desprendible, false) AS tiene_desprendible,
      (s.forma_desembolso = 'transferencia') AS certificado_requerido,
      COALESCE(d.certificado, false)  AS tiene_certificado,
      (COALESCE(d.desprendible, false) AND (s.forma_desembolso <> 'transferencia' OR COALESCE(d.certificado, false))) AS documentos_ok,
      (s.is_active AND s.estado IN ('en_tramite', 'devuelta')
        AND COALESCE(f.a_firmar, 0) > 0 AND COALESCE(f.firmados, 0) = f.a_firmar
        AND (NOT s.autorizacion_requerida OR COALESCE(a.estado = 'aprobada', false))
        AND COALESCE(d.desprendible, false) AND (s.forma_desembolso <> 'transferencia' OR COALESCE(d.certificado, false))
      ) AS listo
    FROM credito_solicitudes s
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS a_firmar,
             COUNT(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM credito_documentos x WHERE x.borrador_id = b.id AND x.clase = 'firmado' AND x.vigente))::int AS firmados
      FROM credito_documentos b WHERE b.solicitud_id = s.id AND b.clase = 'a_firmar' AND b.vigente
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT estado FROM credito_autorizaciones WHERE solicitud_id = s.id ORDER BY created_at DESC, id DESC LIMIT 1
    ) a ON true
    LEFT JOIN LATERAL (
      SELECT bool_or(tipo = 'desprendible_nomina') AS desprendible, bool_or(tipo = 'certificado_bancario') AS certificado
      FROM credito_documentos WHERE solicitud_id = s.id AND clase = 'adjunto' AND vigente
    ) d ON true;

    INSERT INTO modulos (nombre, descripcion) VALUES
      ('creditos', 'Solicitudes de crédito: radicación, firma y autorización de la empresa'),
      ('cartera',  'Bandeja de Cartera: expedientes de crédito entregados')
    ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP VIEW IF EXISTS v_credito_pistas;
    DROP TRIGGER IF EXISTS trg_credito_eventos_solo_agregar ON credito_eventos;
    DROP FUNCTION IF EXISTS credito_eventos_solo_agregar();
    DROP TABLE IF EXISTS credito_eventos, credito_autorizaciones, credito_documentos, credito_solicitudes, credito_config_empresa, credito_categorias;
    DROP SEQUENCE IF EXISTS credito_radicado_seq;
    DELETE FROM permisos WHERE modulo_id IN (SELECT id FROM modulos WHERE nombre IN ('creditos', 'cartera'));
    DELETE FROM modulos WHERE nombre IN ('creditos', 'cartera');
    ALTER TABLE email_cola DROP COLUMN IF EXISTS reply_to;
  `);
};
