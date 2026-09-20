/**
 * Limpia los duplicados que dejó el sync de descuentos SIN número de obligación (fondo de bienestar, seguros...).
 *
 * Causa: el sync comparaba la clave 'codigo:linea:valor' con el valor como texto ('5300.00' en Postgres contra 5300 del CSV),
 * así que nunca reconocía la fila existente: en cada sincronización insertaba una fila nueva y daba de baja la anterior.
 * (Ya corregido en asociadosController.importarCSV.) Este script elimina las filas repetidas y el ruido que dejó en el historial.
 *
 *  1. asociado_descuentos: por (asociado, línea, valor) sin número y de origen csv queda UNA fila: la activa y, si no la hay, la más reciente.
 *     Las filas de otro valor (cambios reales de la cuota) se conservan como historia.
 *  2. asociado_descuentos_historial: se conserva la primera "aparición" de cada (asociado, línea, valor) y se borran las siguientes,
 *     junto con las bajas (is_active 1→0) registradas en el mismo sync, que eran la otra cara del mismo error.
 *     Limitación conocida: si una cuota volvió legítimamente a un valor que ya había tenido, esa aparición también se borra.
 *
 * Irreversible (down vacío): haga una copia de asociado_descuentos y asociado_descuentos_historial antes de ejecutarla.
 */
exports.up = (pgm) => {
  pgm.sql(`
    DELETE FROM asociado_descuentos d
    USING (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY asociado_codigo, linea_id, valor
               ORDER BY is_active DESC, updated_at DESC, id
             ) AS rn
        FROM asociado_descuentos
       WHERE numero IS NULL AND origen = 'csv'
    ) x
    WHERE d.id = x.id AND x.rn > 1;
  `);

  pgm.sql(`
    CREATE TEMP TABLE _apariciones_repetidas ON COMMIT DROP AS
    SELECT id, asociado_codigo, linea_id, sync_id
      FROM (
        SELECT id, asociado_codigo, linea_id, sync_id,
               ROW_NUMBER() OVER (
                 PARTITION BY asociado_codigo, linea_id, valor_nuevo
                 ORDER BY changed_at, id
               ) AS rn
          FROM asociado_descuentos_historial
         WHERE numero IS NULL AND campo = 'valor' AND valor_anterior IS NULL
      ) t
     WHERE rn > 1;

    DELETE FROM asociado_descuentos_historial h
     WHERE h.numero IS NULL AND h.campo = 'is_active' AND h.valor_anterior = 1 AND h.valor_nuevo = 0
       AND EXISTS (
         SELECT 1 FROM _apariciones_repetidas r
          WHERE r.asociado_codigo = h.asociado_codigo
            AND r.linea_id = h.linea_id
            AND r.sync_id IS NOT DISTINCT FROM h.sync_id
       );

    DELETE FROM asociado_descuentos_historial h
     USING _apariciones_repetidas r
     WHERE h.id = r.id;
  `);
};

exports.down = () => {
  // Irreversible: las filas repetidas eran un error, no información.
};
