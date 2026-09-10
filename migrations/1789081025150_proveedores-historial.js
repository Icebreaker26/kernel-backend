/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export async function up(pgm) {
  pgm.createTable('tesoreria_proveedores_historial', {
    id:               { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    proveedor_id:     { type: 'uuid', notNull: true, references: 'tesoreria_proveedores(id)' },
    tipo_cambio:      { type: 'varchar(30)', notNull: true },   // 'creacion' | 'actualizacion' | 'desactivacion'
    campos_antes:     { type: 'jsonb' },
    campos_despues:   { type: 'jsonb' },
    cambiado_por:     { type: 'uuid', references: 'global_usuarios(id)' },
    cambiado_at:      { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.addIndex('tesoreria_proveedores_historial', 'proveedor_id');
  pgm.addIndex('tesoreria_proveedores_historial', 'cambiado_at');
}

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export async function down(pgm) {
  pgm.dropTable('tesoreria_proveedores_historial');
}
