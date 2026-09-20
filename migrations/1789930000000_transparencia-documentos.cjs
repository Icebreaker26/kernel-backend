/* eslint-disable camelcase */
// Documentos públicos de la cooperativa (régimen tributario especial y transparencia): RUT, actas de asamblea,
// informes de gestión, estados financieros, certificados y formatos. Se gestionan desde Kernel y se publican en la
// página pública /transparencia. El archivo vive en S3 (tabla archivos, entidad_tipo 'transparencia_documento').
// Borrado lógico (is_active). 'publicado' controla si se ve en la página pública.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE transparencia_documentos (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      titulo      VARCHAR(200) NOT NULL,
      categoria   VARCHAR(30)  NOT NULL CHECK (categoria IN
                    ('rut', 'acta_asamblea', 'informe_gestion', 'estados_financieros', 'renta', 'certificado', 'formato', 'otro')),
      anio        SMALLINT     CHECK (anio BETWEEN 1970 AND 2100),
      archivo_id  UUID         REFERENCES archivos(id) ON DELETE SET NULL,
      publicado   BOOLEAN      NOT NULL DEFAULT false,
      is_active   BOOLEAN      NOT NULL DEFAULT true,
      creado_por  UUID         REFERENCES global_usuarios(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_transparencia_publico ON transparencia_documentos (categoria, anio DESC) WHERE is_active AND publicado;

    INSERT INTO modulos (nombre, descripcion)
    VALUES ('transparencia', 'Documentos públicos: régimen tributario especial y transparencia')
    ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS transparencia_documentos;
    DELETE FROM permisos WHERE modulo_id IN (SELECT id FROM modulos WHERE nombre = 'transparencia');
    DELETE FROM modulos WHERE nombre = 'transparencia';
  `);
};
