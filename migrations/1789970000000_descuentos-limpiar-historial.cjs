/**
 * Segunda parte de la limpieza de descuentos sin número de obligación (fondo de bienestar, seguros...): el HISTORIAL.
 *
 * La migración 1789960000000 dejó una fila por cuota, pero solo limpió del historial las "primera vez" del campo `valor`.
 * El error del sync (comparar '5300.00' contra 5300) también registró en cada sincronización una "primera vez" de valor_obligacion,
 * saldo_credito, tasa_interes y num_cuotas (casi siempre en $0) y una baja falsa, y eso se ve en la ficha del asociado como
 * "VALOR OBLIGACIÓN $0 PRIMERA VEZ", "TASA DE INTERÉS 0.00% PRIMERA VEZ", "ESTADO ACTIVO → INACTIVO"... repetidos por cada sync.
 *
 * Solo toca asociado_descuentos_historial y solo líneas SIN número (los créditos con número no se tocan):
 *   a) bajas (is_active 1→0) que en el mismo sync tuvieron una aparición de la misma línea, cuando esa cuota NUNCA cambió de valor
 *      (todas sus filas tienen el mismo valor): eran la otra cara del error, no una baja real.
 *   b) "primera vez" repetidas de cada campo: se conserva la primera por (asociado, línea, campo, valor).
 *   c) "primera vez" en cero de valor_obligacion, saldo_credito, tasa_interes y num_cuotas: no significan nada para una cuota sin obligación.
 * Limitación conocida: si una cuota volvió legítimamente a un valor que ya había tenido, esa aparición también se borra.
 *
 * Irreversible (down vacío). Respaldo previo: descuentos-antes-de-limpieza-20260920-1755.dump (contiene estas entradas).
 */
exports.up = (pgm) => {
  pgm.sql(`
    -- a) bajas falsas: misma sync con una aparición de la línea y la cuota nunca cambió de valor
    DELETE FROM asociado_descuentos_historial h
     WHERE h.numero IS NULL AND h.campo = 'is_active' AND h.valor_anterior = 1 AND h.valor_nuevo = 0
       AND EXISTS (
         SELECT 1 FROM asociado_descuentos_historial a
          WHERE a.asociado_codigo = h.asociado_codigo AND a.linea_id = h.linea_id
            AND a.campo = 'valor' AND a.valor_anterior IS NULL
            AND a.sync_id IS NOT DISTINCT FROM h.sync_id
       )
       AND (SELECT count(DISTINCT ad.valor) FROM asociado_descuentos ad
             WHERE ad.asociado_codigo = h.asociado_codigo AND ad.linea_id = h.linea_id
               AND ad.numero IS NULL AND ad.origen = 'csv') <= 1;

    -- b) "primera vez" repetidas: se conserva la primera por (asociado, línea, campo, valor)
    DELETE FROM asociado_descuentos_historial h
     USING (
       SELECT id, ROW_NUMBER() OVER (
                PARTITION BY asociado_codigo, linea_id, campo, valor_nuevo
                ORDER BY changed_at, id
              ) AS rn
         FROM asociado_descuentos_historial
        WHERE numero IS NULL AND campo <> 'is_active' AND valor_anterior IS NULL
     ) r
     WHERE h.id = r.id AND r.rn > 1;

    -- c) "primera vez" en cero de campos de obligación en cuotas que no tienen obligación
    DELETE FROM asociado_descuentos_historial
     WHERE numero IS NULL AND valor_anterior IS NULL AND coalesce(valor_nuevo, 0) = 0
       AND campo IN ('valor_obligacion', 'saldo_credito', 'tasa_interes', 'num_cuotas');
  `);
};

exports.down = () => {
  // Irreversible: eran entradas generadas por el error, no información.
};
