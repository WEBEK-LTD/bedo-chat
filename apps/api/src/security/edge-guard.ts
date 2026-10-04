import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiEnv } from '@bedo/config';
import type { ErrorEnvelope } from '@bedo/contracts';
import type { FastifyInstance } from 'fastify';

/** Header the Cloudflare Worker adds to every request it forwards to the API (D-25). */
export const EDGE_SECRET_HEADER = 'x-bedo-edge-secret';

/** Health checks stay reachable without the secret for the host's own container health checks. */
const OPEN_PATHS = new Set(['/health/live', '/health/ready']);

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

/**
 * With EDGE_SECRET set, the API answers only requests that came through the edge router (D-25). Anyone
 * calling the API host directly, including from another Cloudflare account, is refused before any route
 * runs, so the client address (X-Forwarded-For) the per-IP code limits rely on is always the edge's.
 */
export function registerEdgeGuard(fastify: FastifyInstance, env: ApiEnv): void {
  if (!env.EDGE_SECRET) {
    return;
  }
  const expected = digest(env.EDGE_SECRET);
  fastify.addHook('onRequest', async (request, reply) => {
    if (OPEN_PATHS.has(request.url.split('?')[0] ?? '')) {
      return;
    }
    const provided = request.headers[EDGE_SECRET_HEADER];
    if (typeof provided === 'string' && timingSafeEqual(digest(provided), expected)) {
      return;
    }
    const body: ErrorEnvelope = {
      error: { code: 'FORBIDDEN', message: 'You do not have permission to do this.', requestId: String(request.id) },
    };
    await reply.code(403).header('content-type', 'application/json; charset=utf-8').send(body);
  });
}
