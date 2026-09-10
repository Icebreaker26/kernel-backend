export const up = async (pgm) => {
  pgm.addColumns('tesoreria_facturas', {
    adjunto_key:    { type: 'text' },
    adjunto_nombre: { type: 'text' },
    adjunto_mime:   { type: 'text' },
    adjunto_size:   { type: 'integer' },
  });
};

export const down = async (pgm) => {
  pgm.dropColumns('tesoreria_facturas', ['adjunto_key', 'adjunto_nombre', 'adjunto_mime', 'adjunto_size']);
};
