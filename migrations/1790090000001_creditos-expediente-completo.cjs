/* eslint-disable camelcase */
// `listo` solo vale mientras la solicitud está en trámite (sirve para permitir la entrega). Cartera necesita ver si el expediente
// está completo aunque ya haya sido entregado o recibido: se agrega `expediente_completo`, que no depende del estado.
exports.up = (pgm) => {
  pgm.sql(`
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
  `);
};

// La vista anterior (sin la columna nueva) se restaura en la migración que la creó; aquí basta con volver a la definición previa
exports.down = (pgm) => {
  pgm.sql(`
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
  `);
};
