export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE patronales_conceptos (
      id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
      codigo     VARCHAR(30) UNIQUE NOT NULL,
      nombre     VARCHAR(60) NOT NULL,
      linea_csv  VARCHAR(10),
      fuente     VARCHAR(80),
      orden      INT         NOT NULL DEFAULT 0,
      activo     BOOL        NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO patronales_conceptos (codigo, nombre, linea_csv, fuente, orden) VALUES
      ('APORTE', 'Aporte mensual', '1',  'asociados.valor_aporte', 10),
      ('BONO',   'Bono sorteo',    '15', 'boletos',                20);
  `);
};

export const down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS patronales_conceptos CASCADE;`);
};
