export const up = async (pgm) => {
  // 1. Tabla genérica de archivos
  pgm.createTable('archivos', {
    id:           { type: 'uuid', primaryKey: true, default: pgm.func('uuid_generate_v4()') },
    entidad_tipo: { type: 'text', notNull: true },
    entidad_id:   { type: 'uuid', notNull: true },
    nombre:       { type: 'text', notNull: true },
    s3_key:       { type: 'text', notNull: true, unique: true },
    mime_type:    { type: 'text' },
    size_bytes:   { type: 'integer' },
    subido_por:   { type: 'uuid', references: 'global_usuarios(id)' },
    created_at:   { type: 'timestamptz', default: pgm.func('NOW()') },
  });
  pgm.addIndex('archivos', ['entidad_tipo', 'entidad_id']);

  // 2. Migrar adjuntos existentes de facturas
  pgm.sql(`
    INSERT INTO archivos (entidad_tipo, entidad_id, nombre, s3_key, mime_type, size_bytes, subido_por)
    SELECT 'factura', id, adjunto_nombre, adjunto_key, adjunto_mime, adjunto_size, registrado_por
    FROM tesoreria_facturas
    WHERE adjunto_key IS NOT NULL
  `);

  // 3. Eliminar columnas adjunto_* de facturas
  pgm.dropColumns('tesoreria_facturas', ['adjunto_key', 'adjunto_nombre', 'adjunto_mime', 'adjunto_size']);
};

export const down = async (pgm) => {
  pgm.addColumns('tesoreria_facturas', {
    adjunto_key:    { type: 'text' },
    adjunto_nombre: { type: 'text' },
    adjunto_mime:   { type: 'text' },
    adjunto_size:   { type: 'integer' },
  });
  pgm.sql(`
    UPDATE tesoreria_facturas f
    SET adjunto_key    = a.s3_key,
        adjunto_nombre = a.nombre,
        adjunto_mime   = a.mime_type,
        adjunto_size   = a.size_bytes
    FROM archivos a
    WHERE a.entidad_tipo = 'factura' AND a.entidad_id = f.id
  `);
  pgm.dropTable('archivos');
};
