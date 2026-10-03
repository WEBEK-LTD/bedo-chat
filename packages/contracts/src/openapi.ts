import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { errorEnvelopeSchema } from './common.js';
import { liveResponseSchema, readyResponseSchema } from './health.js';

// Adds .openapi() to Zod schemas created from now on. Only this module (used by the API build and
// tests) loads it, so clients importing '@bedo/contracts' get plain Zod schemas without the OpenAPI
// library. Zod 4 attaches methods per instance, so the shared schemas are cloned before registration.
extendZodWithOpenApi(z);
const forOpenApi = <T extends z.ZodType>(schema: T): T => schema.clone();

export interface OpenApiDocumentOptions {
  version: string;
  serverUrl?: string;
}

/**
 * Builds the OpenAPI 3.1 document from the shared Zod contracts.
 * Every endpoint added in later phases registers its request and response schemas here,
 * so the document, the server's response validation and the generated client never drift apart.
 */
export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

export function buildOpenApiDocument(options: OpenApiDocumentOptions): OpenApiDocument {
  const registry = new OpenAPIRegistry();

  const errorEnvelope = registry.register('ErrorEnvelope', forOpenApi(errorEnvelopeSchema));
  const liveResponse = registry.register('LiveResponse', forOpenApi(liveResponseSchema));
  const readyResponse = registry.register('ReadyResponse', forOpenApi(readyResponseSchema));

  registry.registerPath({
    method: 'get',
    path: '/health/live',
    operationId: 'getHealthLive',
    tags: ['Health'],
    summary: 'Process liveness',
    responses: {
      200: { description: 'The API process is running.', content: { 'application/json': { schema: liveResponse } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/health/ready',
    operationId: 'getHealthReady',
    tags: ['Health'],
    summary: 'Readiness of the API and its dependencies',
    responses: {
      200: {
        description: 'Postgres and Redis are reachable.',
        content: { 'application/json': { schema: readyResponse } },
      },
      503: {
        description: 'At least one dependency is unreachable.',
        content: { 'application/json': { schema: readyResponse } },
      },
      500: { description: 'Unexpected error.', content: { 'application/json': { schema: errorEnvelope } } },
    },
  });

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: { title: 'Bedo Chat API', version: options.version },
    ...(options.serverUrl ? { servers: [{ url: options.serverUrl }] } : {}),
  });
}
