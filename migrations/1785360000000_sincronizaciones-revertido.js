export const up = (pgm) => {
  pgm.addColumns('sincronizaciones', {
    revertido_at:  { type: 'timestamptz', default: null },
    revertido_por: { type: 'uuid', references: 'global_usuarios(id)', onDelete: 'SET NULL', default: null },
  });
};

export const down = (pgm) => {
  pgm.dropColumns('sincronizaciones', ['revertido_at', 'revertido_por']);
};
