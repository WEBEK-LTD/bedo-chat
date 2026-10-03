import 'reflect-metadata';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testEnv } from './helpers.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Polls readiness until it matches, instead of sleeping a fixed time (Redis connects in the background). */
async function readyWhen(server: NestFastifyApplication, predicate: (body: { checks: Record<string, { status: string }> }) => boolean) {
  let response = await server.inject({ method: 'GET', url: '/health/ready' });
  for (let attempt = 0; attempt < 50 && !predicate(response.json()); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    response = await server.inject({ method: 'GET', url: '/health/ready' });
  }
  return response;
}

async function start(overrides: Record<string, string>) {
  app = await createApp(testEnv({ HEALTH_CHECK_TIMEOUT_MS: '1000', ...overrides }));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe.runIf(databaseUrl && redisUrl)('readiness against real Postgres and Redis', () => {
  it('reports both dependencies up', async () => {
    const server = await start({ DATABASE_URL: databaseUrl!, REDIS_URL: redisUrl! });
    const response = await readyWhen(server, (body) => body.checks.redis?.status === 'up');
    expect(response.json()).toMatchObject({ status: 'ok', checks: { database: { status: 'up' }, redis: { status: 'up' } } });
    expect(response.statusCode).toBe(200);
  });

  it('reports Redis down when it is unreachable, without blocking start-up', async () => {
    const server = await start({ DATABASE_URL: databaseUrl!, REDIS_URL: 'redis://127.0.0.1:6390' });
    const response = await server.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ checks: { database: { status: 'up' }, redis: { status: 'down' } } });
    const live = await server.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
  });

  it('reports Postgres down when it is unreachable', async () => {
    const server = await start({ DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5499/postgres', REDIS_URL: redisUrl! });
    const response = await readyWhen(server, (body) => body.checks.redis?.status === 'up');
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ checks: { database: { status: 'down' }, redis: { status: 'up' } } });
  });
});
