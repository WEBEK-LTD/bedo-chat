import { randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ApiEnv } from '@bedo/config';
import type { IncomingMessage } from 'node:http';
import { AppModule } from './app.module.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;
const BODY_LIMIT_BYTES = 1024 * 1024;

export function buildFastifyAdapter(env: ApiEnv): FastifyAdapter {
  return new FastifyAdapter({
    // Trust exactly the configured number of proxy hops when deriving the client IP.
    trustProxy: env.API_TRUST_PROXY_HOPS > 0 ? (_address: string, hop: number) => hop < env.API_TRUST_PROXY_HOPS : false,
    bodyLimit: BODY_LIMIT_BYTES,
    // Reuse a well-formed request id only when it comes from a trusted proxy; otherwise mint one,
    // so clients cannot choose the ids that appear in logs.
    requestIdHeader: false,
    genReqId: (request: IncomingMessage) => {
      const incoming = request.headers['x-request-id'];
      return env.API_TRUST_PROXY_HOPS > 0 && typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    },
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

/** Cross-cutting HTTP behaviour shared by the real server and the tests. */
export async function configureApp(app: NestFastifyApplication, env: ApiEnv): Promise<void> {
  // Cookies carry the web refresh token and the admin session (httpOnly, never readable by scripts).
  await app.register(fastifyCookie as never);

  app.enableCors({
    origin: env.CORS_ALLOWED_ORIGINS.length > 0 ? env.CORS_ALLOWED_ORIGINS : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'authorization', 'x-bedo-csrf'],
    maxAge: 600,
  });

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

export async function createApp(env: ApiEnv): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule.forRoot(env), buildFastifyAdapter(env), {
    logger: buildLogger(env),
  });
  await configureApp(app, env);
  app.enableShutdownHooks();
  return app;
}
