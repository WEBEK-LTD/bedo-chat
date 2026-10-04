import { describe, expect, it } from 'vitest';
import { errorEnvelopeSchema, isPushServiceUrl, readyResponseSchema } from './index.js';
import { buildOpenApiDocument } from './openapi.js';

describe('response schemas', () => {
  it('strip fields that are not part of the contract', () => {
    const parsed = readyResponseSchema.parse({
      status: 'ok',
      checks: {
        database: { status: 'up', latencyMs: 3, connectionString: 'postgres://secret' },
        redis: { status: 'up', latencyMs: 1 },
      },
      internalNote: 'must not leak',
    });
    expect(parsed).toEqual({
      status: 'ok',
      checks: { database: { status: 'up', latencyMs: 3 }, redis: { status: 'up', latencyMs: 1 } },
    });
  });

  it('reject an unknown error code', () => {
    const result = errorEnvelopeSchema.safeParse({ error: { code: 'BOOM', message: 'x', requestId: 'r' } });
    expect(result.success).toBe(false);
  });
});

describe('buildOpenApiDocument', () => {
  const document = buildOpenApiDocument({ version: '0.1.0' });

  it('is an OpenAPI 3.1 document with the health endpoints', () => {
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths ?? {})).toEqual(expect.arrayContaining(['/health/live', '/health/ready']));
  });

  it('registers shared components by name', () => {
    expect(Object.keys(document.components?.schemas ?? {})).toEqual(
      expect.arrayContaining(['ErrorEnvelope', 'LiveResponse', 'ReadyResponse']),
    );
  });
});

describe('push subscription endpoints', () => {
  it('accept only browser push services over https on the default port', () => {
    for (const url of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
      'https://web.push.apple.com/abc',
    ]) {
      expect(isPushServiceUrl(url), url).toBe(true);
    }
    for (const url of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/x',
      'https://fcm.googleapis.com.evil.example/x',
      'https://evilfcm.googleapis.com.example/x',
      'https://10.0.0.5/x',
      'https://localhost/x',
      'not a url',
    ]) {
      expect(isPushServiceUrl(url), url).toBe(false);
    }
  });
});
