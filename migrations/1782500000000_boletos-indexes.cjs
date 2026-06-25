exports.up = (pgm) => {
  pgm.createIndex('boletos', ['sorteo_id', 'asociado_codigo'], {
    name: 'idx_boletos_sorteo_asociado',
    where: 'asociado_codigo IS NOT NULL',
    ifNotExists: true,
  });
  pgm.createIndex('boletos', ['sorteo_id', 'estado'], {
    name: 'idx_boletos_sorteo_estado',
    ifNotExists: true,
  });
  pgm.createIndex('sorteo_logs', ['sorteo_id', 'numero'], {
    name: 'idx_sorteo_logs_sorteo_numero',
    ifNotExists: true,
  });
  pgm.createIndex('sorteo_logs', ['sorteo_id', 'created_at'], {
    name: 'idx_sorteo_logs_sorteo_fecha',
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_boletos_sorteo_asociado;
    DROP INDEX IF EXISTS idx_boletos_sorteo_estado;
    DROP INDEX IF EXISTS idx_sorteo_logs_sorteo_numero;
    DROP INDEX IF EXISTS idx_sorteo_logs_sorteo_fecha;
  `);
};
