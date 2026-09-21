/**
 * Validación de la firma que llega al servidor: dibujada (con trazos) o imagen cargada (sin trazos), siempre un PNG acotado.
 */
import { seccionFirmaSchema } from '../../src/modules/captacion/schemas/captacionSchema.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const base = {
  firma_png: PNG,
  version_consentimiento: 'v1.0', acepta_terminos: true, acepta_firma_electronica: true, version_firma_electronica: 'fe-v1.0',
};
const trazos = [{ x: 10, y: 20, t: 100 }, { x: 15, y: 25, t: 150 }];

describe('Firma — validación del cuerpo', () => {
  test('dibujada con dos o más trazos: válida y es el origen por defecto', () => {
    const r = seccionFirmaSchema.safeParse({ ...base, firma_trazos: trazos });
    expect(r.success).toBe(true);
    expect(r.data.firma_origen).toBe('dibujada');
  });

  test('dibujada sin trazos o con un solo punto: se rechaza', () => {
    expect(seccionFirmaSchema.safeParse({ ...base, firma_trazos: [] }).success).toBe(false);
    expect(seccionFirmaSchema.safeParse({ ...base, firma_trazos: [trazos[0]] }).success).toBe(false);
  });

  test('imagen cargada desde un archivo: válida sin trazos', () => {
    const r = seccionFirmaSchema.safeParse({ ...base, firma_origen: 'imagen', firma_trazos: [] });
    expect(r.success).toBe(true);
    expect(r.data.firma_origen).toBe('imagen');
  });

  test('solo se acepta un PNG y de tamaño acotado', () => {
    expect(seccionFirmaSchema.safeParse({ ...base, firma_trazos: trazos, firma_png: 'data:image/jpeg;base64,/9j/4AAQ' }).success).toBe(false);
    expect(seccionFirmaSchema.safeParse({ ...base, firma_trazos: trazos, firma_png: 'hola' }).success).toBe(false);
    expect(seccionFirmaSchema.safeParse({ ...base, firma_trazos: trazos, firma_png: PNG + 'A'.repeat(1_500_000) }).success).toBe(false);
  });

  test('origen desconocido: se rechaza', () => {
    expect(seccionFirmaSchema.safeParse({ ...base, firma_origen: 'foto', firma_trazos: trazos }).success).toBe(false);
  });
});
