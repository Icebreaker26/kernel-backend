import crypto from 'crypto';

// JSON con las claves ordenadas: el mismo contenido da siempre la misma cadena (y el mismo hash), sin importar el orden en que
// las devuelva la base de datos. Así un perito puede recalcular el hash a partir del snapshot guardado.
export const canonicalizar = (valor) => {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor === undefined ? null : valor);
  if (valor instanceof Date) return JSON.stringify(valor.toISOString());
  if (Array.isArray(valor)) return `[${valor.map(canonicalizar).join(',')}]`;
  const claves = Object.keys(valor).filter((k) => valor[k] !== undefined).sort();
  return `{${claves.map((k) => `${JSON.stringify(k)}:${canonicalizar(valor[k])}`).join(',')}}`;
};

export const sha256 = (dato) => crypto.createHash('sha256').update(dato).digest('hex');
