import { describe, expect, it } from 'vitest';
import { errorEnvelopeSchema, readyResponseSchema } from './index.js';
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
