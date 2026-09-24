import { PDFDocument, PDFArray, degrees, decodePDFRawStream } from 'pdf-lib';
import { armarPdfFinal, ordenarDocumentos, rangoDocumento, sellosAplicables, dimensionesVisibles, SELLO_ANCHO, SELLO_ASPECTO } from '../../src/modules/cartera/services/pdfFinal.js';
import { calcularDesembolso, aCsv } from '../../src/modules/cartera/services/cierreService.js';
import { cierreSchema, mesSchema, tarifaSchema } from '../../src/modules/cartera/schemas/carteraSchema.js';

// Un PDF de `n` páginas, cada una con un texto que la identifica
const hexTexto = (t) => Buffer.from(t, 'latin1').toString('hex').toUpperCase();
const crearPdf = async (n, { rotar = 0, tam = [400, 600] } = {}) => {
  const d = await PDFDocument.create();
  for (let i = 0; i < n; i++) { const p = d.addPage(tam); if (rotar) p.setRotation(degrees(rotar)); }
  return d.save();
};
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const solicitud = { radicado: 'CR-2026-000001', modalidad_firma: 'externa' };
const cierre = (extra = {}) => ({
  con_aval: true, aval_porcentaje: '10.00', aval_valor: '500000', firma_electronica_valor: '15000', desembolso_neto: '4485000',
  sellos: { aval: { pagina: 0, x: 0.1, y: 0.1 }, firma: { pagina: 0, x: 0.1, y: 0.3 }, desembolso: { pagina: 0, x: 0.1, y: 0.5 } }, ...extra,
});
const entrada = async (nombre, paginas, extra = {}) => ({ nombre, tipo: 'x', clase: 'firmado', origen: 'documento', mime: 'application/pdf', bytes: await crearPdf(paginas), ...extra });
// pdf-lib comprime los flujos de contenido: se recorre cada página y se descomprime lo que dibujó
const contenidoPorPagina = async (bytes) => {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => {
    const c = p.node.Contents();
    const flujos = c instanceof PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c];
    return flujos.filter(Boolean).map((f) => Buffer.from(decodePDFRawStream(f).decode()).toString('latin1')).join('\n');
  });
};
const contenido = async (bytes) => (await contenidoPorPagina(bytes)).join('\n');

describe('Cartera — Cálculo del desembolso', () => {
  test('sin aval ni firma externa el neto es el monto', () => {
    expect(calcularDesembolso({ monto: 5000000, conAval: false, externa: false, tarifa: 15000 })).toEqual({ aval: 0, firma: 0, neto: 5000000 });
  });
  test('el aval es un porcentaje del monto a desembolsar', () => {
    expect(calcularDesembolso({ monto: 5000000, conAval: true, porcentaje: 10, externa: false, tarifa: 0 })).toEqual({ aval: 500000, firma: 0, neto: 4500000 });
    expect(calcularDesembolso({ monto: 3333333, conAval: true, porcentaje: 3.5, externa: false, tarifa: 0 }).aval).toBe(116666.66);
  });
  test('la firma electrónica se resta solo si fue con proveedor externo', () => {
    expect(calcularDesembolso({ monto: 1000000, conAval: false, externa: true, tarifa: 12000 })).toEqual({ aval: 0, firma: 12000, neto: 988000 });
    expect(calcularDesembolso({ monto: 1000000, conAval: false, externa: false, tarifa: 12000 }).firma).toBe(0);
  });
  test('aval y firma se restan los dos', () => {
    expect(calcularDesembolso({ monto: 5000000, conAval: true, porcentaje: 10, externa: true, tarifa: 15000 }).neto).toBe(4485000);
  });
  test('rechaza descuentos que superan el monto', () => {
    expect(() => calcularDesembolso({ monto: 10000, conAval: false, externa: true, tarifa: 15000 })).toThrow(/superan/);
  });
});

describe('Cartera — Orden del PDF final', () => {
  test('el comprobante y el estudio van primero; luego lo firmado por el asesor; autorización; adjuntos; evidencia', () => {
    const t = (n) => new Date(2026, 0, n);
    const desordenados = [
      { id: 'ev', clase: 'evidencia_externa', tipo: 'pagare', created_at: t(1) },
      { id: 'desp', clase: 'adjunto', tipo: 'desprendible_nomina', created_at: t(2) },
      { id: 'pag', clase: 'firmado', tipo: 'pagare', created_at: t(3) },
      { id: 'aut', clase: 'autorizacion', origen: 'autorizacion', tipo: 'soporte', created_at: t(4) },
      { id: 'est', clase: 'firmado', tipo: 'formato_estudio_credito', created_at: t(5) },
      { id: 'sol', clase: 'firmado', tipo: 'solicitud_credito', created_at: t(6) },
      { id: 'cert', clase: 'adjunto', tipo: 'certificado_bancario', created_at: t(7) },
      { id: 'com', clase: 'firmado', tipo: 'comprobante_aprobacion', created_at: t(8) },
      { id: 'lib', clase: 'firmado', tipo: 'libranza', created_at: t(9) },
      { id: 'car', clase: 'firmado', tipo: 'carta_instrucciones', created_at: t(10) },
      { id: 'pro', clase: 'firmado', tipo: 'proyeccion', created_at: t(11) },
      { id: 'otro', clase: 'adjunto', tipo: 'otro_adjunto', created_at: t(12) },
    ];
    expect(ordenarDocumentos(desordenados).map((d) => d.id)).toEqual(['com', 'est', 'sol', 'lib', 'pag', 'car', 'pro', 'aut', 'desp', 'cert', 'otro', 'ev']);
  });
  test('a igual rango se conserva el orden de creación y no se altera la lista original', () => {
    const l = [{ id: 'b', clase: 'firmado', tipo: 'pagare', created_at: new Date(2026, 1, 2) }, { id: 'a', clase: 'firmado', tipo: 'pagare', created_at: new Date(2026, 1, 1) }];
    expect(ordenarDocumentos(l).map((d) => d.id)).toEqual(['a', 'b']);
    expect(l[0].id).toBe('b');
  });
  test('un tipo desconocido cae en su grupo y no rompe', () => {
    expect(rangoDocumento({ clase: 'firmado', tipo: 'raro' })).toBe(15);
    expect(rangoDocumento({ clase: 'nada', tipo: 'x' })).toBe(99);
  });
});

describe('Cartera — Sellos aplicables', () => {
  test('el sello de aval solo con aval; el de firma solo con proveedor externo; el desembolso siempre', () => {
    expect(sellosAplicables({ con_aval: true }, { modalidad_firma: 'externa' })).toEqual(['aval', 'firma', 'desembolso']);
    expect(sellosAplicables({ con_aval: false }, { modalidad_firma: 'externa' })).toEqual(['firma', 'desembolso']);
    expect(sellosAplicables({ con_aval: true }, { modalidad_firma: 'presencial' })).toEqual(['aval', 'desembolso']);
    expect(sellosAplicables(null, { modalidad_firma: 'presencial' })).toEqual(['desembolso']);
  });
});

describe('Cartera — PDF final', () => {
  test('une todas las páginas en el orden recibido', async () => {
    const r = await armarPdfFinal([await entrada('a.pdf', 2, { comprobante: true }), await entrada('b.pdf', 3), await entrada('c.pdf', 1)], cierre(), solicitud);
    expect(r.paginas).toBe(6);
    expect(r.omitidos).toEqual([]);
    expect((await PDFDocument.load(r.bytes)).getPageCount()).toBe(6);
  });

  test('estampa los tres sellos con sus textos y valores en el comprobante', async () => {
    const r = await armarPdfFinal([await entrada('comprobante.pdf', 1, { comprobante: true })], cierre(), solicitud);
    const txt = await contenido(r.bytes);
    for (const t of ['AVAL FONDO REGIONAL', '10% · $500.000', 'FIRMA ELECTRONICA', '$15.000', 'DESEMBOLSO', '$4.485.000']) {
      expect(txt).toContain(hexTexto(t));
    }
  });

  test('no estampa el sello de aval si el crédito no lleva aval, ni el de firma si no fue externa', async () => {
    const r = await armarPdfFinal([await entrada('c.pdf', 1, { comprobante: true })], cierre({ con_aval: false }), { ...solicitud, modalidad_firma: 'presencial' });
    const txt = await contenido(r.bytes);
    expect(txt).not.toContain(hexTexto('AVAL FONDO REGIONAL'));
    expect(txt).not.toContain(hexTexto('FIRMA ELECTRONICA'));
    expect(txt).toContain(hexTexto('DESEMBOLSO'));
  });

  test('los sellos solo van en el comprobante, no en los demás documentos', async () => {
    const r = await armarPdfFinal([await entrada('otro.pdf', 1), await entrada('comprobante.pdf', 1, { comprobante: true })], cierre(), solicitud);
    const paginas = await contenidoPorPagina(r.bytes);
    expect(paginas).toHaveLength(2);
    expect(paginas[0]).not.toContain(hexTexto('DESEMBOLSO'));
    expect(paginas[1]).toContain(hexTexto('DESEMBOLSO'));
  });

  test('el sello queda dentro de la página aunque la posición guardada se salga', async () => {
    const c = cierre({ sellos: { aval: { pagina: 0, x: 0.99, y: 0.99 }, firma: { pagina: 0, x: 0, y: 0 }, desembolso: { pagina: 0, x: 0.5, y: 0.5 } } });
    await expect(armarPdfFinal([await entrada('c.pdf', 1, { comprobante: true })], c, solicitud)).resolves.toBeTruthy();
  });

  test.each([90, 180, 270])('funciona con una página del comprobante rotada %i°', async (grados) => {
    const bytes = await crearPdf(1, { rotar: grados });
    const r = await armarPdfFinal([{ nombre: 'c.pdf', tipo: 'comprobante_aprobacion', mime: 'application/pdf', bytes, comprobante: true }], cierre(), solicitud);
    expect(await contenido(r.bytes)).toContain(hexTexto('DESEMBOLSO'));
    const dim = dimensionesVisibles((await PDFDocument.load(r.bytes)).getPage(0));
    expect(dim.R).toBe(grados);
  });

  test('un sello en una página que no existe hace fallar el PDF (no se entrega un comprobante mal sellado)', async () => {
    const c = cierre({ sellos: { aval: { pagina: 3, x: 0.1, y: 0.1 }, firma: { pagina: 0, x: 0.1, y: 0.3 }, desembolso: { pagina: 0, x: 0.1, y: 0.5 } } });
    await expect(armarPdfFinal([await entrada('c.pdf', 1, { comprobante: true })], c, solicitud)).rejects.toThrow(/página que no existe/);
  });

  test('las imágenes se convierten en una página', async () => {
    const r = await armarPdfFinal([await entrada('c.pdf', 1, { comprobante: true }), { nombre: 'desprendible.png', tipo: 'desprendible_nomina', mime: 'image/png', bytes: PNG_1X1 }], cierre(), solicitud);
    expect(r.paginas).toBe(2);
  });

  test('un documento dañado no tumba el PDF: deja una hoja que lo avisa y se reporta', async () => {
    const r = await armarPdfFinal([await entrada('c.pdf', 1, { comprobante: true }), { nombre: 'roto.pdf', tipo: 'otro', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4 esto no es un pdf') }], cierre(), solicitud);
    expect(r.omitidos).toEqual(['roto.pdf']);
    expect(r.paginas).toBe(2);
  });

  test('si el comprobante mismo está dañado, falla', async () => {
    await expect(armarPdfFinal([{ nombre: 'c.pdf', tipo: 'comprobante_aprobacion', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4 roto'), comprobante: true }], cierre(), solicitud)).rejects.toThrow();
  });

  test('los sellos tienen un tamaño fijo relativo a la página (la vista previa y el PDF coinciden)', () => {
    expect(SELLO_ANCHO).toBe(0.3);
    expect(SELLO_ASPECTO).toBe(3.2);
  });
});

describe('Cartera — CSV de los planos', () => {
  const cols = [{ campo: 'a', titulo: 'A' }, { campo: 'b', titulo: 'B' }];
  test('usa ; como separador, CRLF y BOM UTF-8 para abrirse bien en Excel', () => {
    const csv = aCsv(cols, [{ a: 'uno', b: 2 }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('A;B\r\nuno;2\r\n');
  });
  test('cita las celdas con ; comillas o saltos de línea', () => {
    expect(aCsv(cols, [{ a: 'x;y', b: 'dice "hola"' }])).toContain('"x;y";"dice ""hola"""');
  });
  test('neutraliza las fórmulas (=, +, @) pero no los números negativos', () => {
    const csv = aCsv(cols, [{ a: '=CMD()', b: -5 }]);
    expect(csv).toContain("'=CMD()");
    expect(csv).toContain(';-5');
  });
  test('formatea fechas y celdas vacías', () => {
    expect(aCsv(cols, [{ a: new Date('2026-09-05T12:00:00Z'), b: null }])).toContain('2026-09-05;\r\n');
  });
});

describe('Cartera — Validación (Zod)', () => {
  test('el aval exige porcentaje', () => {
    expect(cierreSchema.safeParse({ con_aval: true }).success).toBe(false);
    expect(cierreSchema.safeParse({ con_aval: true, aval_porcentaje: 0 }).success).toBe(false);
    expect(cierreSchema.safeParse({ con_aval: true, aval_porcentaje: 101 }).success).toBe(false);
    expect(cierreSchema.safeParse({ con_aval: true, aval_porcentaje: 12.5 }).success).toBe(true);
    expect(cierreSchema.safeParse({ con_aval: false }).success).toBe(true);
  });
  test('los sellos son fracciones dentro de la página y rechaza campos extra', () => {
    const ok = { con_aval: false, sellos: { desembolso: { pagina: 0, x: 0.2, y: 0.8 } } };
    expect(cierreSchema.safeParse(ok).success).toBe(true);
    expect(cierreSchema.safeParse({ ...ok, sellos: { desembolso: { pagina: 0, x: 1.2, y: 0.8 } } }).success).toBe(false);
    expect(cierreSchema.safeParse({ ...ok, sellos: { desembolso: { pagina: -1, x: 0.2, y: 0.8 } } }).success).toBe(false);
    expect(cierreSchema.safeParse({ ...ok, sellos: { otro: { pagina: 0, x: 0.2, y: 0.8 } } }).success).toBe(false);
    expect(cierreSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
  test('el mes es AAAA-MM válido', () => {
    expect(mesSchema.safeParse({ mes: '2026-09' }).success).toBe(true);
    expect(mesSchema.safeParse({ mes: '2026-13' }).success).toBe(false);
    expect(mesSchema.safeParse({ mes: '2026-9' }).success).toBe(false);
    expect(mesSchema.safeParse({ mes: '2026-09', formato: 'xml' }).success).toBe(false);
  });
  test('la tarifa no puede ser negativa', () => {
    expect(tarifaSchema.safeParse({ valor: 0 }).success).toBe(true);
    expect(tarifaSchema.safeParse({ valor: -1 }).success).toBe(false);
  });
});
