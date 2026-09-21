/**
 * Consulta en listas restrictivas y fuentes abiertas (SARLAFT): la ejecuta el asesor, la valida el Oficial de Cumplimiento,
 * queda una constancia en PDF (S3) anexa al expediente y, si la cooperativa lo exige, condiciona la entrega.
 */
import request from 'supertest';
import bcrypt from 'bcrypt';
import { jest } from '@jest/globals';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import { eliminarArchivo } from '../../src/services/archivoService.js';
import { sha256 } from '../../src/services/hashCanonico.js';
import { invalidarCache } from '../../src/modules/captacion/listas/cotejo.js';
import { normalizar, palabras, compararPalabras } from '../../src/modules/captacion/listas/normalizar.js';
import { parseOnu, parseOfac, parseUe, parseUk, parsePepSigep, parseSiri } from '../../src/modules/captacion/listas/parsers.js';

jest.setTimeout(30000);

// ── Lectores y comparación de nombres (sin base de datos) ────────────────────
describe('Listas — normalización y comparación de nombres', () => {
  test('normaliza tildes, mayúsculas y signos; ignora partículas', () => {
    expect(normalizar('  José-Ángel  de la  Peña ')).toBe('JOSE ANGEL DE LA PENA');
    expect(palabras('José Ángel de la Peña')).toEqual(['JOSE', 'ANGEL', 'PENA']);
  });

  test('compara sin importar el orden (apellidos primero) y tolera una letra distinta', () => {
    const q = palabras('Miguel Angel Rodriguez Orejuela');
    expect(compararPalabras(q, palabras('RODRIGUEZ OREJUELA, Miguel Angel')).score).toBe(1);
    expect(compararPalabras(q, palabras('Rodriguez Orejuela Miguel Anguel')).score).toBeGreaterThan(0.95);
    expect(compararPalabras(q, palabras('Gilberto Rodriguez Orejuela')).score).toBeLessThan(0.85);
  });

  test('contener todas las palabras de un nombre largo de la lista es coincidencia parcial; un nombre corto no', () => {
    const largo = compararPalabras(palabras('Juan Carlos Perez Gomez Ruiz'), palabras('Juan Carlos Perez'));
    expect(largo.parcial).toBe(true);
    expect(largo.score).toBeGreaterThanOrEqual(0.85);
    const corto = compararPalabras(palabras('Juan Carlos Perez Gomez'), palabras('Juan Perez'));
    expect(corto.parcial).toBe(false);
    expect(corto.score).toBeLessThan(0.85);
  });
});

describe('Listas — lectores de cada fuente', () => {
  test('ONU: nombre en 4 partes, alias, nacimiento y cédula estructurada', () => {
    const xml = `<?xml version="1.0"?><CONSOLIDATED_LIST dateGenerated="2026-09-19T23:00:03Z"><INDIVIDUALS>
      <INDIVIDUAL><DATAID>6909558</DATAID><FIRST_NAME>ALVARO</FIRST_NAME><SECOND_NAME>ANDRES</SECOND_NAME><THIRD_NAME>QUIJANO</THIRD_NAME><FOURTH_NAME>BECERRA</FOURTH_NAME>
      <UN_LIST_TYPE>Sudan</UN_LIST_TYPE><REFERENCE_NUMBER>SDi.012</REFERENCE_NUMBER>
      <INDIVIDUAL_ALIAS><QUALITY>Good</QUALITY><ALIAS_NAME>Alvaro Quijano</ALIAS_NAME></INDIVIDUAL_ALIAS>
      <INDIVIDUAL_DATE_OF_BIRTH><TYPE_OF_DATE>EXACT</TYPE_OF_DATE><DATE>1967-07-18</DATE></INDIVIDUAL_DATE_OF_BIRTH>
      <NATIONALITY><VALUE>Colombia</VALUE></NATIONALITY>
      <INDIVIDUAL_DOCUMENT><TYPE_OF_DOCUMENT>National Identification Number</TYPE_OF_DOCUMENT><NUMBER>Cedula No. 80413253 </NUMBER><ISSUING_COUNTRY>Colombia</ISSUING_COUNTRY></INDIVIDUAL_DOCUMENT>
      </INDIVIDUAL></INDIVIDUALS><ENTITIES><ENTITY><DATAID>1</DATAID><FIRST_NAME>EMPRESA X</FIRST_NAME><UN_LIST_TYPE>Al-Qaida</UN_LIST_TYPE></ENTITY></ENTITIES></CONSOLIDATED_LIST>`;
    const r = parseOnu(xml);
    expect(r.publicada).toBe('2026-09-19T23:00:03Z');
    expect(r.entradas).toHaveLength(2);
    expect(r.entradas[0]).toMatchObject({ ref: '6909558', tipo: 'persona', nombre: 'ALVARO ANDRES QUIJANO BECERRA', alias: ['Alvaro Quijano'], documentos: ['80413253'], nacimiento: ['1967-07-18'], nacionalidades: ['Colombia'] });
    expect(r.entradas[1]).toMatchObject({ tipo: 'entidad', nombre: 'EMPRESA X' });
  });

  test('OFAC: la cédula viene en el texto libre, con alias del archivo aparte y de las observaciones', () => {
    const sdn = `4108,"RODRIGUEZ OREJUELA, Miguel Angel","individual","SDNT",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,"DOB 23 Nov 1943; Cedula No. 6.095.803 (Colombia); a.k.a. 'EL SENOR'."\n36,"AEROCARIBBEAN AIRLINES",-0- ,"CUBA",-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- ,-0- `;
    const alt = `4108,9152,"aka","ROD OREJUELA, Miguel",-0- `;
    const r = parseOfac(sdn, alt);
    expect(r.entradas).toHaveLength(2);
    expect(r.entradas[0]).toMatchObject({ ref: '4108', tipo: 'persona', documentos: ['6095803'], nacimiento: ['23 Nov 1943'] });
    expect(r.entradas[0].alias).toEqual(expect.arrayContaining(['ROD OREJUELA, Miguel', 'EL SENOR']));
    expect(r.entradas[1]).toMatchObject({ tipo: 'entidad', nombre: 'AEROCARIBBEAN AIRLINES' });
  });

  test('UE: agrupa las filas por persona (alias, nacimiento y documento colombiano)', () => {
    const csv = '﻿fileGenerationDate;Entity_LogicalId;Entity_SubjectType;NameAlias_WholeName;BirthDate_BirthDate;Identification_Number;Identification_CountryDescription;Citizenship_CountryDescription\n'
      + '05/08/2026;77;P;Pedro Lopez Ruiz;1970-02-03;123456789;Colombia;Colombia\n05/08/2026;77;P;Pedro Lopez;1970-02-03;;;Colombia\n05/08/2026;88;E;Empresa Z;;;;';
    const r = parseUe(csv);
    expect(r.publicada).toBe('05/08/2026');
    expect(r.entradas).toHaveLength(2);
    expect(r.entradas.find((e) => e.ref === '77')).toMatchObject({ tipo: 'persona', nombre: 'Pedro Lopez Ruiz', alias: ['Pedro Lopez'], documentos: ['123456789'], nacimiento: ['1970-02-03'] });
  });

  test('Reino Unido: agrupa por Group ID y toma la fecha de la primera línea', () => {
    const csv = 'Last Updated,03/06/2026\nName 6,Name 1,Name 2,Name 3,Name 4,Name 5,DOB,Nationality,National Identification Number,National Identification Details,Group Type,Alias Type,Group ID,Regime,Other Information\n'
      + 'RUIZ,Ana,Maria,,,,12/04/1976,Colombia,55123456,Cedula,Individual,Primary name,500,Global,\nRUIZ,Ana,,,,,12/04/1976,Colombia,,,Individual,AKA,500,Global,';
    const r = parseUk(csv);
    expect(r.publicada).toBe('03/06/2026');
    expect(r.entradas).toHaveLength(1);
    expect(r.entradas[0]).toMatchObject({ ref: '500', tipo: 'persona', documentos: ['55123456'] });
  });

  test('PEP de Colombia (SIGEP) y sanciones de la Procuraduría (SIRI): traen la cédula como campo', () => {
    const pep = 'NUMERO_DOCUMENTO,NOMBRE_PEP,DENOMINACION_CARGO,NOMBRE_ENTIDAD,FECHA_VINCULACION,FECHA_DESVINCULACION,ENLACE_HOJA_VIDA_SIGEP\n1103097386,ABDON DE JESUS GONZALEZ RUIZ,ALCALDE,MUNICIPIO X,5/08/2024,,https://x';
    expect(parsePepSigep(pep).entradas[0]).toMatchObject({ documentos: ['1103097386'], nombre: 'ABDON DE JESUS GONZALEZ RUIZ', detalle: { cargo: 'ALCALDE', entidad: 'MUNICIPIO X' } });
    const siri = '"numero_siri","tipo_inhabilidad","nombre_tipo_identificacion","numero_identificacion","primer_apellido","segundo_apellido","primer_nombre","segundo_nombre","sanciones"\n'
      + '"1","DISCIPLINARIO","CÉDULA DE CIUDADANÍA","7534386        ","BOTINA","OLIVEROS","GABRIEL","ANTONIO","MULTA"\n"2","DISCIPLINARIO","PASAPORTE","AB12345","X","Y","Z","W","MULTA"';
    const r = parseSiri(siri);
    expect(r.entradas).toHaveLength(1);   // solo cédulas
    expect(r.entradas[0]).toMatchObject({ documentos: ['7534386'], nombre: 'GABRIEL ANTONIO BOTINA OLIVEROS', detalle: { sanciones: 'MULTA' } });
  });
});

// ── Flujo completo: asesor consulta → Oficial valida → entrega ───────────────
const pass = 'testpass123';
const EMPRESA = 'EMP-LISTAS-TEST';
const CEDULA = '55500001';
const usuarios = {
  asesor:  { email: 'listas-asesor@kernel.test',  rol: 'asesor',  permisos: ['READ', 'WRITE', 'ENTREGAR'] },
  oficial: { email: 'listas-oficial@kernel.test', rol: 'asesor',  permisos: ['VALIDAR'] },
  admin:   { email: 'listas-admin@kernel.test',   rol: 'admin',   permisos: [] },
};
const ag = {};
const est = {};   // vinculacionId, consultaId…

const pdfDe = async (agente, url) => agente.get(url).buffer(true).parse((res, cb) => {
  const partes = []; res.on('data', (c) => partes.push(c)); res.on('end', () => cb(null, Buffer.concat(partes)));
});

const versionActiva = async (fuente, registros, entradas) => {
  const { rows: [v] } = await pool.query(
    `INSERT INTO listas_versiones (fuente, url, publicada, sha256, bytes, registros, activa) VALUES ($1,'https://prueba.test',$2,$3,10,$4,true) RETURNING id`,
    [fuente, '2026-09-20', sha256(fuente + JSON.stringify(entradas)), entradas.length]);
  for (const e of entradas) {
    await pool.query(
      `INSERT INTO listas_entradas (version_id, fuente, ref, tipo, nombre, alias, documentos, nacimiento, nacionalidades, detalle)
       VALUES ($1,$2,$3,'persona',$4,$5,$6,$7,'{}',$8)`,
      [v.id, fuente, e.ref, e.nombre, e.alias ?? [], e.documentos ?? [], e.nacimiento ?? [], JSON.stringify(e.detalle ?? {})]);
  }
  invalidarCache();
  return v.id;
};

describe('Consulta en listas — asesor, Oficial de Cumplimiento y entrega', () => {
  let app;
  const app_ = async () => app;

  beforeAll(async () => {
    app = await createApp();
    const hash = await bcrypt.hash(pass, 4);
    await pool.query(`INSERT INTO empresas (codigo, nombre) VALUES ($1, 'Empresa Listas Test') ON CONFLICT (codigo) DO UPDATE SET is_active = true`, [EMPRESA]);
    for (const [k, u] of Object.entries(usuarios)) {
      const { rows: [r] } = await pool.query(
        `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved) VALUES ($3, $1, $2, $4, true, true)
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, rol = EXCLUDED.rol, is_active = true RETURNING id`,
        [u.email, hash, `Listas ${k}`, u.rol]);
      u.id = r.id;
      await pool.query(
        `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id) SELECT $1, m.id, a.id FROM modulos m, acciones a
          WHERE m.nombre = 'captacion' AND a.nombre = ANY($2) ON CONFLICT DO NOTHING`, [u.id, u.permisos]);
      ag[k] = request.agent(app);
      await ag[k].post('/api/auth/login').send({ email: u.email, password: pass });
    }
    // Las listas de las pruebas empiezan de cero (son copias derivadas de fuentes públicas: se vuelven a descargar solas)
    await pool.query(`DELETE FROM listas_versiones`);
    invalidarCache();
    const res = await ag.asesor.post('/api/captacion/prospectos').send({
      empresa_codigo: EMPRESA, nombres: 'Carlos Alberto', apellidos: 'Mendoza Rueda', cedula: CEDULA, celular: '3105550188', acepta_habeas_data: true });
    est.prospectoId = res.body.id;
    const { rows: [v] } = await pool.query(
      `INSERT INTO captacion_vinculaciones (prospecto_id, seccion_pep_at, pep_maneja_recursos_publicos, pep_reconocimiento_publico, pep_poder_publico, pep_vinculo_expuesto)
       VALUES ($1, NOW(), false, true, false, false) RETURNING id`, [est.prospectoId]);
    est.vinculacionId = v.id;
    est.url = `/api/captacion/vinculaciones/${v.id}`;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM archivos WHERE entidad_tipo = 'captacion_consulta_listas' AND entidad_id = $1`, [est.vinculacionId]);
    await pool.query(`DELETE FROM captacion_eventos WHERE prospecto_id = $1`, [est.prospectoId]);
    await pool.query(`DELETE FROM captacion_vinculaciones WHERE prospecto_id = $1`, [est.prospectoId]);
    await pool.query(`DELETE FROM captacion_prospectos WHERE id = $1`, [est.prospectoId]);
    await pool.query(`DELETE FROM captacion_config WHERE clave IN ('exigir_consulta_listas', 'exigir_validacion_voz')`);
    await pool.query(`DELETE FROM listas_versiones`);
    invalidarCache();
    await pool.query(`DELETE FROM empresas WHERE codigo = $1`, [EMPRESA]);
    const ids = Object.values(usuarios).map((u) => u.id);
    await pool.query(`DELETE FROM permisos WHERE usuario_uuid = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM global_usuarios WHERE id = ANY($1)`, [ids]);
    await pool.end();
  });

  test('antes de consultar hay que verificar la cédula, y las listas obligatorias tienen que estar al día', async () => {
    const sinVerificar = await ag.asesor.post(`${est.url}/consulta-listas`).send({});
    expect([sinVerificar.status, sinVerificar.body.code]).toEqual([409, 'IDENTIDAD_NO_VERIFICADA']);
    expect((await ag.asesor.post(`${est.url}/verificacion-identidad`)).status).toBe(201);
    const sinListas = await ag.asesor.post(`${est.url}/consulta-listas`).send({});
    expect([sinListas.status, sinListas.body.code]).toEqual([409, 'LISTAS_NO_DISPONIBLES']);
  });

  test('cotejo: la cédula exacta y el nombre parecido dan coincidencias; un homónimo con otra cédula sugiere descartar', async () => {
    await versionActiva('ONU', 3, [
      { ref: 'o1', nombre: 'CARLOS ALBERTO MENDOZA RUEDA', nacimiento: ['1970-01-01'], detalle: { programa: 'Al-Qaida' } },
      { ref: 'o2', nombre: 'PEDRO SIN RELACION', documentos: [] },
    ]);
    await versionActiva('OFAC_SDN', 1, [{ ref: 'f1', nombre: 'MENDOZA RUEDA, Carlos Alberto', documentos: ['99999999'], detalle: { programa: 'SDNT' } }]);
    await versionActiva('PEP_SIGEP', 1, [{ ref: 'p1', nombre: 'OTRO NOMBRE DISTINTO', documentos: [CEDULA], detalle: { cargo: 'ALCALDE', entidad: 'MUNICIPIO X', fecha_desvinculacion: '' } }]);

    const r = await ag.asesor.post(`${est.url}/consulta-listas`).send({});
    expect(r.status).toBe(201);
    est.consultaId = r.body.id;
    const porFuente = Object.fromEntries(r.body.coincidencias.map((x) => [x.fuente, x]));
    expect(Object.keys(porFuente).sort()).toEqual(['OFAC_SDN', 'ONU', 'PEP_SIGEP']);
    expect(porFuente.ONU).toMatchObject({ tipo: 'nombre', sugerencia: 'revisar' });
    expect(porFuente.OFAC_SDN).toMatchObject({ tipo: 'nombre', sugerencia: 'descartar' });
    expect(porFuente.OFAC_SDN.motivo_sugerencia).toContain('99999999');
    expect(porFuente.PEP_SIGEP).toMatchObject({ tipo: 'documento', score: 1 });   // el PEP solo se coteja por cédula
    expect(r.body.declaracion_pep).toMatchObject({ declara_pep: true });
    expect(r.body.versiones.ONU).toMatchObject({ vinculante: true, disponible: true, registros: 2 });
    expect(r.body.pendientes).toMatchObject({ coincidencias_sin_decidir: 3, completa: false });

    // Volver a iniciar retoma la misma consulta
    const otra = await ag.asesor.post(`${est.url}/consulta-listas`).send({});
    expect([otra.status, otra.body.id, otra.body.existente]).toEqual([200, est.consultaId, true]);
    est.ids = Object.fromEntries(r.body.coincidencias.map((x) => [x.fuente, x.id]));
  });

  test('no se cierra sin decidir cada coincidencia ni sin la búsqueda obligatoria en fuentes abiertas', async () => {
    const url = `/api/captacion/consultas-listas/${est.consultaId}`;
    const vacia = await ag.asesor.post(`${url}/cerrar`);
    expect([vacia.status, vacia.body.code]).toEqual([400, 'CONSULTA_INCOMPLETA']);

    // Decisiones sin motivo o consultas incompletas se rechazan
    expect((await ag.asesor.put(url).send({ decisiones: [{ id: est.ids.ONU, decision: 'descartada', motivo: 'corto' }] })).status).toBe(400);
    expect((await ag.asesor.put(url).send({ manual: { fuentes_abiertas: { resultado: 'sin_hallazgos' } } })).status).toBe(400);            // faltan términos y motor
    expect((await ag.asesor.put(url).send({ manual: { fuentes_abiertas: { resultado: 'no_aplica' } } })).status).toBe(400);                // obligatoria
    expect((await ag.asesor.put(url).send({ manual: { procuraduria: { resultado: 'hallazgo' } } })).status).toBe(400);                    // hallazgo sin describir
    expect((await ag.asesor.put(url).send({ manual: { inventada: { resultado: 'sin_hallazgos' } } })).status).toBe(400);

    const ok = await ag.asesor.put(url).send({
      decisiones: [
        { id: est.ids.ONU, decision: 'descartada', motivo: 'El certificado de nacimiento da otra fecha que la de la lista' },
        { id: est.ids.OFAC_SDN, decision: 'descartada', motivo: 'Homónimo: la lista trae otra cédula distinta' },
        { id: est.ids.PEP_SIGEP, decision: 'confirmada', motivo: 'Es él: fue alcalde encargado; requiere debida diligencia ampliada' },
      ],
      manual: { fuentes_abiertas: { resultado: 'sin_hallazgos', terminos: '"Carlos Alberto Mendoza Rueda" lavado de activos', motor: 'Google', observaciones: 'Solo perfiles de redes sociales' },
                policia: { resultado: 'no_aplica', observaciones: 'No se consultó' } },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.pendientes).toMatchObject({ completa: true });
    expect(ok.body.coincidencias.find((x) => x.fuente === 'PEP_SIGEP')).toMatchObject({ decision: 'confirmada' });
  });

  test('al cerrar queda el PDF en S3, protegido, con la conclusión y el hash; el asesor lo descarga', async () => {
    const url = `/api/captacion/consultas-listas/${est.consultaId}`;
    const cierra = await ag.asesor.post(`${url}/cerrar`);
    expect(cierra.status).toBe(200);
    expect(cierra.body).toMatchObject({ estado: 'cerrada', conclusion: 'con_hallazgos', tiene_pdf: true });
    expect(cierra.body.pdf_hash).toHaveLength(64);
    est.pdfHash1 = cierra.body.pdf_hash;

    const pdf = await pdfDe(ag.asesor, `${url}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/pdf/);
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    expect(sha256(pdf.body)).toBe(est.pdfHash1);

    // Es evidencia: se guarda como archivo de la vinculación y no se puede eliminar
    const { rows: [a] } = await pool.query(
      `SELECT id FROM archivos WHERE entidad_tipo = 'captacion_consulta_listas' AND entidad_id = $1`, [est.vinculacionId]);
    await expect(eliminarArchivo(a.id, { omitirS3: true })).rejects.toMatchObject({ code: 'ARCHIVO_PROTEGIDO' });
    // Cerrada, ya no se edita
    expect((await ag.asesor.put(url).send({ decisiones: [] })).body.code).toBe('CONSULTA_CERRADA');
    expect((await pool.query(`SELECT 1 FROM captacion_eventos WHERE vinculacion_id = $1 AND tipo = 'consulta_listas_cerrada'`, [est.vinculacionId])).rowCount).toBe(1);
  });

  test('solo quien tiene el permiso VALIDAR ve las consultas del Oficial; el asesor no', async () => {
    expect((await ag.asesor.get('/api/captacion/cumplimiento/consultas')).status).toBe(403);
    expect((await ag.asesor.post(`/api/captacion/cumplimiento/consultas/${est.consultaId}/validar`).send({ resultado: 'validada' })).status).toBe(403);
    const lista = await ag.oficial.get('/api/captacion/cumplimiento/consultas');
    expect(lista.status).toBe(200);
    const fila = lista.body.find((x) => x.id === est.consultaId);
    expect(fila).toMatchObject({ estado: 'cerrada', conclusion: 'con_hallazgos', cedula: CEDULA, confirmadas: 1 });
    const det = await ag.oficial.get(`/api/captacion/cumplimiento/consultas/${est.consultaId}`);
    expect(det.body.coincidencias).toHaveLength(3);
    expect((await pdfDe(ag.oficial, `/api/captacion/cumplimiento/consultas/${est.consultaId}/pdf`)).status).toBe(200);
    const estado = await ag.oficial.get('/api/captacion/cumplimiento/listas');
    expect(estado.body.fuentes.find((f) => f.codigo === 'ONU')).toMatchObject({ disponible: true, vinculante: true });
  });

  test('el Oficial puede observar la consulta: el asesor la corrige y la cierra de nuevo con un PDF nuevo', async () => {
    const validar = (b) => ag.oficial.post(`/api/captacion/cumplimiento/consultas/${est.consultaId}/validar`).send(b);
    expect((await validar({ resultado: 'observada' })).status).toBe(400);                 // observar exige explicar
    const obs = await validar({ resultado: 'observada', observaciones: 'Falta consultar el boletín de la Contraloría' });
    expect(obs.body).toMatchObject({ estado: 'observada', observaciones_oficial: 'Falta consultar el boletín de la Contraloría' });

    const url = `/api/captacion/consultas-listas/${est.consultaId}`;
    const edita = await ag.asesor.put(url).send({ manual: { contraloria: { resultado: 'sin_hallazgos', observaciones: 'Sin registros en el boletín a la fecha' } } });
    expect(edita.status).toBe(200);
    const cierra = await ag.asesor.post(`${url}/cerrar`);
    expect(cierra.body.estado).toBe('cerrada');
    expect(cierra.body.pdf_hash).not.toBe(est.pdfHash1);   // PDF nuevo, con la consulta completada
  });

  test('con la exigencia activa no se entrega sin consulta validada; validada por el Oficial, sí', async () => {
    // La solicitud llega lista para entregar en todo lo demás
    await pool.query(
      `UPDATE captacion_vinculaciones SET seccion_firma_at = NOW(), seccion_documentos_at = NOW(), valor_aporte = 80000, estado = 'solicitud_completa' WHERE id = $1`, [est.vinculacionId]);
    expect((await ag.admin.put('/api/captacion/config/reglas-entrega').send({ consulta_listas: true })).body).toMatchObject({ consulta_listas: true });
    expect((await ag.asesor.put('/api/captacion/config/reglas-entrega').send({ consulta_listas: false })).status).toBe(403);   // configurar requiere permiso

    const bloqueada = await ag.asesor.post(`${est.url}/entregar`);
    expect([bloqueada.status, bloqueada.body.code]).toEqual([400, 'CONSULTA_LISTAS_REQUERIDA']);

    const valida = await ag.oficial.post(`/api/captacion/cumplimiento/consultas/${est.consultaId}/validar`).send({ resultado: 'validada', observaciones: 'Consultas completas y pertinentes' });
    expect(valida.status).toBe(200);
    expect(valida.body).toMatchObject({ estado: 'validada', oficial_nombre: 'Listas oficial' });
    expect(valida.body.pdf_hash).not.toBe(est.pdfHash1);
    const { rowCount: pdfs } = await pool.query(`SELECT 1 FROM archivos WHERE entidad_tipo = 'captacion_consulta_listas' AND entidad_id = $1`, [est.vinculacionId]);
    expect(pdfs).toBe(3);   // cerrada, cerrada de nuevo y validada: ninguna se borra

    const estadoAsesor = await ag.asesor.get(`${est.url}/consulta-listas`);
    expect(estadoAsesor.body).toMatchObject({ exigida: true, vigente: true, identidad_verificada: true });

    // Si después se corrige la identidad, la consulta deja de valer
    await pool.query(`UPDATE captacion_prospectos SET nombres = 'Carlos Alberto Jose' WHERE id = $1`, [est.prospectoId]);
    expect((await ag.asesor.get(`${est.url}/consulta-listas`)).body).toMatchObject({ vigente: false, desactualizada_por_identidad: true });
    const otraVez = await ag.asesor.post(`${est.url}/entregar`);
    expect([otraVez.status, otraVez.body.code]).toEqual([400, 'CONSULTA_LISTAS_REQUERIDA']);
    await pool.query(`UPDATE captacion_prospectos SET nombres = 'Carlos Alberto' WHERE id = $1`, [est.prospectoId]);

    const entrega = await ag.asesor.post(`${est.url}/entregar`);
    expect(entrega.status).toBe(200);
    expect(entrega.body.estado).toBe('entregada');
  });

  test('el estado de las listas indica cuáles están disponibles y al día', async () => {
    const r = await ag.asesor.get('/api/captacion/listas/estado');
    expect(r.status).toBe(200);
    const onu = r.body.fuentes.find((f) => f.codigo === 'ONU');
    expect(onu).toMatchObject({ disponible: true, desactualizada: false, registros: 2 });
    expect(r.body.fuentes.find((f) => f.codigo === 'UK')).toMatchObject({ disponible: false, desactualizada: true });
  });
});
