import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { type ApiEnv, apiEnvSchema, loadEnv } from '@bedo/config';
import { AppModule } from '../src/app.module.js';
import { buildFastifyAdapter, configureApp } from '../src/app.js';
import { DatabaseService } from '../src/database/database.service.js';
import { RedisService } from '../src/redis/redis.service.js';

export function testEnv(overrides: Record<string, string> = {}): ApiEnv {
  return loadEnv(apiEnvSchema, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
    REDIS_URL: 'redis://127.0.0.1:1',
    HEALTH_CHECK_TIMEOUT_MS: '200',
    CORS_ALLOWED_ORIGINS: 'https://chat.example.test,https://admin.example.test',
    ADMIN_ORIGINS: 'https://admin.example.test',
    ACCESS_TOKEN_SECRET: 'test-access-token-secret-0123456789abcdef',
    OTP_HMAC_SECRET: 'test-otp-hmac-secret-0123456789abcdef-xyz',
    ADMIN_TOTP_KEY: Buffer.alloc(32, 9).toString('base64'),
    SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 10).toString('base64'),
    ...overrides,
  });
}

export interface FakeDependency {
  ping(): Promise<void>;
}

export const up: FakeDependency = { ping: async () => undefined };
export const down: FakeDependency = {
  ping: async () => {
    throw new Error('unreachable');
  },
};
export const hanging: FakeDependency = { ping: () => new Promise<void>(() => undefined) };

/** Builds the real application with Postgres and Redis replaced by fakes. */
export async function buildTestApp(
  options: {
    env?: ApiEnv;
    database?: FakeDependency;
    redis?: FakeDependency;
    extraControllers?: Array<new (...args: never[]) => unknown>;
    /** Sees every route as Fastify registers it. */
    onRoute?: (route: { method: string | string[]; url: string }) => void;
  } = {},
): Promise<NestFastifyApplication> {
  const env = options.env ?? testEnv();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(env)],
    controllers: options.extraControllers ?? [],
  })
    .overrideProvider(DatabaseService)
    .useValue({ ...(options.database ?? up), onApplicationShutdown: async () => undefined })
    .overrideProvider(RedisService)
    .useValue({ ...(options.redis ?? up), onApplicationShutdown: async () => undefined })
    .compile();

  const adapter = buildFastifyAdapter(env);
  if (options.onRoute) {
    adapter.getInstance().addHook('onRoute', options.onRoute);
  }
  const app = moduleRef.createNestApplication<NestFastifyApplication>(adapter, { logger: false });
  await configureApp(app, env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
