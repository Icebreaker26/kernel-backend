import request from 'supertest';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';
import { verificarSello } from '../../src/modules/firma/services/selloService.js';

let app;
const pass = 'testpass123';
const usuarios = {
  operador: { email: 'firma-operador@kernel.test', permisos: ['READ', 'WRITE'], id: null },
  lector:   { email: 'firma-lector@kernel.test',   permisos: ['READ'], id: null },
  otro:     { email: 'firma-otro@kernel.test',     permisos: ['READ', 'WRITE'], id: null },
  nada:     { email: 'firma-nada@kernel.test',     permisos: [], id: null },
};
const login = async (quien) => {
  const ag = request.agent(app);
  await ag.post('/api/auth/login').send({ email: usuarios[quien].email, password: pass });
  return ag;
};
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const H = 'a'.repeat(64);
const firmante = (extra = {}) => ({
  nombre: 'Ana Gómez', tipo_doc: 'CC', num_doc: '1088000111', rol: 'asociado',
  metodo_firma: 'pen', con_huella: true, h_firma_png: H, h_huella_png: H, huella_dispositivo: 'U.are.U 4500', ...extra,
});
const valido = (extra = {}) => ({ h_original: sha('doc-original'), nombre_archivo: 'contrato.pdf', paginas: 3, firmantes: [firmante()], ...extra });

beforeAll(async () => {
  app = await createApp();
  const hash = await bcrypt.hash(pass, 4);
  for (const u of Object.values(usuarios)) {
    const { rows: [r] } = await pool.query(
      `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
       VALUES ('Firma Test', $1, $2, 'juridico', true, true)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true RETURNING id`, [u.email, hash]);
    u.id = r.id;
    if (u.permisos.length) {
      await pool.query(
        `INSERT INTO permisos (usuario_uuid, modulo_id, accion_id)
         SELECT $1, m.id, a.id FROM modulos m, acciones a WHERE m.nombre = 'firma' AND a.nombre = ANY($2) ON CONFLICT DO NOTHING`, [r.id, u.permisos]);
    }
  }
});

afterAll(async () => {
  const uids = Object.values(usuarios).map((u) => u.id);
  // El log es de solo agregar (trigger): para limpiar los datos de prueba se desactiva un instante
  await pool.query('ALTER TABLE firma_eventos DISABLE TRIGGER trg_firma_eventos_solo_agregar');
  try { await pool.query('DELETE FROM firma_eventos WHERE empleado_id = ANY($1)', [uids]); }
  finally { await pool.query('ALTER TABLE firma_eventos ENABLE TRIGGER trg_firma_eventos_solo_agregar'); }
  await pool.query('DELETE FROM permisos WHERE usuario_uuid = ANY($1)', [uids]);
  await pool.query('DELETE FROM global_usuarios WHERE id = ANY($1)', [uids]);
  await pool.end();
});

describe('Firma — Auth y permisos', () => {
  test('sin sesión responde 401', async () => {
    expect((await request(app).post('/api/firma/sello').send(valido())).status).toBe(401);
  });
  test('sin permiso responde 403', async () => {
    const ag = await login('nada');
    expect((await ag.post('/api/firma/sello').send(valido())).status).toBe(403);
  });
  test('con solo READ no puede sellar', async () => {
    const ag = await login('lector');
    expect((await ag.post('/api/firma/sello').send(valido())).status).toBe(403);
  });
});

describe('Firma — Validación', () => {
  test('rechaza hash inválido, campos de más y firmantes vacíos con 400', async () => {
    const ag = await login('operador');
    expect((await ag.post('/api/firma/sello').send(valido({ h_original: 'xyz' }))).status).toBe(400);
    expect((await ag.post('/api/firma/sello').send(valido({ extra: 1 }))).status).toBe(400);
    expect((await ag.post('/api/firma/sello').send(valido({ firmantes: [] }))).status).toBe(400);
    expect((await ag.post('/api/firma/sello').send(valido({ firmantes: [firmante({ metodo_firma: 'laser' })] }))).status).toBe(400);
  });
});

describe('Firma — Lotes (hasta 10 documentos por tanda)', () => {
  const loteId = crypto.randomUUID();
  const conLote = (pos, total = 3, id = loteId) => valido({ h_original: sha(`lote-doc-${pos}-${id}`), nombre_archivo: `doc${pos}.pdf`, lote: { id, pos, total } });

  test('valida el lote: máximo 10, posición dentro del total, sin campos de más', async () => {
    const ag = await login('operador');
    expect((await ag.post('/api/firma/sello').send(valido({ lote: { id: loteId, pos: 1, total: 11 } }))).status).toBe(400);
    expect((await ag.post('/api/firma/sello').send(valido({ lote: { id: loteId, pos: 4, total: 3 } }))).status).toBe(400);
    expect((await ag.post('/api/firma/sello').send(valido({ lote: { id: 'no-uuid', pos: 1, total: 3 } }))).status).toBe(400);
    expect((await ag.post('/api/firma/sello').send(valido({ lote: { id: loteId, pos: 1, total: 3, x: 1 } }))).status).toBe(400);
  });

  test('cada documento del lote recibe su propio folio y sello', async () => {
    const ag = await login('operador');
    const folios = new Set();
    for (const pos of [1, 2, 3]) {
      const res = await ag.post('/api/firma/sello').send(conLote(pos));
      expect(res.status).toBe(201);
      expect(verificarSello(res.body.token)).toMatchObject({ f: res.body.folio, h: sha(`lote-doc-${pos}-${loteId}`) });
      folios.add(res.body.folio);
    }
    expect(folios.size).toBe(3);
    const { rows } = await pool.query('SELECT lote_pos, lote_total FROM firma_eventos WHERE lote_id = $1 ORDER BY lote_pos', [loteId]);
    expect(rows.map((r) => [r.lote_pos, r.lote_total])).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  test('otro funcionario no puede agregar documentos a un lote ajeno', async () => {
    const otro = await login('otro');
    expect((await otro.post('/api/firma/sello').send(conLote(1))).status).toBe(409);
  });

  test('el lote tiene tope (10 documentos + reintentos)', async () => {
    const ag = await login('operador');
    const id = crypto.randomUUID();
    let ultimo;
    for (let i = 0; i < 21; i++) ultimo = await ag.post('/api/firma/sello').send(conLote((i % 10) + 1, 10, id));
    expect(ultimo.status).toBe(409);
    const { rows: [{ n }] } = await pool.query('SELECT COUNT(*)::int AS n FROM firma_eventos WHERE lote_id = $1', [id]);
    expect(n).toBe(20);
  });

  test('POST /verificar informa a qué lote pertenece el documento', async () => {
    const ag = await login('operador');
    const { body } = await ag.post('/api/firma/sello').send(conLote(2));
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    const pdf = Buffer.from(await doc.save());
    await ag.post('/api/firma/registro').send({ folio: body.folio, h_final: sha(pdf) });
    const res = await ag.post('/api/firma/verificar').attach('archivo', pdf, 'x.pdf');
    expect(res.body.lote).toEqual({ id: loteId, pos: 2, total: 3 });
  });

  test('el lote es inmutable en el log', async () => {
    await expect(pool.query('UPDATE firma_eventos SET lote_id = NULL WHERE lote_id = $1', [loteId])).rejects.toThrow(/una vez/);
  });
});

describe('Firma — Sello, registro y verificación', () => {
  let folio;
  let pdf;
  let hFinal;

  test('POST /sello crea el evento y devuelve un token verificable', async () => {
    const ag = await login('operador');
    const res = await ag.post('/api/firma/sello').send(valido());
    expect(res.status).toBe(201);
    expect(res.body.folio).toMatch(/^[0-9a-f-]{36}$/);
    const payload = verificarSello(res.body.token);
    expect(payload).toMatchObject({ f: res.body.folio, h: sha('doc-original'), e: usuarios.operador.id });
    folio = res.body.folio;
  });

  test('un token alterado no verifica', async () => {
    const ag = await login('operador');
    const { body } = await ag.post('/api/firma/sello').send(valido());
    const [cuerpo, firma] = body.token.split('.');
    const otro = Buffer.from(JSON.stringify({ f: body.folio, h: H, t: body.ts, e: usuarios.operador.id })).toString('base64url');
    expect(verificarSello(`${otro}.${firma}`)).toBeNull();
    // Se altera el PRIMER carácter de la firma (6 bits útiles): cambiar los últimos no siempre altera los bytes
    // (en 64 bytes en base64url los dos últimos caracteres solo aportan 8 bits, así que ~1/256 de las veces 'AA' no cambiaba nada)
    const firmaAlterada = (firma[0] === 'A' ? 'B' : 'A') + firma.slice(1);
    expect(verificarSello(`${cuerpo}.${firmaAlterada}`)).toBeNull();
    const res = await ag.post('/api/firma/verificar-token').send({ token: `${otro}.${firma}` });
    expect(res.body.valido).toBe(false);
  });

  test('no se guardan firma ni huella, solo sus hashes', async () => {
    const { rows: [ev] } = await pool.query('SELECT firmantes FROM firma_eventos WHERE folio = $1', [folio]);
    expect(ev.firmantes[0].h_firma_png).toBe(H);
    expect(JSON.stringify(ev.firmantes)).not.toMatch(/data:image/);
  });

  test('POST /registro fija el hash final una sola vez', async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    pdf = Buffer.from(await doc.save());
    hFinal = sha(pdf);
    const ag = await login('operador');
    expect((await ag.post('/api/firma/registro').send({ folio, h_final: hFinal })).status).toBe(200);
    expect((await ag.post('/api/firma/registro').send({ folio, h_final: H })).status).toBe(409);
  });

  test('otro empleado no puede registrar sobre un folio ajeno', async () => {
    const op = await login('operador');
    const { body } = await op.post('/api/firma/sello').send(valido());
    const otro = await login('otro');
    expect((await otro.post('/api/firma/registro').send({ folio: body.folio, h_final: H })).status).toBe(404);
  });

  test('POST /verificar reconoce el PDF final byte a byte y rechaza uno alterado', async () => {
    const ag = await login('lector');
    const ok = await ag.post('/api/firma/verificar').attach('archivo', pdf, 'firmado.pdf');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ valido: true, folio, hash: hFinal });
    expect(ok.body.firmantes[0]).toMatchObject({ nombre: 'Ana Gómez', num_doc: '1088000111' });
    const alterado = Buffer.concat([pdf, Buffer.from('\n%x')]);
    const mal = await ag.post('/api/firma/verificar').attach('archivo', alterado, 'firmado.pdf');
    expect(mal.body.valido).toBe(false);
  });

  test('POST /verificar sin archivo responde 400', async () => {
    const ag = await login('lector');
    expect((await ag.post('/api/firma/verificar')).status).toBe(400);
  });

  test('el log es de solo agregar: no se puede borrar ni cambiar el hash final', async () => {
    await expect(pool.query('DELETE FROM firma_eventos WHERE folio = $1', [folio])).rejects.toThrow(/solo agregar/);
    await expect(pool.query('UPDATE firma_eventos SET h_final = $1 WHERE folio = $2', [H, folio])).rejects.toThrow(/una vez/);
  });

  test('GET /clave-publica devuelve la clave pública en PEM', async () => {
    const ag = await login('lector');
    const res = await ag.get('/api/firma/clave-publica');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/BEGIN PUBLIC KEY/);
  });
});

describe('Firma — Límites y contrato de los datos', () => {
  test('rechaza más de 10 firmantes, ninguno, páginas fuera de rango y nombres de archivo vacíos o larguísimos', async () => {
    const ag = await login('operador');
    const post = (extra) => ag.post('/api/firma/sello').send(valido(extra));
    expect((await post({ firmantes: Array.from({ length: 11 }, () => firmante()) })).status).toBe(400);
    expect((await post({ firmantes: Array.from({ length: 10 }, () => firmante()) })).status).toBe(201);
    expect((await post({ paginas: 0 })).status).toBe(400);
    expect((await post({ paginas: 2001 })).status).toBe(400);
    expect((await post({ paginas: 1.5 })).status).toBe(400);
    expect((await post({ nombre_archivo: '' })).status).toBe(400);
    expect((await post({ nombre_archivo: 'a'.repeat(256) })).status).toBe(400);
  });

  test('cada firmante exige tipo y número de documento válidos, hash de firma y método conocido', async () => {
    const ag = await login('operador');
    const post = (f) => ag.post('/api/firma/sello').send(valido({ firmantes: [firmante(f)] }));
    expect((await post({ tipo_doc: 'RUT' })).status).toBe(400);
    expect((await post({ num_doc: '12' })).status).toBe(400);
    expect((await post({ nombre: '' })).status).toBe(400);
    expect((await post({ h_firma_png: 'zz' })).status).toBe(400);
    expect((await post({ h_firma_png: 'A'.repeat(64) })).status).toBe(400);   // hash en minúsculas
    expect((await post({ h_huella_png: 'zz' })).status).toBe(400);
    expect((await post({ metodo_firma: 'touch', con_huella: false, h_huella_png: null })).status).toBe(201);
    expect((await post({ campo_extra: 1 })).status).toBe(400);
  });

  test('un firmante con huella guarda solo su hash y el dispositivo, nunca la imagen', async () => {
    const ag = await login('operador');
    const res = await ag.post('/api/firma/sello').send(valido({ firmantes: [firmante({ h_huella_png: 'b'.repeat(64), huella_dispositivo: 'DigitalPersona {1234}' })] }));
    expect(res.status).toBe(201);
    const { rows: [ev] } = await pool.query('SELECT firmantes FROM firma_eventos WHERE folio = $1', [res.body.folio]);
    expect(ev.firmantes[0]).toMatchObject({ con_huella: true, h_huella_png: 'b'.repeat(64), huella_dispositivo: 'DigitalPersona {1234}' });
    expect(JSON.stringify(ev.firmantes)).not.toMatch(/data:image|base64/);
  });

  test('registra la IP y el funcionario que asistió, y el sello los incluye', async () => {
    const ag = await login('operador');
    const res = await ag.post('/api/firma/sello').send(valido());
    const { rows: [ev] } = await pool.query('SELECT empleado_id, ip, h_final FROM firma_eventos WHERE folio = $1', [res.body.folio]);
    expect(ev.empleado_id).toBe(usuarios.operador.id);
    expect(ev.ip).toBeTruthy();
    expect(ev.h_final).toBeNull();
    expect(res.body.empleado).toBe('Firma Test');
    expect(res.body.ts).toBe(new Date(res.body.ts).toISOString());
    expect(verificarSello(res.body.token)).toMatchObject({ t: res.body.ts, e: usuarios.operador.id });
  });

  test('el mismo documento puede sellarse varias veces: cada una recibe su propio folio', async () => {
    const ag = await login('operador');
    const a = await ag.post('/api/firma/sello').send(valido());
    const b = await ag.post('/api/firma/sello').send(valido());
    expect(a.body.folio).not.toBe(b.body.folio);
    expect(a.body.token).not.toBe(b.body.token);
  });
});

describe('Firma — Verificación de sellos y clave pública', () => {
  test('POST /verificar-token confirma un sello propio y rechaza uno alterado', async () => {
    const ag = await login('lector');
    const op = await login('operador');
    const { body } = await op.post('/api/firma/sello').send(valido());
    const bien = await ag.post('/api/firma/verificar-token').send({ token: body.token });
    expect(bien.status).toBe(200);
    expect(bien.body).toMatchObject({ valido: true, folio: body.folio, h_original: sha('doc-original'), ts: body.ts });
    const [cuerpo, firma] = body.token.split('.');
    const otro = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(cuerpo, 'base64url')), h: H })).toString('base64url');
    expect((await ag.post('/api/firma/verificar-token').send({ token: `${otro}.${firma}` })).body.valido).toBe(false);
    expect((await ag.post('/api/firma/verificar-token').send({})).body.valido).toBe(false);
    expect((await ag.post('/api/firma/verificar-token').send({ token: 12345 })).body.valido).toBe(false);
  });

  test('POST /verificar-token exige sesión y permiso de lectura', async () => {
    expect((await request(app).post('/api/firma/verificar-token').send({ token: 'x.y' })).status).toBe(401);
    expect((await (await login('nada')).post('/api/firma/verificar-token').send({ token: 'x.y' })).status).toBe(403);
  });

  test('con la clave pública publicada, un tercero verifica el sello sin ayuda del servidor', async () => {
    const op = await login('operador');
    const { body } = await op.post('/api/firma/sello').send(valido());
    const pem = (await (await login('lector')).get('/api/firma/clave-publica')).text;
    const [cuerpo, firma] = body.token.split('.');
    expect(crypto.verify(null, Buffer.from(cuerpo), crypto.createPublicKey(pem), Buffer.from(firma, 'base64url'))).toBe(true);
  });

  test('un PDF de más de 20 MB no se acepta en /verificar', async () => {
    const ag = await login('lector');
    const grande = Buffer.alloc(21 * 1024 * 1024, 0x20);
    const res = await ag.post('/api/firma/verificar').attach('archivo', grande, 'grande.pdf');
    expect(res.status).toBe(400);
  });

  test('/verificar y /registro no escriben nada nuevo salvo el hash final una vez', async () => {
    const op = await login('operador');
    const { body } = await op.post('/api/firma/sello').send(valido());
    const { rows: [antes] } = await pool.query('SELECT count(*)::int AS n FROM firma_eventos WHERE empleado_id = $1', [usuarios.operador.id]);
    await (await login('lector')).post('/api/firma/verificar').attach('archivo', Buffer.from('%PDF-x'), 'x.pdf');
    await op.post('/api/firma/registro').send({ folio: body.folio, h_final: sha('final-xyz') });
    const { rows: [despues] } = await pool.query('SELECT count(*)::int AS n FROM firma_eventos WHERE empleado_id = $1', [usuarios.operador.id]);
    expect(despues.n).toBe(antes.n);
  });

  test('registro: exige folio uuid y hash válido, y un folio inexistente da 404', async () => {
    const op = await login('operador');
    expect((await op.post('/api/firma/registro').send({ folio: 'x', h_final: H })).status).toBe(400);
    expect((await op.post('/api/firma/registro').send({ folio: crypto.randomUUID(), h_final: 'zz' })).status).toBe(400);
    expect((await op.post('/api/firma/registro').send({ folio: crypto.randomUUID(), h_final: H })).status).toBe(404);
    expect((await op.post('/api/firma/registro').send({ folio: crypto.randomUUID(), h_final: H, extra: 1 })).status).toBe(400);
  });
});
