import { afterEach, describe, expect, it } from 'vitest';
import { type ApiHandler, createApiHandler } from '../src/serverless.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const BASE_ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  HEALTH_CHECK_TIMEOUT_MS: '1000',
  ACCESS_TOKEN_SECRET: 'test-access-token-secret-0123456789abcdef',
  OTP_HMAC_SECRET: 'test-otp-hmac-secret-0123456789abcdef-xyz',
  ADMIN_TOTP_KEY: Buffer.alloc(32, 9).toString('base64'),
  SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 10).toString('base64'),
};

let handler: ApiHandler | undefined;

afterEach(async () => {
  await handler?.close();
  handler = undefined;
});

const get = (path: string) => handler!.handle(new Request(`https://bedochat.test${path}`));

/**
 * D-36: the API as the website runs it (serverless.ts): created on the first request, answering under /api,
 * with Postgres its only dependency.
 */
describe.runIf(databaseUrl)('the API inside the website, against real Postgres', () => {
  it('answers /api/health/ready with the database up', async () => {
    handler = createApiHandler({ ...BASE_ENV, DATABASE_URL: databaseUrl! });
    const response = await get('/api/health/ready');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', checks: { database: { status: 'up' } } });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('reports Postgres down when it is unreachable, and stays live', async () => {
    handler = createApiHandler({ ...BASE_ENV, DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5499/postgres' });
    const response = await get('/api/health/ready');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'unavailable', checks: { database: { status: 'down' } } });
    expect((await get('/api/health/live')).status).toBe(200);
  });

  it('answers only under /api, and a wrong configuration with 503 without naming it', async () => {
    handler = createApiHandler({ ...BASE_ENV, DATABASE_URL: databaseUrl! });
    expect((await get('/health/live')).status).toBe(404);
    expect((await get('/apix/health/live')).status).toBe(404);
    expect((await get('/api/nothing-here')).status).toBe(404);
    await handler.close();
    handler = createApiHandler({ ...BASE_ENV, DATABASE_URL: databaseUrl!, ACCESS_TOKEN_SECRET: 'short' });
    const broken = await get('/api/health/live');
    expect(broken.status).toBe(503);
    const text = await broken.text();
    expect(text).toContain('SERVICE_UNAVAILABLE');
    expect(text).not.toContain('ACCESS_TOKEN_SECRET');
  });
});
