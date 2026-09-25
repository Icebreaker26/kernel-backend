/* eslint-disable camelcase */
// Estado de la sesión de Windows del PC de SOLIDO: el agente lo informa en cada latido para que Kernel distinga
// "activo", "sesión bloqueada" y "apagado" (sin latido reciente).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE rpa_agentes
      ADD COLUMN sesion_bloqueada BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN sesion_at        TIMESTAMPTZ;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE rpa_agentes DROP COLUMN IF EXISTS sesion_bloqueada, DROP COLUMN IF EXISTS sesion_at;`);
};
