const request = require('supertest');
const app = require('../src/app');

describe('santé', () => {
  test('GET /healthz renvoie 200', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
  test('route protégée sans jeton renvoie 401', async () => {
    const res = await request(app).get('/api/appointments');
    expect(res.status).toBe(401);
  });
});
