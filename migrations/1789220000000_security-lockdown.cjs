/** @type {import('node-pg-migrate').MigrationBuilder} */
exports.up = (pgm) => {
  pgm.createTable('security_lockdown', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    nivel: {
      type: 'smallint', notNull: true,
      check: 'nivel IN (2,3)',
    },
    alcance: {
      type: 'varchar(12)', notNull: true, default: "'global'",
      check: "alcance IN ('global','usuario','ip')",
    },
    // '*' para global — NUNCA NULL: NULLs no colisionan en índice único, rompería idempotencia
    objetivo: { type: 'varchar(100)', notNull: true, default: "'*'" },
    motivo:   { type: 'varchar(200)', notNull: true },
    reglas:   { type: 'text[]' },
    puntaje:  { type: 'integer' },
    alerta_ids: { type: 'uuid[]' },
    origen: {
      type: 'varchar(10)', notNull: true,
      check: "origen IN ('auto','manual')",
    },
    // NULL = activado automáticamente
    activado_por_uuid: {
      type: 'uuid',
      references: '"global_usuarios"(id)',
      onDelete: 'SET NULL',
    },
    activado_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expira_at:   { type: 'timestamptz' }, // NULL = hasta reset manual
    reset_at:       { type: 'timestamptz' },
    reset_por_uuid: {
      type: 'uuid',
      references: '"global_usuarios"(id)',
      onDelete: 'SET NULL',
    },
    reset_tipo: {
      type: 'varchar(10)',
      check: "reset_tipo IN ('auto','manual')",
    },
    reset_nota: { type: 'text' },
  });

  // Un solo lockdown activo por (alcance, objetivo) — hace la activación idempotente
  // ante múltiples instancias Node corriendo el detector en paralelo
  pgm.createIndex('security_lockdown', ['alcance', 'objetivo'], {
    unique: true,
    where: 'reset_at IS NULL',
    name: 'security_lockdown_activo_unico',
  });
  pgm.createIndex('security_lockdown', 'activado_at');
  pgm.createIndex('security_lockdown', 'reset_at', { where: 'reset_at IS NULL' });
};

exports.down = (pgm) => {
  pgm.dropTable('security_lockdown');
};
