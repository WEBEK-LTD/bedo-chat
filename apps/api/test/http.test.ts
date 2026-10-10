import { Controller, Get, Post, Body } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { ResponseSchema } from '../src/common/response-schema.js';
import { ZodValidationPipe } from '../src/common/zod-validation.pipe.js';
import { buildTestApp, testEnv } from './helpers.js';

const publicGroupSchema = z.object({ id: z.string(), title: z.string() });

@Controller('test')
class ContractTestController {
  @Get('strips')
  @ResponseSchema(publicGroupSchema)
  strips() {
    return { id: 'g1', title: 'Group', memberCount: 1234, members: [{ name: 'hidden' }] };
  }

  @Get('broken')
  @ResponseSchema(publicGroupSchema)
  broken() {
    return { id: 42 };
  }

  @Get('unvalidated')
  unvalidated() {
    return { secret: 'value' };
  }

  @Get('crash')
  @ResponseSchema(publicGroupSchema)
  crash(): never {
    throw new Error('SELECT * FROM app.users -- internal detail');
  }

  @Post('echo')
  @ResponseSchema(publicGroupSchema)
  echo(@Body(new ZodValidationPipe(publicGroupSchema)) body: z.infer<typeof publicGroupSchema>) {
    return body;
  }
}

let app: NestFastifyApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('response contracts', () => {
  it('removes every field the contract does not list', async () => {
    app = await buildTestApp({ extraControllers: [ContractTestController] });
    const response = await app.inject({ method: 'GET', url: '/test/strips' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: 'g1', title: 'Group' });
    expect(response.body).not.toContain('memberCount');
    expect(response.body).not.toContain('hidden');
  });

  it('refuses to send a response that breaks its contract', async () => {
    app = await buildTestApp({ extraControllers: [ContractTestController] });
    const response = await app.inject({ method: 'GET', url: '/test/broken' });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL');
  });

  it('refuses to send a response from a route without a contract', async () => {
    app = await buildTestApp({ extraControllers: [ContractTestController] });
    const response = await app.inject({ method: 'GET', url: '/test/unvalidated' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('secret');
  });
});

describe('error envelope', () => {
  it('hides internal error details and returns the request id', async () => {
    app = await buildTestApp({ extraControllers: [ContractTestController] });
    const response = await app.inject({ method: 'GET', url: '/test/crash' });
    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body).toEqual({ error: { code: 'INTERNAL', message: 'Something went wrong.', requestId: expect.any(String) } });
    expect(response.body).not.toContain('SELECT');
    expect(response.headers['x-request-id']).toBe(body.error.requestId);
  });

  it('returns NOT_FOUND for unknown routes', async () => {
    app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('returns field errors for invalid request bodies', async () => {
    app = await buildTestApp({ extraControllers: [ContractTestController] });
    const response = await app.inject({ method: 'POST', url: '/test/echo', payload: { id: 1 } });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.fields.map((field: { path: string }) => field.path)).toEqual(
      expect.arrayContaining(['id', 'title']),
    );
  });

  it('rejects malformed JSON with the standard envelope', async () => {
    app = await buildTestApp({ extraControllers: [ContractTestController] });
    const response = await app.inject({
      method: 'POST',
      url: '/test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('request ids and headers', () => {
  it('ignores an incoming request id when no proxy is trusted', async () => {
    app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/health/live', headers: { 'x-request-id': 'edge-req-12345' } });
    expect(response.headers['x-request-id']).not.toBe('edge-req-12345');
  });

  it('always mints its own request id (D-36: no proxy is trusted)', async () => {
    app = await buildTestApp();
    for (const incoming of ['edge-req-12345', 'bad id\n']) {
      const response = await app.inject({ method: 'GET', url: '/health/live', headers: { 'x-request-id': incoming } });
      expect(response.headers['x-request-id']).not.toBe(incoming);
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('sets security headers on every response', async () => {
    app = await buildTestApp();
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });

  it('adds HSTS in production', async () => {
    app = await buildTestApp({ env: testEnv({ NODE_ENV: 'production' }) });
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
  });
});

describe('CORS (D-36: one origin, so no other site is ever allowed)', () => {
  it('does not allow any other origin', async () => {
    app = await buildTestApp();
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/health/live',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
