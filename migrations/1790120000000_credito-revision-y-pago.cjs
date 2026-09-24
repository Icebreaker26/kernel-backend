/* eslint-disable camelcase */
// Después de Cartera: Control Interno revisa (aprueba o devuelve) y Tesorería paga.
//
//  completada ──(CI aprueba)──▶ en_tesoreria ──(Tesorería paga)──▶ pagada
//      │                            └──(Tesorería devuelve a CI)──▶ completada
//      ├──(CI devuelve a Cartera)──▶ recibida
//      └──(CI devuelve al asesor)──▶ devuelta
//
//  - credito_cierre guarda la cuenta de pago que digita Cartera (solo si el desembolso es por transferencia).
//  - credito_revisiones_ci: cada revisión de Control Interno, con su lista de verificación (solo se agrega).
//  - credito_ordenes_pago: lo que ve Tesorería. Es una FOTO inmutable de asociado, cuenta y monto al aprobar; después solo
//    cambian los campos del pago. Un trigger impide modificar la foto, así una cuenta no puede cambiar entre la aprobación y el pago.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE credito_solicitudes DROP CONSTRAINT IF EXISTS credito_solicitudes_estado_check;
    ALTER TABLE credito_solicitudes ADD CONSTRAINT credito_solicitudes_estado_check
      CHECK (estado IN ('en_tramite', 'entregada', 'recibida', 'devuelta', 'rechazada', 'desistida', 'completada', 'en_tesoreria', 'pagada'));

    ALTER TABLE credito_cierre
      ADD COLUMN banco               VARCHAR(80),
      ADD COLUMN tipo_cuenta         VARCHAR(12) CHECK (tipo_cuenta IS NULL OR tipo_cuenta IN ('ahorros', 'corriente')),
      ADD COLUMN numero_cuenta       VARCHAR(20),
      ADD COLUMN titular_nombre      VARCHAR(150),
      ADD COLUMN titular_documento   VARCHAR(20);

    CREATE TABLE credito_revisiones_ci (
      id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      solicitud_id UUID NOT NULL REFERENCES credito_solicitudes(id) ON DELETE RESTRICT,
      decision     VARCHAR(10) NOT NULL CHECK (decision IN ('aprobada', 'devuelta')),
      destino      VARCHAR(10) CHECK (destino IN ('cartera', 'asesor')),      -- solo si devuelve
      motivo       TEXT,
      lista        JSONB NOT NULL DEFAULT '{}',                                -- { clave: true|false } de lo que marcó el revisor
      revisor_uuid UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_revision_devuelta CHECK (decision <> 'devuelta' OR (destino IS NOT NULL AND motivo IS NOT NULL))
    );
    CREATE INDEX idx_credito_rev_sol ON credito_revisiones_ci (solicitud_id, created_at);

    CREATE TABLE credito_ordenes_pago (
      id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      solicitud_id          UUID NOT NULL REFERENCES credito_solicitudes(id) ON DELETE RESTRICT,
      estado                VARCHAR(10) NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente', 'pagada', 'anulada')),
      -- ── FOTO inmutable (lo aprobó Control Interno) ──
      radicado              VARCHAR(20) NOT NULL,
      asociado_codigo       VARCHAR(20) NOT NULL,
      asociado_nombre       VARCHAR(200) NOT NULL,
      forma_pago            VARCHAR(15) NOT NULL CHECK (forma_pago IN ('transferencia', 'cheque', 'efectivo')),
      monto                 NUMERIC(14,2) NOT NULL CHECK (monto > 0),
      banco                 VARCHAR(80),
      tipo_cuenta           VARCHAR(12),
      numero_cuenta         VARCHAR(20),
      titular_nombre        VARCHAR(150),
      titular_documento     VARCHAR(20),
      titular_es_asociado   BOOLEAN NOT NULL,
      huella                CHAR(64) NOT NULL,       -- SHA-256 de la foto: permite comprobar que no se alteró
      aprobada_por          UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      aprobada_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- ── Pago ──
      cuenta_origen_id      UUID REFERENCES tesoreria_cuentas(id) ON DELETE RESTRICT,
      referencia_pago       VARCHAR(100),
      fecha_pago            DATE,
      movimiento_id         UUID REFERENCES tesoreria_movimientos(id) ON DELETE RESTRICT,
      pagada_por            UUID REFERENCES global_usuarios(id) ON DELETE SET NULL,
      pagada_at             TIMESTAMPTZ,
      anulada_motivo        TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chk_orden_transferencia CHECK (forma_pago <> 'transferencia'
        OR (banco IS NOT NULL AND tipo_cuenta IS NOT NULL AND numero_cuenta IS NOT NULL AND titular_nombre IS NOT NULL AND titular_documento IS NOT NULL)),
      CONSTRAINT chk_orden_pagada CHECK (estado <> 'pagada' OR (cuenta_origen_id IS NOT NULL AND referencia_pago IS NOT NULL AND fecha_pago IS NOT NULL AND movimiento_id IS NOT NULL AND pagada_por IS NOT NULL))
    );
    -- A lo sumo una orden viva (pendiente o pagada) por solicitud: evita pagar dos veces el mismo crédito
    CREATE UNIQUE INDEX uq_credito_orden_viva ON credito_ordenes_pago (solicitud_id) WHERE estado IN ('pendiente', 'pagada');
    CREATE INDEX idx_credito_orden_estado ON credito_ordenes_pago (estado, aprobada_at);

    CREATE OR REPLACE FUNCTION credito_orden_foto_inmutable() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'las órdenes de pago no se borran'; END IF;
      IF NEW.solicitud_id IS DISTINCT FROM OLD.solicitud_id OR NEW.radicado IS DISTINCT FROM OLD.radicado
         OR NEW.asociado_codigo IS DISTINCT FROM OLD.asociado_codigo OR NEW.asociado_nombre IS DISTINCT FROM OLD.asociado_nombre
         OR NEW.forma_pago IS DISTINCT FROM OLD.forma_pago OR NEW.monto IS DISTINCT FROM OLD.monto
         OR NEW.banco IS DISTINCT FROM OLD.banco OR NEW.tipo_cuenta IS DISTINCT FROM OLD.tipo_cuenta
         OR NEW.numero_cuenta IS DISTINCT FROM OLD.numero_cuenta OR NEW.titular_nombre IS DISTINCT FROM OLD.titular_nombre
         OR NEW.titular_documento IS DISTINCT FROM OLD.titular_documento OR NEW.titular_es_asociado IS DISTINCT FROM OLD.titular_es_asociado
         OR NEW.huella IS DISTINCT FROM OLD.huella OR NEW.aprobada_por IS DISTINCT FROM OLD.aprobada_por OR NEW.aprobada_at IS DISTINCT FROM OLD.aprobada_at THEN
        RAISE EXCEPTION 'la orden de pago no se puede modificar: solo se paga o se anula';
      END IF;
      IF OLD.estado <> 'pendiente' AND NEW.estado IS DISTINCT FROM OLD.estado THEN
        RAISE EXCEPTION 'la orden de pago ya está cerrada';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER trg_credito_orden_foto_inmutable BEFORE UPDATE OR DELETE ON credito_ordenes_pago
      FOR EACH ROW EXECUTE FUNCTION credito_orden_foto_inmutable();

    INSERT INTO acciones (nombre) VALUES ('REVISAR_CREDITOS'), ('PAGAR_CREDITOS') ON CONFLICT (nombre) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS credito_ordenes_pago;
    DROP FUNCTION IF EXISTS credito_orden_foto_inmutable();
    DROP TABLE IF EXISTS credito_revisiones_ci;
    ALTER TABLE credito_cierre DROP COLUMN IF EXISTS banco, DROP COLUMN IF EXISTS tipo_cuenta, DROP COLUMN IF EXISTS numero_cuenta,
      DROP COLUMN IF EXISTS titular_nombre, DROP COLUMN IF EXISTS titular_documento;
    UPDATE credito_solicitudes SET estado = 'completada' WHERE estado IN ('en_tesoreria', 'pagada');
    ALTER TABLE credito_solicitudes DROP CONSTRAINT IF EXISTS credito_solicitudes_estado_check;
    ALTER TABLE credito_solicitudes ADD CONSTRAINT credito_solicitudes_estado_check
      CHECK (estado IN ('en_tramite', 'entregada', 'recibida', 'devuelta', 'rechazada', 'desistida', 'completada'));
    DELETE FROM acciones WHERE nombre IN ('REVISAR_CREDITOS', 'PAGAR_CREDITOS');
  `);
};
