import { codigoDane, crearIndice, normDane } from '../../src/modules/rpa/services/divipola.js';

describe('DIVIPOLA — ciudad + departamento → código DANE', () => {
  test('La Virginia, Risaralda = 66400 (código confirmado en SOLIDO)', () => {
    expect(codigoDane('La Virginia', 'Risaralda')).toBe('66400');
    expect(codigoDane('LA VIRGINIA', 'risaralda')).toBe('66400');
  });

  test('tolera tildes, mayúsculas, espacios y "(depto)" en el texto', () => {
    expect(codigoDane('  Pereira ', 'Risaralda')).toBe('66001');
    expect(codigoDane('Pereira (Risaralda)', 'Risaralda')).toBe('66001');
    expect(codigoDane('Medellín', 'Antioquia')).toBe('05001');
    expect(codigoDane('medellin', 'ANTIOQUIA')).toBe('05001');
  });

  test('Bogotá se resuelve con cualquier escritura y aunque falte o sobre el departamento', () => {
    for (const c of ['Bogotá', 'Bogota D.C.', 'BOGOTÁ, D.C.', 'bogota']) expect(codigoDane(c, 'Bogotá D.C.')).toBe('11001');
    expect(codigoDane('Bogotá', '')).toBe('11001');
  });

  test('San Andrés y Providencia (el departamento se llama distinto en Kernel)', () => {
    expect(codigoDane('San Andrés', 'San Andrés y Providencia')).toBe('88001');
    expect(codigoDane('Providencia', 'San Andrés y Providencia')).toBe('88564');
    expect(codigoDane('San Andrés', 'Santander')).toBe('68669');   // otro San Andrés, en otro departamento
  });

  test('nombre corto contenido en el oficial, dentro del mismo departamento', () => {
    expect(codigoDane('Tumaco', 'Nariño')).toBe('52835');           // "San Andrés de Tumaco"
  });

  test('homónimos: exige departamento; sin él no adivina', () => {
    expect(codigoDane('San Andrés', '')).toBeNull();                 // hay varios en el país
    expect(codigoDane('Riosucio', 'Caldas')).not.toBeNull();
    expect(codigoDane('Riosucio', '')).toBeNull();                   // Caldas y Chocó
  });

  test('sin departamento pero único en el país: lo resuelve', () => {
    expect(codigoDane('Dosquebradas', '')).toBe('66170');
  });

  test('ciudad inexistente o vacía → null (queda como "sin equivalencia" para una persona)', () => {
    expect(codigoDane('Ciudad Inventada', 'Risaralda')).toBeNull();
    expect(codigoDane('', 'Risaralda')).toBeNull();
    expect(codigoDane(null, null)).toBeNull();
  });

  test('ciudad que existe pero en OTRO departamento → null, no el código equivocado', () => {
    expect(codigoDane('La Virginia', 'Antioquia')).toBeNull();
  });

  test('todos los departamentos de la lista de Kernel se reconocen', () => {
    const deptos = ['Amazonas', 'Antioquia', 'Arauca', 'Atlántico', 'Bogotá D.C.', 'Bolívar', 'Boyacá', 'Caldas', 'Caquetá',
      'Casanare', 'Cauca', 'Cesar', 'Chocó', 'Córdoba', 'Cundinamarca', 'Guainía', 'Guaviare', 'Huila',
      'La Guajira', 'Magdalena', 'Meta', 'Nariño', 'Norte de Santander', 'Putumayo', 'Quindío', 'Risaralda',
      'San Andrés y Providencia', 'Santander', 'Sucre', 'Tolima', 'Valle del Cauca', 'Vaupés', 'Vichada'];
    const capitales = { Amazonas: 'Leticia', Arauca: 'Arauca', Caquetá: 'Florencia', Casanare: 'Yopal', Guainía: 'Inírida',
      Guaviare: 'San José del Guaviare', Putumayo: 'Mocoa', Vaupés: 'Mitú', Vichada: 'Puerto Carreño', Cesar: 'Valledupar',
      'Valle del Cauca': 'Cali', Quindío: 'Armenia', Tolima: 'Ibagué', Huila: 'Neiva', Caldas: 'Manizales', Sucre: 'Sincelejo',
      Córdoba: 'Montería', Bolívar: 'Cartagena de Indias', Atlántico: 'Barranquilla', Magdalena: 'Santa Marta', 'La Guajira': 'Riohacha',
      'Norte de Santander': 'Cúcuta', Santander: 'Bucaramanga', Boyacá: 'Tunja', Cundinamarca: 'Zipaquirá', Meta: 'Villavicencio',
      Nariño: 'Pasto', Cauca: 'Popayán', Chocó: 'Quibdó', Antioquia: 'Medellín', Risaralda: 'Pereira',
      'San Andrés y Providencia': 'San Andrés', 'Bogotá D.C.': 'Bogotá' };
    for (const d of deptos) expect([d, codigoDane(capitales[d], d)]).toEqual([d, expect.stringMatching(/^\d{5}$/)]);
  });

  test('normDane es idempotente y el índice acepta filas propias', () => {
    expect(normDane('Bogotá, D.C.')).toBe('bogota');
    expect(normDane(normDane('San Andrés de Tumaco'))).toBe('san andres de tumaco');
    const idx = crearIndice([['66400', 'LA VIRGINIA', '66', 'RISARALDA']]);
    expect(idx('la virginia', 'Risaralda')).toBe('66400');
  });
});
