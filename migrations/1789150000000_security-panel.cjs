/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('security_alerts', {
    id:          { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    regla:       { type: 'varchar(40)', notNull: true },
    tipo:        { type: 'varchar(60)', notNull: true },
    severidad:   { type: 'varchar(10)', notNull: true, check: "severidad IN ('baja','media','alta','critica')" },
    usuario_uuid: { type: 'uuid', references: '"global_usuarios"(id)', onDelete: 'SET NULL' },
    ip:          { type: 'varchar(45)' },
    dedupe_key:  { type: 'text', unique: true },
    titulo:      { type: 'varchar(200)', notNull: true },
    detalle:     { type: 'jsonb' },
    entidad_tipo: { type: 'varchar(30)' },
    entidad_id:  { type: 'varchar(100)' },
    ocurrencias: { type: 'integer', notNull: true, default: 1 },
    primera_vez_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    ultima_vez_at:  { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    estado:      { type: 'varchar(20)', notNull: true, default: "'nueva'", check: "estado IN ('nueva','reconocida','resuelta','falso_positivo')" },
    reconocida_por_uuid: { type: 'uuid', references: '"global_usuarios"(id)', onDelete: 'SET NULL' },
    reconocida_at: { type: 'timestamptz' },
    nota:        { type: 'text' },
    created_at:  { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('security_alerts', ['estado', 'severidad', 'ultima_vez_at']);
  pgm.createIndex('security_alerts', 'ultima_vez_at');
  pgm.createIndex('security_alerts', 'usuario_uuid', { where: 'usuario_uuid IS NOT NULL' });
  pgm.createIndex('security_alerts', ['entidad_tipo', 'entidad_id']);
  // Índice parcial para el badge de alertas nuevas (query más frecuente del panel)
  pgm.createIndex('security_alerts', ['severidad', 'ultima_vez_at'], { where: "estado = 'nueva'" });

  pgm.createTable('security_metrics_snapshot', {
    clave:        { type: 'varchar(40)', primaryKey: true },
    datos:        { type: 'jsonb', notNull: true },
    calculado_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    duracion_ms:  { type: 'integer' },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('security_metrics_snapshot');
  pgm.dropTable('security_alerts');
};
