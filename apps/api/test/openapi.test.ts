import { buildOpenApiDocument } from '@bedo/contracts/openapi';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

describe('OpenAPI document', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('describes only routes the API actually serves', () => {
    const fastify = app.getHttpAdapter().getInstance();
    const document = buildOpenApiDocument({ version: 'test' });
    const operations = Object.entries(document.paths ?? {}).flatMap(([url, item]) =>
      METHODS.filter((method) => item && method in item).map((method) => ({ method: method.toUpperCase(), url })),
    );
    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) {
      expect(fastify.hasRoute(operation as { method: 'GET'; url: string }), `${operation.method} ${operation.url}`).toBe(true);
    }
  });
});
