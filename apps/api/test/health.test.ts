import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, down, hanging } from './helpers.js';

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health/live', () => {
  it('returns ok without touching dependencies', async () => {
    app = await buildTestApp({ database: down, redis: down });
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /health/ready', () => {
  it('returns 200 when Postgres and Redis are up', async () => {
    app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.checks.database.status).toBe('up');
    expect(body.checks.redis.status).toBe('up');
  });

  it('returns 503 and names the failing dependency', async () => {
    app = await buildTestApp({ redis: down });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'unavailable',
      checks: { database: { status: 'up' }, redis: { status: 'down' } },
    });
  });

  it('treats a dependency that does not answer in time as down', async () => {
    app = await buildTestApp({ database: hanging });
    const started = Date.now();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json().checks.database.status).toBe('down');
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
