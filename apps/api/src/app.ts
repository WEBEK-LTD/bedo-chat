import { randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ApiEnv } from '@bedo/config';
import { AppModule } from './app.module.js';

const BODY_LIMIT_BYTES = 1024 * 1024;

export function buildFastifyAdapter(env: ApiEnv): FastifyAdapter {
  return new FastifyAdapter({
    // D-36: requests reach the API only from the website's /api route, in the same process, which passes the
    // client address Netlify saw (see serverless.ts). No proxy header is trusted.
    trustProxy: false,
    bodyLimit: BODY_LIMIT_BYTES,
    // Request ids are always minted here, so clients cannot choose the ids that appear in logs.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    logger:
      env.LOG_LEVEL === 'silent'
        ? false
        : {
            level: env.LOG_LEVEL,
            redact: {
              paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
              censor: '[redacted]',
            },
          },
  });
}

/** Cross-cutting HTTP behaviour shared by the website's /api route and the tests. */
export async function configureApp(app: NestFastifyApplication, env: ApiEnv): Promise<void> {
  // Cookies carry the web refresh token and the admin session (httpOnly, never readable by scripts).
  await app.register(fastifyCookie as never);
  // D-36: no CORS. The web app, the Admin Dashboard and the API share one origin (https://bedochat.com), so
  // no other site is ever allowed to call the API from a browser.

  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onSend', async (request, reply, payload) => {
    void reply.header('x-request-id', String(request.id));
    void reply.header('x-content-type-options', 'nosniff');
    void reply.header('x-frame-options', 'DENY');
    void reply.header('referrer-policy', 'no-referrer');
    void reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    void reply.header('cache-control', 'no-store');
    if (env.NODE_ENV === 'production') {
      void reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });
}

const NEST_LOG_LEVELS: Record<Exclude<ApiEnv['LOG_LEVEL'], 'silent'>, LogLevel[]> = {
  fatal: ['fatal'],
  error: ['fatal', 'error'],
  warn: ['fatal', 'error', 'warn'],
  info: ['fatal', 'error', 'warn', 'log'],
  debug: ['fatal', 'error', 'warn', 'log', 'debug'],
  trace: ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'],
};

/** Application logs: JSON lines in production (for log collectors), readable text in development. */
export function buildLogger(env: Pick<ApiEnv, 'LOG_LEVEL' | 'NODE_ENV'>): ConsoleLogger | false {
  if (env.LOG_LEVEL === 'silent') {
    return false;
  }
  const production = env.NODE_ENV === 'production';
  return new ConsoleLogger({ json: production, colors: !production, logLevels: NEST_LOG_LEVELS[env.LOG_LEVEL] });
}

/** The API application, initialised but not listening: requests are passed in by the website (serverless.ts). */
export async function createApp(env: ApiEnv): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(env), buildFastifyAdapter(env), {
    logger: buildLogger(env),
  });
  await configureApp(app, env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
