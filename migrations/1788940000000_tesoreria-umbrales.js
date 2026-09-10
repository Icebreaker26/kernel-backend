export const up = (pgm) => {
  pgm.createTable('tesoreria_config_umbrales', {
    id:               { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    tipo_operacion:   { type: 'varchar(60)', notNull: true, unique: true },
    monto_umbral:     { type: 'numeric(15,2)', notNull: true },
    descripcion:      { type: 'text' },
    dias_vencimiento: { type: 'int', notNull: true, default: 7 },
    created_at:       { type: 'timestamptz', default: pgm.func('NOW()') },
    updated_at:       { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.sql(`
    INSERT INTO tesoreria_config_umbrales (tipo_operacion, monto_umbral, descripcion, dias_vencimiento)
    VALUES
      ('egreso_proveedor', 5000000,  'Pagos a proveedores que requieren aprobación de Gerencia', 7),
      ('egreso_nomina',    10000000, 'Nómina y pagos laborales que requieren aprobación de Gerencia', 5)
  `);

  pgm.addColumns('tesoreria_facturas', {
    requiere_aprobacion_gerencia: { type: 'boolean', notNull: true, default: false },
    aprobado_gerencia_por:        { type: 'uuid', references: '"global_usuarios"', notNull: false },
    aprobado_gerencia_at:         { type: 'timestamptz', notNull: false },
    aprobacion_vence_at:          { type: 'timestamptz', notNull: false },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('tesoreria_facturas', [
    'requiere_aprobacion_gerencia', 'aprobado_gerencia_por',
    'aprobado_gerencia_at', 'aprobacion_vence_at',
  ]);
  pgm.dropTable('tesoreria_config_umbrales');
};
