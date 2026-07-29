exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('asociado_historial_aporte', {
    id:               { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    asociado_codigo:  { type: 'varchar(50)', notNull: true, references: '"asociados"(codigo)', onDelete: 'CASCADE' },
    campo:            { type: 'varchar(30)', notNull: true },   // 'valor_aporte' | 'saldo_aporte'
    valor_anterior:   { type: 'numeric' },
    valor_nuevo:      { type: 'numeric' },
    changed_at:       { type: 'timestamptz', default: pgm.func('NOW()') },
  });

  pgm.createIndex('asociado_historial_aporte', 'asociado_codigo');
  pgm.createIndex('asociado_historial_aporte', ['asociado_codigo', 'campo']);

  // Función del trigger
  pgm.sql(`
    CREATE OR REPLACE FUNCTION fn_log_aporte_changes()
    RETURNS TRIGGER AS $$
    BEGIN
      IF OLD.valor_aporte IS DISTINCT FROM NEW.valor_aporte THEN
        INSERT INTO asociado_historial_aporte (asociado_codigo, campo, valor_anterior, valor_nuevo)
        VALUES (NEW.codigo, 'valor_aporte', OLD.valor_aporte, NEW.valor_aporte);
      END IF;

      IF OLD.saldo_aporte IS DISTINCT FROM NEW.saldo_aporte THEN
        INSERT INTO asociado_historial_aporte (asociado_codigo, campo, valor_anterior, valor_nuevo)
        VALUES (NEW.codigo, 'saldo_aporte', OLD.saldo_aporte, NEW.saldo_aporte);
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // Trigger en la tabla asociados
  pgm.sql(`
    CREATE TRIGGER trg_aporte_changes
    AFTER UPDATE ON asociados
    FOR EACH ROW
    EXECUTE FUNCTION fn_log_aporte_changes();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS trg_aporte_changes ON asociados;`);
  pgm.sql(`DROP FUNCTION IF EXISTS fn_log_aporte_changes();`);
  pgm.dropTable('asociado_historial_aporte');
};
