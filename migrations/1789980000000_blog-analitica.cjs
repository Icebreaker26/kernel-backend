/* eslint-disable camelcase */
// Blog del sitio público (entradas escritas desde Kernel, portada en S3, borrador/publicado) y analítica propia del sitio.
//
// Blog: blog_entradas.contenido guarda HTML YA sanitizado (lista blanca de etiquetas, ver services/sanitizarHtml.js).
// Borrado lógico (is_active). El slug es único entre las entradas activas y no cambia una vez publicada (las URLs no se rompen).
//
// Analítica: sin cookies y sin datos personales. No se guarda IP ni agente de usuario: solo un hash del visitante que cambia
// cada día (así se cuentan visitantes distintos por día, pero no se le puede seguir de un día a otro), la ruta, el sitio de
// origen (host del referente), el tipo de dispositivo y, en los clics clave, el nombre del evento.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE blog_categorias (
      id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      nombre     VARCHAR(60) NOT NULL,
      slug       VARCHAR(80) NOT NULL UNIQUE,
      is_active  BOOLEAN     NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO blog_categorias (nombre, slug) VALUES
      ('Noticias', 'noticias'), ('Sorteos', 'sorteos'), ('Bienestar', 'bienestar'),
      ('Créditos', 'creditos'), ('Comunicados', 'comunicados');

    CREATE TABLE blog_entradas (
      id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      titulo            VARCHAR(200) NOT NULL,
      slug              VARCHAR(120) NOT NULL,
      resumen           VARCHAR(300),
      contenido         TEXT         NOT NULL DEFAULT '',
      categoria_id      UUID         REFERENCES blog_categorias(id) ON DELETE SET NULL,
      portada_archivo_id UUID        REFERENCES archivos(id) ON DELETE SET NULL,
      estado            VARCHAR(12)  NOT NULL DEFAULT 'borrador' CHECK (estado IN ('borrador', 'publicado')),
      publicado_at      TIMESTAMPTZ,
      autor_id          UUID         REFERENCES global_usuarios(id) ON DELETE SET NULL,
      is_active         BOOLEAN      NOT NULL DEFAULT true,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX uq_blog_entradas_slug ON blog_entradas (slug) WHERE is_active;
    CREATE INDEX idx_blog_entradas_publico ON blog_entradas (publicado_at DESC) WHERE is_active AND estado = 'publicado';

    CREATE TABLE analitica_eventos (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tipo        VARCHAR(10)  NOT NULL CHECK (tipo IN ('vista', 'clic')),
      ruta        VARCHAR(200) NOT NULL,
      evento      VARCHAR(40),
      origen      VARCHAR(120),
      dispositivo VARCHAR(10)  NOT NULL DEFAULT 'escritorio' CHECK (dispositivo IN ('escritorio', 'movil', 'tablet')),
      visitante   CHAR(16)     NOT NULL,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    );
    CREATE INDEX idx_analitica_eventos_fecha ON analitica_eventos (created_at);
    CREATE INDEX idx_analitica_eventos_tipo_fecha ON analitica_eventos (tipo, created_at);

    INSERT INTO modulos (nombre, descripcion) VALUES
      ('blog',      'Blog del sitio público: entradas, portadas y categorías'),
      ('analitica', 'Analítica del sitio público: visitas, páginas, origen y clics clave')
    ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS analitica_eventos;
    DROP TABLE IF EXISTS blog_entradas;
    DROP TABLE IF EXISTS blog_categorias;
    DELETE FROM permisos WHERE modulo_id IN (SELECT id FROM modulos WHERE nombre IN ('blog', 'analitica'));
    DELETE FROM modulos WHERE nombre IN ('blog', 'analitica');
  `);
};
