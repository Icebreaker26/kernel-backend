import request from 'supertest';
import { createApp } from '../../src/createApp.js';
import pool from '../../src/db/database.js';

let app;
beforeAll(async () => { app = await createApp(); });
afterAll(async () => { await pool.end(); });

describe('Sitio público — videos de ayuda', () => {
  test.each(['que-es', 'web', 'app'])('/pub/tutoriales/%s redirige a una URL firmada del bucket, sin caché', async (clave) => {
    const res = await request(app).get(`/api/sitio/pub/tutoriales/${clave}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain(`kernel/sitio/tutoriales/${clave}.mp4`);
    expect(res.headers.location).toMatch(/X-Amz-Signature=/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');   // si no, el sitio no puede incrustar el video
  });

  test('una clave que no está en la lista da 404 (no se puede pedir otra ruta del bucket)', async () => {
    for (const clave of ['otro', '..%2F..%2Fsecreto', 'web.mp4']) {
      expect((await request(app).get(`/api/sitio/pub/tutoriales/${clave}`)).status).toBe(404);
    }
  });
});
