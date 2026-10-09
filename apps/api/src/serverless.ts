import 'reflect-metadata';
import { isIP } from 'node:net';
import { Logger } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { type ApiEnv, apiEnvSchema, EnvValidationError, loadEnv } from '@bedo/config';
import type { FastifyInstance } from 'fastify';
import { createApp } from './app.js';
import { DeferredTasks } from './runtime/deferred-tasks.service.js';
import { MaintenanceService } from './runtime/maintenance.service.js';
import { API_PUBLIC_PATH, FORWARDED_PROTO_HEADER } from './security/csrf.js';

/**
 * The API inside the website (D-36). The Next.js route app/api/[[...path]] hands every request under /api to
 * handleApiRequest(): the API application (NestJS on Fastify) is created once per server instance, never
 * listens on a port, and answers each request in the same process. Nothing runs between requests: work that
 * must not delay the response (one-time codes, push, realtime signals, housekeeping) is returned as a promise
 * for the platform to finish after the response (Next.js after(), Netlify waitUntil).
 */

interface ApiRuntime {
  app: NestFastifyApplication;
  fastify: FastifyInstance;
  deferred: DeferredTasks;
  maintenance: MaintenanceService;
}

export interface ApiRequestOptions {
  /**
   * Runs work after the response has been sent, keeping the invocation alive until it ends (Next.js after(),
   * Netlify waitUntil). Without it the work runs before the response is returned.
   */
  after?: (work: () => Promise<void>) => void;
}

export interface ApiHandler {
  handle(request: Request, options?: ApiRequestOptions): Promise<Response>;
  /** Waits for work after responses, then closes the application (tests, scripts). */
  close(): Promise<void>;
}

/**
 * Header Netlify sets on every request to the client's address as it connected to Netlify's edge. Netlify
 * replaces any value the client sent, so it is the address the per-address limits count against.
 */
export const CLIENT_IP_HEADER = 'x-nf-client-connection-ip';
/** Used when no client address is known (local runs): every such request shares one budget. */
const UNKNOWN_CLIENT_IP = '0.0.0.0';

/** Headers that describe one hop of a connection and must not be passed on. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer', 'host', 'content-length']);

function boot(app: NestFastifyApplication): ApiRuntime {
  return {
    app,
    fastify: app.getHttpAdapter().getInstance(),
    deferred: app.get(DeferredTasks),
    maintenance: app.get(MaintenanceService),
  };
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message, requestId: crypto.randomUUID() } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

let warnedNoClientIp = false;

/** The client's address for this request: Netlify's header when it holds an IP address. */
export function clientIp(request: Request): string {
  const value = request.headers.get(CLIENT_IP_HEADER)?.trim();
  if (value && isIP(value)) {
    return value;
  }
  if (!warnedNoClientIp && process.env.NODE_ENV === 'production') {
    // On Netlify the header is always there; without it every visitor would share one per-address budget.
    warnedNoClientIp = true;
    new Logger('Api').warn(`No client address in ${CLIENT_IP_HEADER}: per-address limits are shared by every such request`);
  }
  return UNKNOWN_CLIENT_IP;
}

/**
 * An API handler for one environment. The application is created on the first request and kept for the next
 * ones; if it fails to start (wrong configuration), the next request tries again.
 */
export function createApiHandler(
  source: Record<string, string | undefined> = process.env,
  /** Builds the application (tests pass one with stand-ins for Waabek, Web Push and Realtime). */
  createApplication: (env: ApiEnv) => Promise<NestFastifyApplication> = createApp,
): ApiHandler {
  let runtime: Promise<ApiRuntime> | null = null;
  const getRuntime = (): Promise<ApiRuntime> => {
    runtime ??= (async () => boot(await createApplication(loadEnv(apiEnvSchema, source))))().catch((error: unknown) => {
      runtime = null;
      throw error;
    });
    return runtime;
  };
  return {
    handle: (request, options = {}) => answer(getRuntime, request, options),
    async close() {
      const current = await runtime?.catch(() => null);
      runtime = null;
      if (current) {
        await current.deferred.drain();
        await current.app.close();
      }
    },
  };
}

let defaultHandler: ApiHandler | null = null;

/**
 * Answers one API request with the API configured from process.env. `request.url` is the public URL, e.g.
 * https://bedochat.com/api/v1/auth/otp/request.
 */
export function handleApiRequest(request: Request, options: ApiRequestOptions = {}): Promise<Response> {
  defaultHandler ??= createApiHandler(process.env);
  return defaultHandler.handle(request, options);
}

async function answer(getRuntime: () => Promise<ApiRuntime>, request: Request, options: ApiRequestOptions): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== API_PUBLIC_PATH && !url.pathname.startsWith(`${API_PUBLIC_PATH}/`)) {
    return errorResponse(404, 'NOT_FOUND', 'Not found.');
  }
  let api: ApiRuntime;
  try {
    api = await getRuntime();
  } catch (error) {
    // The configuration is wrong or the application failed to start: named in the logs, never in the response.
    const detail = error instanceof EnvValidationError || error instanceof Error ? error.message : String(error);
    new Logger('Api').error(`The API could not start: ${detail}`);
    return errorResponse(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable. Try again shortly.');
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name)) {
      headers[name] = value;
    }
  });
  // The site's own host, as the browser addressed it (the Host header; the URL only when there is none): what
  // the same-origin check compares the browser's Origin with.
  headers.host = request.headers.get('host') ?? url.host;
  headers[FORWARDED_PROTO_HEADER] = url.protocol === 'https:' ? 'https' : 'http';
  const method = request.method.toUpperCase();
  const payload = method === 'GET' || method === 'HEAD' ? undefined : Buffer.from(await request.arrayBuffer());

  const { result, background } = await api.deferred.runRequest(async () => {
    api.maintenance.poke();
    return api.fastify.inject({
      method: method as 'GET',
      url: `${url.pathname.slice(API_PUBLIC_PATH.length) || '/'}${url.search}`,
      headers,
      payload,
      remoteAddress: clientIp(request),
    });
  });

  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(result.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) {
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      responseHeaders.append(name, String(item));
    }
  }
  const empty = method === 'HEAD' || result.statusCode === 204 || result.statusCode === 304;
  const response = new Response(empty ? null : new Uint8Array(result.rawPayload), { status: result.statusCode, headers: responseHeaders });
  if (background) {
    if (options.after) {
      options.after(background);
    } else {
      await background();
    }
  }
  return response;
}
