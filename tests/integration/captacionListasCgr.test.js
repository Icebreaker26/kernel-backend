/**
 * Boletín de Responsables Fiscales de la Contraloría: se descarga solo (PDF público) y se cruza por cédula.
 */
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { jest } from '@jest/globals';
import pool from '../../src/db/database.js';
import { invalidarCache, cotejar } from '../../src/modules/captacion/listas/cotejo.js';
import { estadoFuentes } from '../../src/modules/captacion/listas/fuentes.js';
import { elegirBoletinMasReciente, parseBoletinCgr } from '../../src/modules/captacion/listas/boletinCgr.js';

jest.setTimeout(30000);

// Un PDF con la misma disposición que el boletín real (columnas medidas sobre el boletín N° 126)
const boletinDePrueba = async () => {
  const pdf = await PDFDocument.create();
  const f = await pdf.embedFont(StandardFonts.Helvetica);
  const p = pdf.addPage([842, 595]);
  const t = (s, x, y) => p.drawText(s, { x, y, size: 8, font: f });
  t('Boletín de Responsables Fiscales N°', 215, 493); t('126 con corte a martes 30 de junio de 2026', 379, 493);
  [['Responsable Fiscal', 67], ['Tipo y Num Docuemento', 173], ['Entidad Afectada', 293], ['TR', 385], ['R', 411], ['Ente que Reporta', 476], ['Departamento', 606], ['Municipio', 692]]
    .forEach(([s, x]) => t(s, x, 473));
  // Empresa (NIT): no se guarda
  t('A.R.O. INGENIEROS', 36, 459); t('NIT 60379299', 171, 459); t('MUNICIPIO DE', 271, 459); t('CONTRALORIA MUNICIPAL', 427, 459); t('SANTANDER', 592, 459);
  // Persona con nombre y entidad en varias líneas
  t('ABADIA CAMPO JUAN', 36, 415); t('CC 6.320.849', 171, 415); t('INDUSTRIA DE LICORES', 271, 415); t('S', 389, 415); t('1', 412, 415);
  t('UNIDAD DE INVESTIGACIONES', 427, 415); t('CUNDINAMARCA', 592, 415); t('BOGOTA, D.C.', 674, 415);
  t('CARLOS', 36, 406); t('DEL VALLE', 271, 406); t('ESPECIALES CONTRA LA CORRUPCION', 427, 406);
  t('ABAUNZA RIVERA JESUS MARIA', 36, 385); t('CC 3546909', 171, 385); t('DIAN - ADUANA', 271, 385); t('GERENCIA DEPARTAMENTAL', 427, 385); t('NARIÑO', 592, 385); t('PASTO', 674, 385);
  t('SIBOR TR=Tipo responsabilidad - I=Individual - S=Solidario', 36, 100);   // pie de la última página
  return Buffer.from(await pdf.save());
};

describe('Contraloría — lectura del boletín', () => {
  test('elige el boletín más reciente entre los enlaces de la página', () => {
    const html = ['Abril-Mayo-Junio 2026', 'Enero-Febrer-Marzo 2026', 'Octubre-Noviembre-Diciembre 2025', 'Abril-Mayo-Junio 2022']
      .map((n, i) => `<a href="javascript:__doPostBack(&#39;ctl00$MainContent$ctl0${i}&#39;,&#39;&#39;)">Boletin Trimestre ${n}.pdf</a>`).join('');
    expect(elegirBoletinMasReciente(html)).toMatchObject({ objetivo: 'ctl00$MainContent$ctl00', nombre: 'Boletin Trimestre Abril-Mayo-Junio 2026.pdf' });
    expect(elegirBoletinMasReciente('<p>sin enlaces</p>')).toBeNull();
  });

  test('extrae personas con cédula (no empresas), con su nombre completo, entidad y ubicación, sin arrastrar el pie de página', async () => {
    const r = await parseBoletinCgr(await boletinDePrueba());
    expect(r.publicada).toBe('Boletín N° 126, corte a martes 30 de junio de 2026');
    expect(r.entradas).toHaveLength(2);
    expect(r.entradas[0]).toMatchObject({
      tipo: 'persona', nombre: 'ABADIA CAMPO JUAN CARLOS', documentos: ['6320849'],
      detalle: { entidad_afectada: 'INDUSTRIA DE LICORES DEL VALLE', ente_que_reporta: 'UNIDAD DE INVESTIGACIONES ESPECIALES CONTRA LA CORRUPCION', departamento: 'CUNDINAMARCA', municipio: 'BOGOTA, D.C.' },
    });
    expect(r.entradas[1]).toMatchObject({ nombre: 'ABAUNZA RIVERA JESUS MARIA', documentos: ['3546909'], detalle: { departamento: 'NARIÑO', municipio: 'PASTO' } });
    expect(JSON.stringify(r.entradas)).not.toContain('SIBOR');
  });
});

describe('Contraloría — cruce por cédula', () => {
  beforeAll(async () => {
    await pool.query(`DELETE FROM listas_versiones`);
    const { rows: [v] } = await pool.query(
      `INSERT INTO listas_versiones (fuente, url, publicada, sha256, bytes, registros, activa) VALUES ('CGR_BOLETIN','https://prueba.test','Boletín N° 126',$1,10,1,true) RETURNING id`, ['a'.repeat(64)]);
    await pool.query(
      `INSERT INTO listas_entradas (version_id, fuente, ref, tipo, nombre, documentos, detalle) VALUES ($1,'CGR_BOLETIN','r1','persona','ABADIA CAMPO JUAN CARLOS','{6320849}',$2)`,
      [v.id, JSON.stringify({ entidad_afectada: 'INDUSTRIA DE LICORES DEL VALLE' })]);
    invalidarCache();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM listas_versiones`);
    invalidarCache();
    await pool.end();
  });

  test('la misma cédula es coincidencia fuerte; el mismo nombre con otra cédula NO (solo se cruza por cédula)', async () => {
    const porCedula = await cotejar({ cedula: '6.320.849', nombres: 'Otro', apellidos: 'Nombre Distinto' });
    expect(porCedula).toHaveLength(1);
    expect(porCedula[0]).toMatchObject({ fuente: 'CGR_BOLETIN', tipo: 'documento', score: 1, nombre: 'ABADIA CAMPO JUAN CARLOS' });
    expect(porCedula[0].detalle.entidad_afectada).toBe('INDUSTRIA DE LICORES DEL VALLE');

    const porNombre = await cotejar({ cedula: '99999999', nombres: 'Juan Carlos', apellidos: 'Abadia Campo' });
    expect(porNombre).toEqual([]);
  });

  test('el boletín es trimestral: se acepta hasta con 14 días sin verificar, las listas diarias solo 3', async () => {
    await pool.query(`UPDATE listas_versiones SET verificada_at = NOW() - INTERVAL '10 days' WHERE fuente = 'CGR_BOLETIN'`);
    const cgr = (await estadoFuentes()).find((f) => f.codigo === 'CGR_BOLETIN');
    expect(cgr).toMatchObject({ disponible: true, desactualizada: false, cotejo: 'documento' });
    await pool.query(`UPDATE listas_versiones SET verificada_at = NOW() - INTERVAL '16 days' WHERE fuente = 'CGR_BOLETIN'`);
    expect((await estadoFuentes()).find((f) => f.codigo === 'CGR_BOLETIN').desactualizada).toBe(true);
  });
});
