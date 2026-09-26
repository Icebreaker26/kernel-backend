import { normalizarNumeros, valoresFueraDeRango, parsearCSV } from '../../src/modules/asociados/controllers/asociadosController.js';

const fila = (extra = {}) => ({ codigo: '1', linea: '1', apellido: 'A', nombre: 'B', cuota: '37000', saldo: '0', tasa_interes: '0', valor_obligacion: '0', ...extra });

describe('normalizarNumeros — formato de los números del CSV', () => {
  test('el flexible del PC de SOLIDO (punto decimal) se lleva a coma decimal', () => {
    const rs = [fila({ tasa_interes: '2.1881', saldo: '-2795048.89', cuota: '37000' }), fila({ tasa_interes: '1.5', saldo: '0' })];
    expect(normalizarNumeros(rs)).toBe('punto_decimal');
    expect(rs[0]).toMatchObject({ tasa_interes: '2,1881', saldo: '-2795048,89', cuota: '37000' });
    expect(rs[1].tasa_interes).toBe('1,5');
  });

  test('un decimal de 3 cifras ("1.415") se entiende como decimal si el archivo usa punto decimal', () => {
    const rs = [fila({ tasa_interes: '1.5' }), fila({ tasa_interes: '1.415' })];
    normalizarNumeros(rs);
    expect(rs[1].tasa_interes).toBe('1,415');
  });

  test('el formato de Kernel (coma decimal) no se toca', () => {
    const rs = [fila({ saldo: '-2795048,89', tasa_interes: '2,14' })];
    expect(normalizarNumeros(rs)).toBe('coma_decimal');
    expect(rs[0]).toMatchObject({ saldo: '-2795048,89', tasa_interes: '2,14' });
  });

  test('el formato antiguo con miles ("1.234.567,89") tampoco se toca', () => {
    const rs = [fila({ saldo: '1.234.567,89', cuota: '1.500' })];
    expect(normalizarNumeros(rs)).toBe('coma_decimal');
    expect(rs[0]).toMatchObject({ saldo: '1.234.567,89', cuota: '1.500' });
  });

  test('un archivo solo con enteros no cambia (y "1.500" suelto sigue siendo mil quinientos)', () => {
    const rs = [fila({ cuota: '37000' }), fila({ cuota: '1.500' })];
    expect(normalizarNumeros(rs)).toBe('sin_decimales');
    expect(rs[1].cuota).toBe('1.500');
  });

  test('solo se tocan las columnas numéricas: direcciones y nombres con puntos quedan igual', () => {
    const rs = [fila({ direccion: 'CL 12.5 # 3.2', nombre: 'J. PEREZ', tasa_interes: '2.14' })];
    normalizarNumeros(rs);
    expect(rs[0]).toMatchObject({ direccion: 'CL 12.5 # 3.2', nombre: 'J. PEREZ', tasa_interes: '2,14' });
  });
});

describe('valoresFueraDeRango — lo que no cabe en la base de datos', () => {
  test('un archivo normal no tiene nada fuera de rango', () => {
    expect(valoresFueraDeRango([fila({ saldo: '-407000', tasa_interes: '3,14' })])).toEqual([]);
  });

  test('tasa_interes ≥ 10.000 (el caso "2.1881" leído como 21881) se detecta con asociado, columna y valor', () => {
    const fuera = valoresFueraDeRango([fila({ codigo: '1125315', linea: '1004', tasa_interes: '21881', numero: '9' })]);
    expect(fuera).toEqual([expect.objectContaining({ codigo: '1125315', columna: 'tasa_interes', valor_csv: '21881', destino: 'asociado_descuentos.tasa_interes', maximo: 1e4 })]);
  });

  test('cuota de la línea 1 ≥ 100 millones no cabe en valor_aporte; saldo ≥ 10.000 millones no cabe en saldo_aporte', () => {
    const fuera = valoresFueraDeRango([fila({ cuota: '100000000', saldo: '12000000000' })]);
    expect(fuera.map((f) => f.destino)).toEqual(expect.arrayContaining(['asociados.valor_aporte', 'asociados.saldo_aporte']));
  });

  test('líneas que el importador no usa no cuentan', () => {
    expect(valoresFueraDeRango([fila({ linea: '99999', tasa_interes: '999999' })])).toEqual([]);
  });
});

describe('parsearCSV — de punta a punta con el formato del PC de SOLIDO', () => {
  const CSV_PC = '﻿codigo;linea;numero;apellido;nombre;cuota;saldo;tasa_interes;valor_obligacion;plazo\n' +
    '1125315;1;0;MOYA;FELIX;37000;-2795048.89;0;0;0\n' +
    '1125315;1004;9;MOYA;FELIX;150000;450000.5;2.1881;5000000;12\n';
  test('con BOM, punto y coma y punto decimal: se detecta el formato y nada queda fuera de rango', () => {
    const r = parsearCSV(Buffer.from(CSV_PC, 'utf8'));
    expect(r.formatoNumerico).toBe('punto_decimal');
    expect(r.validos).toHaveLength(1);
    expect(r.validos[0]).toMatchObject({ cuota: 37000, saldo: -2795048.89 });
    expect(valoresFueraDeRango(r.registros)).toEqual([]);
    expect(r.registros[1].tasa_interes).toBe('2,1881');
  });
});
