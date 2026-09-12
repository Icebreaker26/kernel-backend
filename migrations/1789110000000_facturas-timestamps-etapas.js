/**
 * Agrega autorizada_por, autorizada_at, pagada_at a tesoreria_facturas
 * para poder calcular tiempos reales por cada etapa del flujo de aprobación.
 *
 * Pipeline completo de timestamps:
 *   created_at → aprobado_at → verificada_at → autorizada_at → pagada_at
 */
export const up = (pgm) => {
  pgm.addColumns('tesoreria_facturas', {
    autorizada_por: {
      type: 'uuid',
      references: '"global_usuarios"(id)',
      onDelete: 'SET NULL',
      notNull: false,
    },
    autorizada_at: { type: 'timestamptz', notNull: false },
    pagada_at:     { type: 'timestamptz', notNull: false },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('tesoreria_facturas', ['autorizada_por', 'autorizada_at', 'pagada_at']);
};
