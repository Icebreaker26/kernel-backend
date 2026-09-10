/**
 * Parser para el formato PWXL que exporta Bancolombia en sus extractos.
 * El archivo tiene extensión .xls pero es texto plano con sintaxis propia.
 *
 * Formato de celda: C;[Y{fila};]X{col};K"{valor}"
 *   - Y indica nueva fila (si no aparece, continúa en la misma)
 *   - X indica columna (1-10)
 *   - K indica el valor (siempre entre comillas dobles)
 *
 * Columnas del banco:
 *   X1  Fecha Saldo          — fecha del día (grupos diarios)
 *   X2  Fecha Transacción    — fecha real de la transacción
 *   X3  Descripción          — texto del tipo de operación
 *   X4  Valor                — monto (+ ingreso / - egreso)
 *   X5  Saldo                — solo en filas SALDO INICIAL/FINAL
 *   X6  Regional/Oficina     — código numérico de oficina
 *   X7  Tipo Transacción     — código alfanumérico (N109, N209…)
 *   X8  Oficina              — nombre legible de la oficina
 *   X9  Ref. Titular Cuenta  — ID único de la transacción ← clave de deduplicación
 *   X10 Detalles Adicionales — texto libre con info del beneficiario / lote
 */

const SALDO_TAGS = ['SALDO INICIAL', 'SALDO FINAL'];

/**
 * Parsea el contenido raw (string latin-1) de un extracto PWXL de Bancolombia.
 * @param {string} raw  Contenido del archivo como string (ya decodificado a UTF-8 o latin-1)
 * @returns {{ transacciones: object[], saldos: object[] }}
 */
export function parseBancolombiaPwxl(raw) {
  const rowMap = {};
  let currentY = null;

  for (const line of raw.split('\n')) {
    const m = line.match(/^C;(?:Y(\d+);)?X(\d+);K"(.*)"/);
    if (!m) continue;

    if (m[1] !== undefined) currentY = Number(m[1]);
    if (currentY === null) continue;

    const col = Number(m[2]);
    const val = m[3].trim();

    if (!rowMap[currentY]) rowMap[currentY] = {};
    rowMap[currentY][col] = val;
  }

  const transacciones = [];
  const saldos = [];

  for (const [yStr, cells] of Object.entries(rowMap)) {
    const y = Number(yStr);
    if (y <= 2) continue; // fila 1 = título, fila 2 = encabezados

    const desc = cells[3] || '';

    if (SALDO_TAGS.includes(desc)) {
      saldos.push({
        tipo:  desc === 'SALDO INICIAL' ? 'inicial' : 'final',
        fecha: parseFecha(cells[1] || ''),
        monto: parseFloat(cells[5]) || 0,
      });
      continue;
    }

    const valorRaw = parseFloat(cells[4]) || 0;
    if (valorRaw === 0) continue; // fila sin monto real

    transacciones.push({
      fecha:               parseFecha(cells[2] || cells[1] || ''),
      descripcion:         desc || null,
      monto:               Math.abs(valorRaw),
      tipo_movimiento:     valorRaw >= 0 ? 'ingreso' : 'egreso',
      tipo_bancario:       cells[7] || null,
      oficina_bancaria:    cells[8] || null,
      referencia_bancaria: cells[9] || null,
      detalles_banco:      cells[10] || null,
    });
  }

  return { transacciones, saldos };
}

/** Convierte "DD/MM/YYYY" → "YYYY-MM-DD". Devuelve null si no parsea. */
function parseFecha(str) {
  const m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}
