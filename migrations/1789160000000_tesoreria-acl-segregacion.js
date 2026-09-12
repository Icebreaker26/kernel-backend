/**
 * C-1: ACL granular por etapa del flujo de facturas
 * A-2: Tabla de historial de cambios en umbrales de aprobación
 *
 * Nuevas acciones ACL:
 *   APROBAR_AREA     — aprobación por área responsable (tesoreria)
 *   AUTORIZAR        — autorización de pago por Tesorería (tesoreria)
 *   CONCILIAR        — conciliación manual y carga de extracto (tesoreria)
 *   APROBAR_GERENCIA — aprobación por Gerencia (tesoreria)
 *   CONFIG_UMBRAL    — modificar umbrales de aprobación (tesoreria + control_interno)
 */
export const up = (pgm) => {
  pgm.sql(`
    INSERT INTO acciones (nombre) VALUES
      ('APROBAR_AREA'),
      ('AUTORIZAR'),
      ('CONCILIAR'),
      ('APROBAR_GERENCIA'),
      ('CONFIG_UMBRAL')
    ON CONFLICT (nombre) DO NOTHING;
  `);

  pgm.createTable('tesoreria_config_umbrales_historial', {
    id:             { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    umbral_id:      { type: 'uuid', notNull: true, references: '"tesoreria_config_umbrales"(id)', onDelete: 'CASCADE' },
    operacion:      { type: 'text', notNull: true },   // 'crear' | 'actualizar'
    campos_antes:   { type: 'jsonb' },                 // NULL en operacion='crear'
    campos_despues: { type: 'jsonb', notNull: true },
    cambiado_por:   { type: 'uuid', notNull: true, references: '"global_usuarios"(id)', onDelete: 'RESTRICT' },
    cambiado_at:    { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.createIndex('tesoreria_config_umbrales_historial', 'umbral_id');
  pgm.createIndex('tesoreria_config_umbrales_historial', 'cambiado_por');
};

export const down = (pgm) => {
  pgm.dropTable('tesoreria_config_umbrales_historial');
  pgm.sql(`
    DELETE FROM acciones WHERE nombre IN
      ('APROBAR_AREA', 'AUTORIZAR', 'CONCILIAR', 'APROBAR_GERENCIA', 'CONFIG_UMBRAL');
  `);
};
