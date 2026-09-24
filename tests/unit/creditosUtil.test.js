import { jest } from '@jest/globals';
import { detectarTipo, validarUpload, sha256 } from '../../src/modules/creditos/services/creditoService.js';
import { construirCorreoAutorizacion } from '../../src/modules/creditos/services/correoAutorizacion.js';
import { ErrorNegocio, manejar } from '../../src/modules/creditos/http.js';
import {
  radicarSchema, actualizarSchema, borradorSchema, adjuntoSchema, firmaExternaSchema, firmadoSchema, autorizacionEnviarSchema,
  autorizacionRegistrarSchema, cierreSchema, reasignarSchema, devolverSchema, configEmpresaSchema, TIPOS_A_FIRMAR, TIPOS_ADJUNTO,
} from '../../src/modules/creditos/schemas/creditosSchema.js';

const uuid = () => crypto.randomUUID();
const PDF = Buffer.from('%PDF-1.7\n%%EOF');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe('Créditos — Detección de tipo de archivo (por contenido, no por extensión)', () => {
  test('reconoce PDF, JPEG y PNG por sus primeros bytes', () => {
    expect(detectarTipo(PDF)).toEqual({ mime: 'application/pdf', ext: 'pdf' });
    expect(detectarTipo(JPG)).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(detectarTipo(PNG)).toEqual({ mime: 'image/png', ext: 'png' });
  });

  test.each([
    ['ejecutable de Windows', Buffer.from('MZ\x90\x00')],
    ['texto plano', Buffer.from('hola mundo')],
    ['GIF', Buffer.from('GIF89a....')],
    ['vacío', Buffer.alloc(0)],
    ['PDF truncado', Buffer.from('%PDF')],
    ['PNG con firma incompleta', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ['HTML disfrazado', Buffer.from('<html><script>alert(1)</script>')],
  ])('rechaza %s', (_, buf) => {
    expect(detectarTipo(buf)).toBeNull();
  });
});

describe('Créditos — Validación de archivos subidos', () => {
  const archivo = (buffer, extra = {}) => ({ buffer, size: buffer.length, originalname: 'x.pdf', ...extra });
  const falla = (fn) => { try { fn(); } catch (e) { return e; } return null; };

  test('acepta un archivo permitido y devuelve su tipo', () => {
    expect(validarUpload(archivo(PDF), { permitidos: ['pdf'] })).toEqual({ mime: 'application/pdf', ext: 'pdf' });
    expect(validarUpload(archivo(PNG))).toEqual({ mime: 'image/png', ext: 'png' });
  });

  test('sin archivo → 400', () => {
    const e = falla(() => validarUpload(undefined));
    expect(e).toBeInstanceOf(ErrorNegocio);
    expect(e.status).toBe(400);
  });

  test('un tipo real no permitido → 400 aunque la extensión diga otra cosa', () => {
    const e = falla(() => validarUpload(archivo(PNG, { originalname: 'engano.pdf' }), { permitidos: ['pdf'] }));
    expect(e.status).toBe(400);
    expect(e.message).toMatch(/no permitido/i);
    expect(falla(() => validarUpload(archivo(Buffer.from('MZ....'), { originalname: 'a.pdf' })))?.status).toBe(400);
  });

  test('respeta el tamaño máximo', () => {
    expect(falla(() => validarUpload(archivo(PDF, { size: 16 * 1024 * 1024 })))?.message).toMatch(/pesa más de 15 MB/);
    expect(falla(() => validarUpload(archivo(PDF, { size: 16 * 1024 * 1024 }), { maxMB: 25 }))).toBeNull();
    expect(falla(() => validarUpload(archivo(PDF, { size: 26 * 1024 * 1024 }), { maxMB: 25 }))?.status).toBe(400);
  });

  test('sha256 coincide con el vector conocido', () => {
    expect(sha256(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('Créditos — Correo de autorización a la empresa', () => {
  const base = {
    asociado: { codigo: '1088000111', nombre: 'Ana', apellido: 'Gómez' }, empresa: 'Empresa Uno SA', radicado: 'CR-2026-000123',
    cuotaMensual: 260000, cuotas: 36, asesor: { nombre: 'Luis Pérez' },
  };

  test('lleva lo que la empresa necesita para decidir', () => {
    const { asunto, html, texto } = construirCorreoAutorizacion(base);
    expect(asunto).toBe('Solicitud de autorización de crédito — Ana Gómez — CR-2026-000123');
    for (const dato of ['Ana Gómez', '1088000111', 'Empresa Uno SA', 'CR-2026-000123', '36', 'Luis Pérez']) {
      expect(html).toContain(dato);
      expect(texto).toContain(dato);
    }
    expect(html).toMatch(/260[.,]000/);
  });

  test('no incluye datos financieros del asociado ni adjunta nada', () => {
    const { html, texto } = construirCorreoAutorizacion({ ...base, valorSolicitado: 9999999, categoria: 'Libre inversión', saldo: 123 });
    expect(html + texto).not.toMatch(/9\.?999\.?999|Libre inversi|saldo|aporte/i);
    expect(html).not.toMatch(/<a\s|href=|<img/i);
  });

  test('sin cuota ni número de cuotas, esas filas no aparecen', () => {
    const { texto, html } = construirCorreoAutorizacion({ ...base, cuotaMensual: null, cuotas: null });
    expect(texto).not.toMatch(/Cuota mensual|Número de cuotas/);
    expect(html).not.toMatch(/Cuota mensual|Número de cuotas/);
  });

  test('escapa el HTML de los datos (nadie inyecta marcado en el correo)', () => {
    const { html, asunto } = construirCorreoAutorizacion({ ...base, asociado: { codigo: '1', nombre: '<script>alert(1)</script>', apellido: '"x" & y' }, empresa: '<b>Empresa</b>', asesor: { nombre: '<img src=x>' } });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('<b>Empresa</b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;x&quot; &amp; y');
    expect(asunto).toContain('<script>');   // el asunto es texto plano: no se interpreta como HTML
  });

  test('pide responder al correo (la respuesta llega al asesor por Reply-To)', () => {
    const { html, texto } = construirCorreoAutorizacion(base);
    expect(html).toMatch(/responda a este correo/i);
    expect(texto).toMatch(/responda a este correo/i);
  });
});

describe('Créditos — Errores de negocio y respuesta HTTP', () => {
  const res = () => { const r = { estado: null, cuerpo: null }; r.status = (s) => { r.estado = s; return r; }; r.json = (b) => { r.cuerpo = b; return r; }; return r; };

  test('un ErrorNegocio se responde tal cual, con su código y datos extra', async () => {
    const r = res(); const next = jest.fn();
    await manejar(async () => { throw new ErrorNegocio(409, 'Falta algo', { faltantes: ['a', 'b'] }); })({}, r, next);
    expect(r.estado).toBe(409);
    expect(r.cuerpo).toEqual({ error: 'Falta algo', faltantes: ['a', 'b'] });
    expect(next).not.toHaveBeenCalled();
  });

  test('cualquier otro error se delega al errorHandler', async () => {
    const r = res(); const next = jest.fn(); const boom = new Error('boom');
    await manejar(async () => { throw boom; })({}, r, next);
    expect(next).toHaveBeenCalledWith(boom);
    expect(r.estado).toBeNull();
  });

  test('sin error, el controlador responde normalmente', async () => {
    const r = res(); const next = jest.fn();
    await manejar(async (_req, resp) => resp.json({ ok: true }))({}, r, next);
    expect(r.cuerpo).toEqual({ ok: true });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('Créditos — Esquemas de validación (Zod)', () => {
  const valido = () => ({
    asociado_codigo: '1088000111', categoria_id: uuid(), canal_origen: 'presencial', valor_solicitado: 5000000,
    forma_desembolso: 'cheque', modalidad_firma: 'presencial',
  });
  const ok = (schema, d) => schema.safeParse(d).success;
  const mensajes = (schema, d) => schema.safeParse(d).error.issues.map((i) => i.message).join(' | ');

  test('radicar: acepta un cuerpo válido y convierte números que llegan como texto', () => {
    expect(ok(radicarSchema, valido())).toBe(true);
    const r = radicarSchema.parse({ ...valido(), valor_solicitado: '8000000', cuotas: '36', cuota_mensual: '260000' });
    expect(r).toMatchObject({ valor_solicitado: 8000000, cuotas: 36, cuota_mensual: 260000 });
  });

  test('radicar: rechaza campos de más, montos no positivos, formas y canales desconocidos', () => {
    for (const malo of [{ x: 1 }, { valor_solicitado: 0 }, { valor_solicitado: -1 }, { valor_solicitado: 'abc' }, { forma_desembolso: 'trueque' }, { canal_origen: 'fax' }, { categoria_id: 'no-uuid' }, { cuotas: 0 }, { cuotas: 241 }, { modalidad_firma: 'otra' }, { asociado_codigo: 'ab' }]) {
      expect(ok(radicarSchema, { ...valido(), ...malo })).toBe(false);
    }
  });

  test('radicar: el monto a desembolsar y su motivo ya no se aceptan (los calcula Cartera)', () => {
    expect(ok(radicarSchema, { ...valido(), monto_desembolso: 4000000 })).toBe(false);
    expect(ok(radicarSchema, { ...valido(), motivo_diferencia: 'Seguros' })).toBe(false);
    expect(ok(actualizarSchema, { monto_desembolso: 4000000 })).toBe(false);
  });

  test('radicar: la firma externa exige proveedor; los textos vacíos cuentan como ausentes', () => {
    expect(mensajes(radicarSchema, { ...valido(), modalidad_firma: 'externa' })).toMatch(/proveedor/i);
    expect(mensajes(radicarSchema, { ...valido(), modalidad_firma: 'externa', proveedor_externo: '' })).toMatch(/proveedor/i);
    expect(ok(radicarSchema, { ...valido(), modalidad_firma: 'externa', proveedor_externo: 'Firmamos SA' })).toBe(true);
    expect(radicarSchema.parse({ ...valido(), observaciones: '' }).observaciones).toBeUndefined();
  });

  test('radicar: normaliza y valida los correos (máximo 5)', () => {
    expect(radicarSchema.parse({ ...valido(), emails_autorizacion: ['  Nomina@Empresa.COM '] }).emails_autorizacion).toEqual(['nomina@empresa.com']);
    expect(ok(radicarSchema, { ...valido(), emails_autorizacion: ['no-es-correo'] })).toBe(false);
    expect(ok(radicarSchema, { ...valido(), emails_autorizacion: Array.from({ length: 6 }, (_, i) => `a${i}@e.com`) })).toBe(false);
  });

  test('actualizar: es estricto y todo es opcional', () => {
    expect(ok(actualizarSchema, {})).toBe(true);
    expect(ok(actualizarSchema, { observaciones: 'x', cuotas: 12 })).toBe(true);
    expect(ok(actualizarSchema, { asociado_codigo: '123' })).toBe(false);   // no se cambia el asociado
    expect(ok(actualizarSchema, { modalidad_firma: 'externa' })).toBe(false);   // ni la modalidad
  });

  test('tipos de documento: solo los cinco que la cooperativa firma, y los adjuntos definidos', () => {
    expect(TIPOS_A_FIRMAR).toEqual(['carta_instrucciones', 'libranza', 'pagare', 'solicitud_credito', 'proyeccion']);
    expect(TIPOS_ADJUNTO).toEqual(['desprendible_nomina', 'certificado_bancario', 'otro_adjunto']);
    for (const t of TIPOS_A_FIRMAR) expect(ok(borradorSchema, { tipo: t })).toBe(true);
    for (const t of ['otro', 'autorizacion_descuento', 'desprendible_nomina', '']) expect(ok(borradorSchema, { tipo: t })).toBe(false);
    for (const t of TIPOS_ADJUNTO) expect(ok(adjuntoSchema, { tipo: t })).toBe(true);
    expect(ok(adjuntoSchema, { tipo: 'pagare' })).toBe(false);
  });

  test('firma externa: proveedor con al menos 2 caracteres y fecha AAAA-MM-DD; la evidencia no es un campo', () => {
    const b = { borrador_id: uuid(), proveedor: 'Firmamos', fecha_firma: '2026-09-20' };
    expect(ok(firmaExternaSchema, b)).toBe(true);
    expect(ok(firmaExternaSchema, { ...b, proveedor: 'P' })).toBe(false);
    expect(ok(firmaExternaSchema, { ...b, fecha_firma: '20/09/2026' })).toBe(false);
    expect(ok(firmaExternaSchema, { ...b, borrador_id: 'x' })).toBe(false);
    expect(ok(firmaExternaSchema, { ...b, id_transaccion: '' })).toBe(true);
  });

  test('firmado presencial: solo el folio (el archivo va aparte)', () => {
    expect(ok(firmadoSchema, { folio: uuid() })).toBe(true);
    expect(ok(firmadoSchema, { folio: uuid(), key: 'kernel/x.pdf' })).toBe(false);   // ya no se acepta una llave de S3 del navegador
    expect(ok(firmadoSchema, { folio: 'x' })).toBe(false);
  });

  test('autorización: aprobar exige fecha; rechazar exige motivo; el canal por defecto es correo', () => {
    expect(mensajes(autorizacionRegistrarSchema, { decision: 'aprobada' })).toMatch(/fecha/i);
    expect(mensajes(autorizacionRegistrarSchema, { decision: 'rechazada' })).toMatch(/motivo/i);
    expect(autorizacionRegistrarSchema.parse({ decision: 'aprobada', fecha_autorizacion: '2026-09-22' }).canal).toBe('correo');
    expect(ok(autorizacionRegistrarSchema, { decision: 'rechazada', motivo_rechazo: 'Cuota alta' })).toBe(true);
    expect(ok(autorizacionRegistrarSchema, { decision: 'quizas' })).toBe(false);
    expect(ok(autorizacionRegistrarSchema, { decision: 'aprobada', fecha_autorizacion: '2026-09-22', canal: 'paloma' })).toBe(false);
    expect(ok(autorizacionEnviarSchema, {})).toBe(true);
    expect(ok(autorizacionEnviarSchema, { emails: [] })).toBe(false);
  });

  test('cierre, devolución y reasignación piden un motivo real', () => {
    expect(ok(cierreSchema, { estado: 'desistida', motivo: 'ya no lo necesita' })).toBe(true);
    expect(ok(cierreSchema, { estado: 'aprobada', motivo: 'ya no lo necesita' })).toBe(false);
    expect(ok(cierreSchema, { estado: 'desistida', motivo: 'ab' })).toBe(false);
    expect(ok(devolverSchema, { motivo: 'Desprendible ilegible' })).toBe(true);
    expect(ok(devolverSchema, { motivo: '  x ' })).toBe(false);
    expect(ok(reasignarSchema, { asesor_uuid: uuid(), motivo: 'Vacaciones' })).toBe(true);
    expect(ok(reasignarSchema, { asesor_uuid: 'x', motivo: 'Vacaciones' })).toBe(false);
    expect(ok(reasignarSchema, { asesor_uuid: uuid(), motivo: 'Vacaciones', extra: 1 })).toBe(false);
  });

  test('configuración de empresa: momento válido y hasta 5 correos', () => {
    const c = { requiere_autorizacion: true, momento_autorizacion: 'despues_firma', emails_autorizacion: ['n@e.com'] };
    expect(ok(configEmpresaSchema, c)).toBe(true);
    expect(ok(configEmpresaSchema, { ...c, momento_autorizacion: 'nunca' })).toBe(false);
    expect(ok(configEmpresaSchema, { ...c, requiere_autorizacion: 'si' })).toBe(false);
    expect(ok(configEmpresaSchema, { ...c, emails_autorizacion: [] })).toBe(true);
    expect(ok(configEmpresaSchema, { ...c, emails_autorizacion: ['mal'] })).toBe(false);
  });
});
