import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { type ApiEnv, apiEnvSchema, loadEnv } from '@bedo/config';
import { CSRF_HEADER, CSRF_HEADER_VALUE, type OtpJobData, QUEUE_NAMES, type PushJobData } from '@bedo/contracts';
import { defaultMigrationsDir, runMigrations } from '@bedo/db';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import { AppModule } from '../src/app.module.js';
import { buildFastifyAdapter, configureApp } from '../src/app.js';
import { ProfilePhotoStorage } from '../src/storage/profile-photo-storage.js';

export const WEB_ORIGIN = 'https://chat.bedo.test';
export const ADMIN_ORIGIN = 'https://admin.bedo.test';
export const TOTP_KEY = Buffer.alloc(32, 5);
/** SETTINGS_ENCRYPTION_KEY for tests (D-32): random per run, never a real key. */
export const SETTINGS_KEY = randomBytes(32);

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(url: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query<T>(sql, params);
  } finally {
    await client.end();
  }
}

/**
 * A fresh, migrated database plus a least-privilege login (member of bedo_runtime) for the API, and a
 * unique Redis key prefix. Everything is removed by `teardown`.
 */
export interface IntegrationEnv {
  ownerUrl: string;
  runtimeUrl: string;
  redisUrl: string;
  prefix: string;
  env: ApiEnv;
  redis: Redis;
  otpQueue: Queue<OtpJobData>;
  pushQueue: Queue<PushJobData>;
  teardown(): Promise<void>;
}

export async function setupIntegrationEnv(overrides: Record<string, string> = {}): Promise<IntegrationEnv> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!adminUrl || !redisUrl) {
    throw new Error('TEST_DATABASE_URL and REDIS_URL are required for integration tests');
  }
  const suffix = randomBytes(5).toString('hex');
  const dbName = `bedo_api_test_${suffix}`;
  const login = `bedo_api_test_${suffix}`;
  const password = randomBytes(12).toString('hex');
  await query(adminUrl, `create database ${dbName}`);
  const ownerUrl = Object.assign(new URL(adminUrl), { pathname: `/${dbName}` }).toString();
  await runMigrations({ connectionString: ownerUrl, migrationsDir: defaultMigrationsDir() });
  await query(adminUrl, `create role ${login} login password '${password}' in role bedo_runtime`);
  const runtime = new URL(ownerUrl);
  runtime.username = login;
  runtime.password = password;
  const prefix = `bedo-test-${suffix}`;

  const env = loadEnv(apiEnvSchema, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: runtime.toString(),
    REDIS_URL: redisUrl,
    QUEUE_PREFIX: prefix,
    CORS_ALLOWED_ORIGINS: `${WEB_ORIGIN},${ADMIN_ORIGIN}`,
    ADMIN_ORIGINS: ADMIN_ORIGIN,
    ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64'),
    OTP_HMAC_SECRET: randomBytes(32).toString('base64'),
    ADMIN_TOTP_KEY: TOTP_KEY.toString('base64'),
    SETTINGS_ENCRYPTION_KEY: SETTINGS_KEY.toString('base64'),
    VAPID_PUBLIC_KEY: 'BPublicKeyForTests',
    ...overrides,
  });

  const redis = new Redis(redisUrl);
  const otpQueue = new Queue<OtpJobData>(QUEUE_NAMES.otp, { connection: new Redis(redisUrl, { maxRetriesPerRequest: null }), prefix });
  const pushQueue = new Queue<PushJobData>(QUEUE_NAMES.push, { connection: new Redis(redisUrl, { maxRetriesPerRequest: null }), prefix });

  return {
    ownerUrl,
    runtimeUrl: runtime.toString(),
    redisUrl,
    prefix,
    env,
    redis,
    otpQueue,
    pushQueue,
    async teardown() {
      for (const queue of [otpQueue, pushQueue]) {
        await queue.obliterate({ force: true }).catch(() => undefined);
        await queue.close();
        await (queue.opts.connection as Redis).quit().catch(() => undefined);
      }
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      await redis.quit();
      await query(adminUrl, `drop database if exists ${dbName} with (force)`);
      await query(adminUrl, `drop role if exists ${login}`);
    },
  };
}

/** The real application (all modules), optionally with a fake profile-photo storage. */
export async function startApp(env: ApiEnv, storage?: ProfilePhotoStorage): Promise<NestFastifyApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule.forRoot(env)] });
  if (storage) {
    builder = builder.overrideProvider(ProfilePhotoStorage).useValue(storage);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(buildFastifyAdapter(env), { logger: false });
  await configureApp(app, env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

/** Headers a browser on the web app sends with cookie-authenticated requests. */
export const webCsrf = { origin: WEB_ORIGIN, [CSRF_HEADER]: CSRF_HEADER_VALUE };
export const adminCsrf = { origin: ADMIN_ORIGIN, [CSRF_HEADER]: CSRF_HEADER_VALUE };

/** Reads the code that the worker would send through Waabek, straight from the job queue. */
export async function latestCode(queue: Queue<OtpJobData>, phone: string): Promise<string | null> {
  const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
  const matching = jobs.filter((job) => job?.name === 'send' && job.data.phone === phone).sort((a, b) => b.timestamp - a.timestamp);
  return matching[0]?.data.code ?? null;
}

export async function jobCount(queue: Queue<OtpJobData>, phone: string): Promise<number> {
  const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'prioritized']);
  return jobs.filter((job) => job?.name === 'send' && job.data.phone === phone).length;
}

/** Extracts a cookie value from a Set-Cookie response header. */
export function cookieValue(setCookie: string | string[] | undefined, name: string): string | null {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const header of headers) {
    const [pair] = header.split(';');
    const [key, ...rest] = (pair ?? '').split('=');
    if (key?.trim() === name) {
      return rest.join('=');
    }
  }
  return null;
}

/** Clears the resend cooldown so a test can request several codes for one number without waiting 60s. */
export async function clearCooldown(redis: Redis, prefix: string, phone: string, scope = 'otp'): Promise<void> {
  await redis.del(`${prefix}:rl:${scope}:cooldown:${phone}`);
}

let adminIpCounter = 0;
/** A fresh client address per admin password request, so tests do not share the per-IP limit unless they mean to. */
export const nextAdminIp = () => `10.77.${Math.floor(++adminIpCounter / 250)}.${(adminIpCounter % 250) + 1}`;

/** The password test admins get (D-34): long enough, not a phone number, not on the common-password list. */
export const ADMIN_TEST_PASSWORD = ['tidal', 'quartz', 'lantern', '0471'].join('-');

/** What the owner runs in the SQL editor (D-34): a one-time password setup token for that admin. */
export async function issuePasswordSetup(ownerUrl: string, phone: string): Promise<string> {
  const result = await query<{ setup_token: string }>(ownerUrl, 'select setup_token from app.issue_admin_password_setup($1)', [phone]);
  return result.rows[0]!.setup_token;
}

/** Sets an admin's password the supported way: owner setup token, then the Set Password endpoint. */
export async function setAdminPassword(app: NestFastifyApplication, ownerUrl: string, phone: string, password = ADMIN_TEST_PASSWORD): Promise<void> {
  const setupToken = await issuePasswordSetup(ownerUrl, phone);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/admin/auth/password/setup',
    headers: adminCsrf,
    payload: { phone, setupToken, password },
    remoteAddress: nextAdminIp(),
  });
  if (response.statusCode !== 200) {
    throw new Error(`Setting the admin password failed: ${response.statusCode} ${response.body}`);
  }
}

/** Admin sign-in step 1 (D-34): phone + password. Returns the response (pendingToken on success). */
export function adminPasswordLogin(app: NestFastifyApplication, phone: string, password = ADMIN_TEST_PASSWORD, remoteAddress = nextAdminIp()) {
  return app.inject({ method: 'POST', url: '/v1/admin/auth/password/login', headers: adminCsrf, payload: { phone, password }, remoteAddress });
}
