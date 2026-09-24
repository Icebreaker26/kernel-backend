/* eslint-disable camelcase */
// Cierre de Cartera: tras recibir el expediente, Cartera carga y firma el Comprobante de aprobación y el Formato de estudio de crédito,
// decide si el crédito lleva aval del fondo regional, calcula el desembolso neto y marca COMPLETADO (pasa a Control Interno).
//
//  - credito_documentos.etapa separa los documentos de Cartera de los del asesor: la vista v_credito_pistas (regla de "listo para Cartera")
//    solo cuenta los del asesor; los de Cartera nunca deben afectar la entrega.
//  - credito_cierre guarda el aval, el valor de la firma electrónica externa, el desembolso neto y la posición de los sellos.
//    Mientras la solicitud no esté COMPLETADA los valores se recalculan al guardar; al completar quedan congelados.
//  - credito_parametros: tarifa de la firma electrónica externa (costo por documento firmado con proveedor). Se congela en cada cierre.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE credito_documentos ADD COLUMN etapa VARCHAR(10) NOT NULL DEFAULT 'asesor' CHECK (etapa IN ('asesor', 'cartera'));

    ALTER TABLE credito_solicitudes DROP CONSTRAINT IF EXISTS credito_solicitudes_estado_check;
    ALTER TABLE credito_solicitudes ADD CONSTRAINT credito_solicitudes_estado_check
      CHECK (estado IN ('en_tramite', 'entregada', 'recibida', 'devuelta', 'rechazada', 'desistida', 'completada'));
    ALTER TABLE credito_solicitudes ADD COLUMN completada_at TIMESTAMPTZ, ADD COLUMN completada_por UUID REFERENCES global_usuarios(id) ON DELETE SET NULL;
    CREATE INDEX idx_credito_sol_completada ON credito_solicitudes (completada_at) WHERE estado = 'completada';

    CREATE TABLE credito_cierre (
      solicitud_id     UUID PRIMARY KEY REFERENCES credito_solicitudes(id) ON DELETE RESTRICT,
      con_aval         BOOLEAN NOT NULL DEFAULT false,
      aval_porcentaje  NUMERIC(5,2) CHECK (aval_porcentaje IS NULL OR (aval_porcentaje > 0 AND aval_porcentaje <= 100)),
      aval_valor       NUMERIC(14,2) NOT NULL DEFAULT 0,
      firma_electronica_valor NUMERIC(14,2) NOT NULL DEFAULT 0,   -- tarifa vigente al guardar, solo si la firma fue con proveedor externo
      desembolso_neto  NUMERIC(14,2) NOT NULL,
      sellos           JSONB NOT NULL DEFAULT '{}',                -- { aval|firma|desembolso: { pagina, x, y } } fracciones desde la esquina superior izquierda
      updated_by       UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_cierre_aval CHECK ((con_aval AND aval_porcentaje IS NOT NULL) OR (NOT con_aval AND aval_valor = 0)),
      CONSTRAINT chk_cierre_neto CHECK (desembolso_neto >= 0)
    );

    CREATE TABLE credito_parametros (
      clave      VARCHAR(60) PRIMARY KEY,
      valor      NUMERIC(14,2) NOT NULL CHECK (valor >= 0),
      updated_by UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO credito_parametros (clave, valor) VALUES ('tarifa_firma_electronica', 0);

    -- Los documentos de Cartera no entran en la regla de "listo para Cartera" ni en el expediente del asesor
    CREATE OR REPLACE VIEW v_credito_pistas AS
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
      ) AS listo,
      (COALESCE(f.a_firmar, 0) > 0 AND COALESCE(f.firmados, 0) = f.a_firmar
        AND (NOT s.autorizacion_requerida OR COALESCE(a.estado = 'aprobada', false))
        AND COALESCE(d.desprendible, false) AND (s.forma_desembolso <> 'transferencia' OR COALESCE(d.certificado, false))
      ) AS expediente_completo
    FROM credito_solicitudes s
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS a_firmar,
             COUNT(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM credito_documentos x WHERE x.borrador_id = b.id AND x.clase = 'firmado' AND x.vigente))::int AS firmados
      FROM credito_documentos b WHERE b.solicitud_id = s.id AND b.clase = 'a_firmar' AND b.vigente AND b.etapa = 'asesor'
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT estado FROM credito_autorizaciones WHERE solicitud_id = s.id ORDER BY created_at DESC, id DESC LIMIT 1
    ) a ON true
    LEFT JOIN LATERAL (
      SELECT bool_or(tipo = 'desprendible_nomina') AS desprendible, bool_or(tipo = 'certificado_bancario') AS certificado
      FROM credito_documentos WHERE solicitud_id = s.id AND clase = 'adjunto' AND vigente AND etapa = 'asesor'
    ) d ON true;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS credito_parametros;
    DROP TABLE IF EXISTS credito_cierre;
    UPDATE credito_solicitudes SET estado = 'recibida' WHERE estado = 'completada';
    DROP INDEX IF EXISTS idx_credito_sol_completada;
    ALTER TABLE credito_solicitudes DROP COLUMN IF EXISTS completada_at, DROP COLUMN IF EXISTS completada_por;
    ALTER TABLE credito_solicitudes DROP CONSTRAINT IF EXISTS credito_solicitudes_estado_check;
    ALTER TABLE credito_solicitudes ADD CONSTRAINT credito_solicitudes_estado_check
      CHECK (estado IN ('en_tramite', 'entregada', 'recibida', 'devuelta', 'rechazada', 'desistida'));
    DELETE FROM credito_documentos WHERE etapa = 'cartera';
    -- La vista vuelve a su definición previa (sin filtrar por etapa) para poder quitar la columna
    CREATE OR REPLACE VIEW v_credito_pistas AS
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
      ) AS listo,
      (COALESCE(f.a_firmar, 0) > 0 AND COALESCE(f.firmados, 0) = f.a_firmar
        AND (NOT s.autorizacion_requerida OR COALESCE(a.estado = 'aprobada', false))
        AND COALESCE(d.desprendible, false) AND (s.forma_desembolso <> 'transferencia' OR COALESCE(d.certificado, false))
      ) AS expediente_completo
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
    ALTER TABLE credito_documentos DROP COLUMN IF EXISTS etapa;
  `);
};
