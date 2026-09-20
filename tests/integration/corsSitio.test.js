import request from 'supertest';
import { jest } from '@jest/globals';

jest.setTimeout(30000);

// El origen del sitio público se lee de la configuración al cargar: se fija antes de importar la app
process.env.SITIO_URL = 'https://sitio-publico.ejemplo.co/';
const { createApp } = await import('../../src/createApp.js');
const { default: pool } = await import('../../src/db/database.js');

let app;
beforeAll(async () => { app = await createApp(); });
afterAll(async () => { await pool.end(); });

describe('CORS — el sitio público en otro dominio', () => {
  test('el origen del sitio (SITIO_URL, con o sin barra final) puede leer la API pública', async () => {
    const res = await request(app).get('/api/transparencia/pub').set('Origin', 'https://sitio-publico.ejemplo.co');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://sitio-publico.ejemplo.co');
  });

  test('un POST público con el header anti-CSRF pasa el preflight desde el sitio', async () => {
    const res = await request(app).options('/api/captacion/pub/web/visita')
      .set('Origin', 'https://sitio-publico.ejemplo.co')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'x-requested-with,content-type');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://sitio-publico.ejemplo.co');
    expect(res.headers['access-control-allow-headers'].toLowerCase()).toContain('x-requested-with');
  });

  test('al sitio se le responde SIN credenciales: el navegador no le enviará la sesión de Kernel', async () => {
    const res = await request(app).get('/api/transparencia/pub').set('Origin', 'https://sitio-publico.ejemplo.co');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  test('el sitio NO tiene permiso CORS en rutas privadas, ni siquiera en el preflight', async () => {
    for (const ruta of ['/api/pqrs', '/api/asociados', '/api/admin/usuarios', '/api/pqrs/pub/../algo']) {
      const res = await request(app).get(ruta).set('Origin', 'https://sitio-publico.ejemplo.co');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
    const pre = await request(app).options('/api/pqrs')
      .set('Origin', 'https://sitio-publico.ejemplo.co')
      .set('Access-Control-Request-Method', 'GET');
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('Kernel (FRONTEND_URL) sigue funcionando con cookies', async () => {
    const origen = process.env.FRONTEND_URL || 'http://localhost:5173';
    const res = await request(app).get('/api/transparencia/pub').set('Origin', origen);
    expect(res.headers['access-control-allow-origin']).toBe(origen);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  test('otro origen no recibe permiso CORS', async () => {
    const res = await request(app).get('/api/transparencia/pub').set('Origin', 'https://otro-sitio.ejemplo.co');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
