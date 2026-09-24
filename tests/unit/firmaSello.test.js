import crypto from 'crypto';
import { firmarSello, verificarSello, clavePublicaPem } from '../../src/modules/firma/services/selloService.js';

// Sello Ed25519 del servidor: prueba de que Kernel emitió una constancia para un documento. No toca la base de datos.
const payload = { f: '3f6d1f0e-8a52-4c5e-9d0f-2b7d51f9c111', h: 'a'.repeat(64), t: '2026-09-24T15:00:00.000Z', e: '5b1d2a70-1111-4222-8333-944455556666' };
const partes = (token) => token.split('.');
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('Sello del servidor — emisión y verificación', () => {
  test('un sello recién emitido se verifica y devuelve el mismo contenido', () => {
    expect(verificarSello(firmarSello(payload))).toEqual(payload);
  });

  test('el token son dos partes base64url separadas por punto', () => {
    const [cuerpo, firma] = partes(firmarSello(payload));
    expect(partes(firmarSello(payload))).toHaveLength(2);
    expect(cuerpo).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(firma).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(firma, 'base64url')).toHaveLength(64);   // una firma Ed25519 mide 64 bytes
    expect(JSON.parse(Buffer.from(cuerpo, 'base64url').toString())).toEqual(payload);
  });

  test('Ed25519 es determinista: el mismo contenido da el mismo sello', () => {
    expect(firmarSello(payload)).toBe(firmarSello({ ...payload }));
    expect(firmarSello(payload)).not.toBe(firmarSello({ ...payload, h: 'b'.repeat(64) }));
  });

  test('cambiar cualquier dato del contenido invalida el sello', () => {
    const [, firma] = partes(firmarSello(payload));
    for (const cambio of [{ h: 'c'.repeat(64) }, { f: crypto.randomUUID() }, { t: '2027-01-01T00:00:00.000Z' }, { e: crypto.randomUUID() }]) {
      expect(verificarSello(`${b64u({ ...payload, ...cambio })}.${firma}`)).toBeNull();
    }
  });

  test('una firma copiada de otro sello no sirve', () => {
    const otro = firmarSello({ ...payload, h: 'd'.repeat(64) });
    const [cuerpo] = partes(firmarSello(payload));
    expect(verificarSello(`${cuerpo}.${partes(otro)[1]}`)).toBeNull();
  });

  test('una firma alterada o truncada no sirve', () => {
    const [cuerpo, firma] = partes(firmarSello(payload));
    const cambiada = (firma[0] === 'A' ? 'B' : 'A') + firma.slice(1);
    expect(verificarSello(`${cuerpo}.${cambiada}`)).toBeNull();
    expect(verificarSello(`${cuerpo}.${firma.slice(0, -4)}`)).toBeNull();
    expect(verificarSello(`${cuerpo}.`)).toBeNull();
  });

  test.each([undefined, null, '', 'sin-punto', '.', 'a.b.c', 'a.b', 12345, {}, [], '%%%.%%%'])('un token mal formado (%p) devuelve null sin lanzar error', (malo) => {
    expect(() => verificarSello(malo)).not.toThrow();
    expect(verificarSello(malo)).toBeNull();
  });

  test('un token enorme no rompe la verificación', () => {
    expect(verificarSello(`${'A'.repeat(200000)}.${'B'.repeat(200000)}`)).toBeNull();
  });

  test('admite caracteres especiales en el contenido', () => {
    const p = { ...payload, nombre: 'Ana María Ñandú — “prueba” 😀' };
    expect(verificarSello(firmarSello(p))).toEqual(p);
  });
});

describe('Sello del servidor — clave pública', () => {
  test('la clave pública sale en PEM y un tercero puede verificar el sello sin conocer la clave privada', () => {
    const pem = clavePublicaPem();
    expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    const publica = crypto.createPublicKey(pem);
    expect(publica.asymmetricKeyType).toBe('ed25519');
    const [cuerpo, firma] = partes(firmarSello(payload));
    expect(crypto.verify(null, Buffer.from(cuerpo), publica, Buffer.from(firma, 'base64url'))).toBe(true);
  });

  test('otra clave distinta no verifica el sello', () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const [cuerpo, firma] = partes(firmarSello(payload));
    expect(crypto.verify(null, Buffer.from(cuerpo), publicKey, Buffer.from(firma, 'base64url'))).toBe(false);
  });

  test('la clave pública es estable entre llamadas', () => {
    expect(clavePublicaPem()).toBe(clavePublicaPem());
  });
});
