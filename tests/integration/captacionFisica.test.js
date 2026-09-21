import request from 'supertest';
import bcrypt from 'bcrypt';
import { jest } from '@jest/globals';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import { colocarObjetoDePrueba, eliminarArchivo } from '../../src/services/archivoService.js';
import { sha256 } from '../../src/services/hashCanonico.js';

jest.setTimeout(30000);

let app;
const pass = 'testpass123';
const EMPRESA = 'EMP-FISICA-TEST';
const CEDULA = '88800777';
const usuarios = {
  asesor: { email: 'fisica-asesor@kernel.test', permisos: ['READ', 'WRITE', 'ENTREGAR'], id: null },
  otro:   { email: 'fisica-otro@kernel.test',   permisos: ['READ', 'WRITE', 'ENTREGAR'], id: null },
};
const e = { prospectoId: null, vinculacionId: null };
const ESCANEO = Buffer.from('%PDF-1.4 escaneo firmado a mano de prueba');

const login = async (quien) => {
  const ag = request.agent(app);
  await ag.post('/api/auth/login').send({ email: usuarios[quien].email, password: pass });
  return ag;
};

const formulario = (extra = {}) => ({
  personal: { tipo_documento: 'CC', fecha_nacimiento: '1990-05-10', direccion_residencia: 'Calle 1 # 2-3', ciudad_residencia: 'Pereira', estado_civil: 'soltero' },
  laboral: { cargo: 'Operario', tipo_contrato: 'indefinido' },
  pep: { pep_maneja_recursos_publicos: false, pep_reconocimiento_publico: false, pep_poder_publico: false, pep_vinculo_expuesto: false },
  financiera: { ingresos_mensuales: 2000000, egresos_mensuales: 1500000, origen_fondos: 'Salario' },
  aportes: { valor_aporte: 80000, periodicidad: 'mensual', seguro_vida: false, bono_sorteo: false },
  beneficiarios: [{ orden: 1, nombres: 'Hijo Prueba', porcentaje: 100, parentesco: 'hijo' }],
  referencias: [{ tipo: 'personal', nombres: 'Ref Uno', celular: '3100000000' }],
  ...extra,
});

const limpiar = async (ids) => {
  const prospectos = `(SELECT id FROM captacion_prospectos WHERE asesor_uuid = ANY($1) OR cedula = '${CEDULA}')`;
  const vincs = `(SELECT id FROM captacion_vinculaciones WHERE prospecto_id IN ${prospectos})`;
  await pool.query(`DELETE FROM archivos WHERE entidad_id IN ${vincs} AND entidad_tipo LIKE 'captacion_%'`, [ids]);
  await pool.query(`DELETE FROM captacion_eventos WHERE prospecto_id IN ${prospectos}`, [ids]);
  await pool.query(`DELETE FROM captacion_beneficiarios WHERE vinculacion_id IN ${vincs}`, [ids]);
  await pool.query(`DELETE FROM captacion_referencias WHERE vinculacion_id IN ${vincs}`, [ids]);
  await pool.query(`DELETE FROM captacion_vinculaciones WHERE prospecto_id IN ${prospectos}`, [ids]);
  await pool.query(`DELETE FROM captacion_toques WHERE prospecto_id IN ${prospectos}`, [ids]);
  await pool.query(`DELETE FROM captacion_prospectos WHERE asesor_uuid = ANY($1) OR cedula = '${CEDULA}'`, [ids]);
};

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  for (const u of Object.values(usuarios)) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
       VALUES ('Fisica Test', $1, $2, 'asesor', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true RETURNING id`, [u.email, hash]);
    u.id = r.id;
    await pool.query(
      `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
       SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'captacion' AND a.nombre = ANY($2) ON CONFLICT DO NOTHING`,
      [u.id, u.permisos]);
  }
  await pool.query(`INSERT INTO empresas (codigo, nombre) VALUES ($1, 'Empresa Fisica Test') ON CONFLICT (codigo) DO UPDATE SET is_active = true`, [EMPRESA]);
  await limpiar(Object.values(usuarios).map((u) => u.id));
  // La validación por voz queda exigida: las solicitudes físicas no deben pedirla
  await pool.query(`INSERT INTO captacion_config (clave, valor) VALUES ('exigir_validacion_voz', 'true')
                    ON CONFLICT (clave) DO UPDATE SET valor = 'true'`);
});

afterAll(async () => {
  const ids = Object.values(usuarios).map((u) => u.id);
  await limpiar(ids);
  await pool.query(`DELETE FROM captacion_config WHERE clave = 'exigir_validacion_voz'`);
  await pool.query('DELETE FROM permisos WHERE usuario_uuid = ANY($1)', [ids]);
  await pool.query('DELETE FROM global_usuarios WHERE id = ANY($1)', [ids]);
  await pool.query('DELETE FROM empresas WHERE codigo = $1', [EMPRESA]);
  await pool.end();
});

describe('Solicitud física — auth y propiedad', () => {
  test('sin token → 401', async () => {
    expect((await request(app).get('/api/captacion/prospectos/00000000-0000-0000-0000-000000000000/solicitud-fisica')).status).toBe(401);
    expect((await request(app).put('/api/captacion/prospectos/00000000-0000-0000-0000-000000000000/solicitud-fisica').send({})).status).toBe(401);
  });

  test('el asesor crea el prospecto (la autorización de datos consta en el papel)', async () => {
    const ag = await login('asesor');
    const res = await ag.post('/api/captacion/prospectos').send({
      empresa_codigo: EMPRESA, nombres: 'Pedro', apellidos: 'Del Papel', cedula: CEDULA, celular: '3105550777', acepta_habeas_data: true,
    });
    expect(res.status).toBe(201);
    e.prospectoId = res.body.id;
  });

  test('otro asesor no puede digitar la solicitud → 404', async () => {
    const ag = await login('otro');
    expect((await ag.put(`/api/captacion/prospectos/${e.prospectoId}/solicitud-fisica`).send(formulario())).status).toBe(404);
  });
});

describe('Solicitud física — digitación', () => {
  test('sin PEP ni aportes → 400', async () => {
    const ag = await login('asesor');
    const { pep, aportes, ...resto } = formulario();
    expect((await ag.put(`/api/captacion/prospectos/${e.prospectoId}/solicitud-fisica`).send(resto)).status).toBe(400);
  });

  test('beneficiarios que no suman 100 → 400', async () => {
    const ag = await login('asesor');
    const res = await ag.put(`/api/captacion/prospectos/${e.prospectoId}/solicitud-fisica`)
      .send(formulario({ beneficiarios: [{ orden: 1, nombres: 'X', porcentaje: 60 }] }));
    expect(res.status).toBe(400);
  });

  test('aporte por debajo del mínimo → 400', async () => {
    const ag = await login('asesor');
    const res = await ag.put(`/api/captacion/prospectos/${e.prospectoId}/solicitud-fisica`)
      .send(formulario({ aportes: { valor_aporte: 1000, periodicidad: 'mensual', seguro_vida: false, bono_sorteo: false } }));
    expect(res.status).toBe(400);
  });

  test('campos desconocidos → 400 (.strict())', async () => {
    const ag = await login('asesor');
    expect((await ag.put(`/api/captacion/prospectos/${e.prospectoId}/solicitud-fisica`).send(formulario({ hack: true }))).status).toBe(400);
  });

  test('PUT guarda todas las secciones como hechas por el asesor y marca origen físico', async () => {
    const ag = await login('asesor');
    const res = await ag.put(`/api/captacion/prospectos/${e.prospectoId}/solicitud-fisica`).send(formulario());
    expect(res.status).toBe(200);
    e.vinculacionId = res.body.vinculacion_id;

    const { rows: [v] } = await pool.query(`SELECT * FROM captacion_vinculaciones WHERE id = $1`, [e.vinculacionId]);
    expect(v.origen_solicitud).toBe('fisico');
    expect(v.fisico_digitado_por).toBe(usuarios.asesor.id);
    expect(v.seccion_pep_autor).toBe('asesor');
    expect(v.seccion_personal_autor).toBe('asesor');
    expect(v.seccion_aportes_autor).toBe('asesor');
    expect(v.cargo).toBe('Operario');
    expect(Number(v.valor_aporte)).toBe(80000);
    expect(v.seccion_firma_at).toBeNull();
    const { rows: bens } = await pool.query(`SELECT * FROM captacion_beneficiarios WHERE vinculacion_id = $1`, [e.vinculacionId]);
    expect(bens).toHaveLength(1);
  });

  test('repetir el PUT reemplaza beneficiarios (idempotente) y GET devuelve lo digitado', async () => {
    const ag = await login('asesor');
    await ag.put(`/api/captacion/prospectos/${e.prospectoId}/solicitud-fisica`).send(formulario());
    const res = await ag.get(`/api/captacion/prospectos/${e.prospectoId}/solicitud-fisica`);
    expect(res.status).toBe(200);
    expect(res.body.vinculacion.beneficiarios).toHaveLength(1);
    expect(res.body.vinculacion.firma_png).toBeUndefined();
    expect(res.body.vinculacion.formulario_snapshot).toBeUndefined();
  });

  test('el evento de digitación queda registrado', async () => {
    const { rows } = await pool.query(`SELECT autor_tipo FROM captacion_eventos WHERE prospecto_id = $1 AND tipo = 'solicitud_fisica_digitada'`, [e.prospectoId]);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].autor_tipo).toBe('asesor');
  });
});

describe('Solicitud física — firma en papel y entrega', () => {
  let key, meta;

  test('no se puede entregar sin firma (escaneo)', async () => {
    const ag = await login('asesor');
    const res = await ag.post(`/api/captacion/vinculaciones/${e.vinculacionId}/entregar`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/firma/i);
  });

  test('registrar la firma sin subir el escaneo → 400', async () => {
    const ag = await login('asesor');
    const sol = await ag.post(`/api/captacion/vinculaciones/${e.vinculacionId}/firma-fisica/solicitar`).send({ nombre: 'firmado.pdf', mime: 'application/pdf', size: ESCANEO.length });
    expect(sol.status).toBe(200);
    expect(sol.body.key).toContain(`kernel/captacion_firma_fisicas/${e.vinculacionId}/`);
    key = sol.body.key;
    meta = { nombre: 'firmado.pdf', mime: 'application/pdf', size: ESCANEO.length, fecha_firma: '2026-09-21' };
    const res = await ag.post(`/api/captacion/vinculaciones/${e.vinculacionId}/firma-fisica`).send({ key, ...meta });
    expect(res.status).toBe(400);
  });

  test('archivo con tipo no permitido → 400; key de otra solicitud → 400; fecha futura → 400', async () => {
    const ag = await login('asesor');
    const url = `/api/captacion/vinculaciones/${e.vinculacionId}/firma-fisica`;
    expect((await ag.post(`${url}/solicitar`).send({ nombre: 'x.exe', mime: 'application/x-msdownload', size: 10 })).status).toBe(400);
    colocarObjetoDePrueba(key, ESCANEO);
    expect((await ag.post(url).send({ key: 'kernel/captacion_firma_fisicas/otra/x.pdf', ...meta })).status).toBe(400);
    expect((await ag.post(url).send({ key, ...meta, fecha_firma: '2999-01-01' })).status).toBe(400);
  });

  test('otro asesor no puede registrar la firma → 404', async () => {
    const ag = await login('otro');
    expect((await ag.post(`/api/captacion/vinculaciones/${e.vinculacionId}/firma-fisica`).send({ key, ...meta })).status).toBe(404);
  });

  test('con el escaneo subido queda firmada, con huella del escaneo y del documento', async () => {
    const ag = await login('asesor');
    colocarObjetoDePrueba(key, ESCANEO);
    const res = await ag.post(`/api/captacion/vinculaciones/${e.vinculacionId}/firma-fisica`).send({ key, ...meta });
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('solicitud_completa');

    const { rows: [v] } = await pool.query(`SELECT * FROM captacion_vinculaciones WHERE id = $1`, [e.vinculacionId]);
    expect(v.seccion_firma_at).not.toBeNull();
    expect(v.firma_fisica_hash).toBe(sha256(ESCANEO));
    expect(v.firma_doc_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.firma_png).toBeNull();
    expect(v.firma_fisica_archivo_id).not.toBeNull();
    expect(v.formulario_snapshot.firma_fisica.escaneo_sha256).toBe(sha256(ESCANEO));
    const { rows: [p] } = await pool.query(`SELECT estado FROM captacion_prospectos WHERE id = $1`, [e.prospectoId]);
    expect(p.estado).toBe('convertido');
  });

  test('firmar dos veces → 409, y ya no se pueden cambiar los datos → 409', async () => {
    const ag = await login('asesor');
    expect((await ag.post(`/api/captacion/vinculaciones/${e.vinculacionId}/firma-fisica`).send({ key, ...meta })).status).toBe(409);
    expect((await ag.put(`/api/captacion/prospectos/${e.prospectoId}/solicitud-fisica`).send(formulario())).status).toBe(409);
  });

  test('el escaneo es evidencia: no se puede eliminar por el flujo normal', async () => {
    const { rows: [v] } = await pool.query(`SELECT firma_fisica_archivo_id FROM captacion_vinculaciones WHERE id = $1`, [e.vinculacionId]);
    await expect(eliminarArchivo(v.firma_fisica_archivo_id, { omitirS3: true })).rejects.toMatchObject({ code: 'ARCHIVO_PROTEGIDO' });
  });

  test('la validación por voz no aplica a una solicitud física aunque esté exigida', async () => {
    const ag = await login('asesor');
    const res = await ag.get(`/api/captacion/vinculaciones/${e.vinculacionId}/validacion-voz`);
    expect(res.status).toBe(200);
    expect(res.body.exigida).toBe(false);
  });

  test('entrega sin llamada de voz, pero pide la cédula', async () => {
    const ag = await login('asesor');
    const url = `/api/captacion/vinculaciones/${e.vinculacionId}`;
    const sinCedula = await ag.post(`${url}/entregar`);
    expect(sinCedula.status).toBe(400);
    expect(sinCedula.body.error).toMatch(/cédula/i);

    for (const lado of ['frente', 'reverso']) {
      const m = { nombre: `cedula-${lado}.jpg`, mime: 'image/jpeg', size: 250000 };
      const sol = await ag.post(`${url}/documentos/${lado}/solicitar`).send(m);
      expect(sol.status).toBe(200);
      expect((await ag.patch(`${url}/documentos/${lado}/confirmar`).send({ key: sol.body.key, ...m })).status).toBe(200);
    }
    const res = await ag.post(`${url}/entregar`);
    expect(res.status).toBe(200);
    expect(res.body.estado).toBe('entregada');
  });

  test('entregada ya no se puede editar', async () => {
    const ag = await login('asesor');
    expect((await ag.put(`/api/captacion/prospectos/${e.prospectoId}/solicitud-fisica`).send(formulario())).status).toBe(400);
  });

  test('ver el escaneo entrega URL temporal y deja huella en el registro; otro asesor no lo ve', async () => {
    const ag = await login('asesor');
    const res = await ag.get(`/api/captacion/vinculaciones/${e.vinculacionId}/firma-fisica`);
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https?:\/\//);
    expect(res.body.hash).toBe(sha256(ESCANEO));
    const { rows } = await pool.query(`SELECT 1 FROM captacion_eventos WHERE vinculacion_id = $1 AND tipo = 'escaneo_firma_visto'`, [e.vinculacionId]);
    expect(rows).toHaveLength(1);
    const otro = await login('otro');
    expect((await otro.get(`/api/captacion/vinculaciones/${e.vinculacionId}/firma-fisica`)).status).toBe(404);
  });
});
