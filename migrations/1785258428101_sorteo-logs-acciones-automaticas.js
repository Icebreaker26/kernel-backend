export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE sorteo_logs DROP CONSTRAINT IF EXISTS sorteo_logs_accion_check;
    ALTER TABLE sorteo_logs ADD CONSTRAINT sorteo_logs_accion_check CHECK (accion IN (
      'COMPRA_DIRECTA',
      'ANULACION_DIRECTA',
      'SOLICITUD_ADQUISICION',
      'APROBACION',
      'RECHAZO',
      'CANCELACION_ASOCIADO',
      'SOLICITUD_RETIRO',
      'APROBACION_RETIRO',
      'RECHAZO_RETIRO',
      'LIBERACION_POR_RETIRO_CSV',
      'AUTO_CIERRE',
      'AUTO_APERTURA'
    ));
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE sorteo_logs DROP CONSTRAINT IF EXISTS sorteo_logs_accion_check;
    ALTER TABLE sorteo_logs ADD CONSTRAINT sorteo_logs_accion_check CHECK (accion IN (
      'COMPRA_DIRECTA',
      'ANULACION_DIRECTA',
      'SOLICITUD_ADQUISICION',
      'APROBACION',
      'RECHAZO',
      'CANCELACION_ASOCIADO',
      'SOLICITUD_RETIRO',
      'APROBACION_RETIRO',
      'RECHAZO_RETIRO',
      'LIBERACION_POR_RETIRO_CSV'
    ));
  `);
};
