import { buildOpenApiDocument } from '@bedo/contracts/openapi';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** OpenAPI paths use {param}; Fastify uses :param. */
const toFastifyPath = (path: string) => path.replace(/\{(\w+)\}/g, ':$1');

describe('OpenAPI document', () => {
  let app: NestFastifyApplication;
  const served: string[] = [];

  beforeAll(async () => {
    app = await buildTestApp({
      onRoute: (route) => {
        for (const method of [route.method].flat()) {
          // HEAD is added automatically for GET routes, OPTIONS by CORS preflight handling.
          if (method !== 'HEAD' && method !== 'OPTIONS') {
            served.push(`${method} ${route.url}`);
          }
        }
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const documented = () => {
    const document = buildOpenApiDocument({ version: 'test' });
    return Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      METHODS.filter((method) => item && method in item).map((method) => `${method.toUpperCase()} ${toFastifyPath(path)}`),
    );
  };

  it('describes only routes the API actually serves', () => {
    const fastify = app.getHttpAdapter().getInstance();
    const operations = documented();
    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) {
      const [method, url] = operation.split(' ') as ['GET', string];
      expect(fastify.hasRoute({ method, url }), operation).toBe(true);
    }
  });

  it('describes every route the API serves', () => {
    expect(served.length).toBeGreaterThan(0);
    expect([...new Set(served)].sort()).toEqual([...new Set(documented())].sort());
  });

  it('gives every operation a unique operationId', () => {
    const document = buildOpenApiDocument({ version: 'test' });
    const ids = Object.values(document.paths ?? {}).flatMap((item) =>
      METHODS.flatMap((method) => {
        const operation = item?.[method];
        return operation ? [operation.operationId] : [];
      }),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});
