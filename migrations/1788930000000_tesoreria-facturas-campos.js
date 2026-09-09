export const up = (pgm) => {
  pgm.addColumns('tesoreria_facturas', {
    fecha_emision:      { type: 'date', notNull: false },
    area_responsable:   { type: 'varchar(100)', notNull: false },
    fecha_entrega_area: { type: 'date', notNull: false },
  });

  pgm.renameColumn('tesoreria_facturas', 'soporte', 'numero_factura');
};

export const down = (pgm) => {
  pgm.renameColumn('tesoreria_facturas', 'numero_factura', 'soporte');
  pgm.dropColumns('tesoreria_facturas', ['fecha_emision', 'area_responsable', 'fecha_entrega_area']);
};
