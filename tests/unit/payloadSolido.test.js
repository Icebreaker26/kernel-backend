import { construirPayload, mayus, norm, llaveCiudad, REGLAS_FIJAS } from '../../src/modules/rpa/services/payloadSolido.js';

const EQ = {
  'ciudad|pereira|risaralda': '66001', 'ciudad|dosquebradas': '66170',
  'profesion|operario': '712', 'empresa|emp-1': '0101',
};
const eq = (cat, texto, depto) => {
  if (cat === 'ciudad') return EQ[`ciudad|${llaveCiudad(texto, depto)}`] ?? EQ[`ciudad|${norm(texto)}`] ?? null;
  return EQ[`${cat}|${norm(texto)}`] ?? null;
};

const p = { cedula: '1000000001', nombres: 'María José', apellidos: 'Peña Núñez', celular: '3101112233', correo: 'Maria@Correo.com', empresa_codigo: 'EMP-1', empresa_nombre: 'Empresa Uno' };
const v = {
  direccion_residencia: 'Calle 1 # 2-3', ciudad_residencia: 'Pereira', departamento_residencia: 'Risaralda',
  genero: 'F', fecha_nacimiento: '1990-05-10', tipo_documento: 'CC', fecha_expedicion: '2008-06-01', ciudad_expedicion: 'Dosquebradas',
  ciudad_nacimiento: 'Pereira', departamento_nacimiento: 'Risaralda', estado_civil: 'soltero', estrato: 3,
  profesion: 'Operario', cargo: 'Cargo sin equivalencia', ciudad_trabajo: 'Dosquebradas',
  ingresos_mensuales: 2000000, egresos_mensuales: 1500000, total_pasivos: 300000, total_activos: 5000000,
  periodicidad_descuento: 'quincenal', valor_aporte: 80000, fecha_ingreso: '2020-01-15',
};
const base = { v, p, asesorCedula: '52111222', eq, hoy: '2026-09-25' };

describe('payloadSolido — reglas fijas', () => {
  const { payload, faltantes } = construirPayload(base);

  test('un caso completo no tiene faltantes (el cargo sin equivalencia es opcional)', () => {
    expect(faltantes).toEqual([]);
  });

  test('Página 1: reglas fijas de la cooperativa', () => {
    expect(payload.pagina1).toMatchObject({
      tipo_correo: 'EXTERNO', ciiu: '10', pais_nacimiento: '54', clase: 'ASOCIADO', clase_dscto: 'Nomina',
      grupo_etnico: 'NINGUNO', factura: 'NO', direccion_envio: 'email', asesor: '52111222',
    });
  });

  test('Página 2: tipo salario, código interno = cédula, jornada Total, envío Casa', () => {
    expect(payload.pagina2).toMatchObject({
      tipo_salario: '2- ley 50', codigo_interno: '1000000001', jornada_laboral: 'Total', direccion_envio: 'Casa',
    });
  });

  test('Página 3 solo lleva egresos y deudas a terceros', () => {
    expect(Object.keys(payload.pagina3).sort()).toEqual(['deudas_terceros', 'egresos']);
    expect(payload.pagina3).toEqual({ egresos: 1500000, deudas_terceros: 300000 });
  });

  test('Página 4: segmento 001', () => {
    expect(payload.pagina4).toEqual({ segmento: '001' });
  });

  test('cabecera: código = cédula, nombres en mayúsculas conservando la Ñ y quitando tildes', () => {
    expect(payload.cabecera).toEqual({ codigo: '1000000001', apellido: 'PEÑA NUÑEZ', nombre: 'MARIA JOSE' });
  });

  test('catálogos: ciudad de envío = ciudad; periodo según periodicidad; fecha de ingreso = hoy; email en minúsculas', () => {
    expect(payload.pagina1).toMatchObject({
      ciudad: '66001', ciudad_nacimiento: '66001', periodo_dcto: 'Quincenal',
      fecha_ingreso: '2026-09-25', email: 'maria@correo.com', empresa: '0101', clase_dscto: 'Nomina',
    });
    expect(payload.pagina2).toMatchObject({ ciudad: '66170' });
  });

  test('como el asociado de referencia: ciudad de envío, profesión y cargo NO se tocan (quedan en 9999/999999)', () => {
    expect(payload.pagina1.ciudad_envio).toBeNull();
    expect(payload.pagina2.profesion).toBeNull();
    expect(payload.pagina2.cargo).toBeNull();
  });

  test('el aporte va como informativo (no se digita)', () => {
    expect(payload.informativo).toMatchObject({ valor_aporte: 80000, periodicidad_descuento: 'quincenal' });
  });
});

describe('payloadSolido — faltantes', () => {
  test('texto sin equivalencia se reporta con catálogo y texto', () => {
    const { faltantes, payload } = construirPayload({ ...base, v: { ...v, ciudad_residencia: 'Atlantis', departamento_residencia: null } });
    expect(faltantes).toContainEqual({ campo: 'ciudad', motivo: 'sin_equivalencia', catalogo: 'ciudad', texto: 'Atlantis', departamento: null });
    expect(payload.pagina1.ciudad).toBeNull();
  });

  test('una profesión o un cargo sin equivalencia ya no detienen la carga', () => {
    const { faltantes } = construirPayload({ ...base, v: { ...v, profesion: 'Astronauta', cargo: 'Capitán' } });
    expect(faltantes).toEqual([]);
  });

  test('sin cédula de asesor, sin correo y sin salario', () => {
    const { faltantes } = construirPayload({ ...base, asesorCedula: null, p: { ...p, correo: '' }, v: { ...v, ingresos_mensuales: null } });
    const campos = faltantes.map((f) => f.campo);
    expect(campos).toEqual(expect.arrayContaining(['asesor', 'email', 'salario']));
  });

  test('cédula con letras es inválida', () => {
    const { faltantes } = construirPayload({ ...base, p: { ...p, cedula: '12A45' } });
    expect(faltantes.map((f) => f.campo)).toContain('cedula');
  });

  test('sin periodicidad no se inventa el periodo de descuento', () => {
    const { faltantes } = construirPayload({ ...base, v: { ...v, periodicidad_descuento: null } });
    expect(faltantes.map((f) => f.campo)).toContain('periodo_dcto');
  });

  test('la ciudad homónima se resuelve por departamento y, si no hay, por el nombre solo', () => {
    const { payload } = construirPayload({ ...base, v: { ...v, ciudad_residencia: 'Dosquebradas', departamento_residencia: 'Risaralda' } });
    expect(payload.pagina1.ciudad).toBe('66170');
  });
});

describe('payloadSolido — empresa y clase de descuento', () => {
  test('sin equivalencia de la empresa: 0010 Particulares y descuento por Caja', () => {
    const { payload, faltantes } = construirPayload({ ...base, p: { ...p, empresa_codigo: 'EMP-NUEVA' } });
    expect(faltantes).toEqual([]);
    expect(payload.pagina1).toMatchObject({ empresa: '0010', clase_dscto: 'Caja' });
    expect(payload.informativo.empresa_origen).toBe('por_defecto');
  });
  test('con equivalencia: su código y descuento por Nómina', () => {
    const { payload } = construirPayload(base);
    expect(payload.pagina1).toMatchObject({ empresa: '0101', clase_dscto: 'Nomina' });
    expect(payload.informativo.empresa_origen).toBe('equivalencia');
  });
  test('sin empresa en Kernel también cae a 0010 / Caja', () => {
    const { payload } = construirPayload({ ...base, p: { ...p, empresa_codigo: null } });
    expect(payload.pagina1).toMatchObject({ empresa: '0010', clase_dscto: 'Caja' });
  });
  test('sin ciudad de trabajo se usa la de residencia', () => {
    const { payload, faltantes } = construirPayload({ ...base, v: { ...v, ciudad_trabajo: null, departamento_trabajo: null } });
    expect(faltantes).toEqual([]);
    expect(payload.pagina2.ciudad).toBe('66001');
  });
});

describe('payloadSolido — utilidades', () => {
  test('norm quita tildes y colapsa espacios', () => expect(norm('  Bogotá   D.C. ')).toBe('bogota d.c.'));
  test('mayus conserva la Ñ', () => expect(mayus('ñandú peña')).toBe('ÑANDU PEÑA'));
  test('las reglas fijas están congeladas', () => {
    expect(Object.isFrozen(REGLAS_FIJAS)).toBe(true);
    expect(REGLAS_FIJAS.pais_nacimiento).toBe('54');
  });
});
