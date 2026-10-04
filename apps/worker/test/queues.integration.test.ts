import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { loadEnv, workerEnvSchema } from '@bedo/config';
import { type OtpJobData, type PushJobData, QUEUE_NAMES } from '@bedo/contracts';
import { defaultMigrationsDir, runMigrations } from '@bedo/db';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WaabekClient, WaabekError } from '../src/otp/waabek.client.js';
import { PUSH_SENDER, type PushSender } from '../src/push/push.processor.js';
import { MaintenanceProcessor } from '../src/maintenance/maintenance.processor.js';
import { WorkerModule } from '../src/worker.module.js';

const adminUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(url: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query<T>(sql, params);
  } finally {
    await client.end();
  }
}

async function waitFor<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('timed out waiting');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * The worker's queue consumers end to end, against real Redis and a migrated Postgres, with the worker
 * connecting as the least-privilege runtime role. Waabek and Web Push are replaced by recording fakes.
 */
describe.runIf(adminUrl && redisUrl)('worker queues (real Postgres + Redis, runtime role)', () => {
  const suffix = randomBytes(5).toString('hex');
  const dbName = `bedo_worker_test_${suffix}`;
  const login = `bedo_worker_test_${suffix}`;
  const password = randomBytes(12).toString('hex');
  const prefix = `bedo-test-${suffix}`;
  let ownerUrl: string;
  let app: INestApplicationContext;
  let otpQueue: Queue<OtpJobData>;
  let pushQueue: Queue<PushJobData>;
  const connections: Redis[] = [];

  const sent: Array<{ phone: string; message: string }> = [];
  let failNumbers = new Set<string>();
  const fakeWaabek = {
    async send(phone: string, message: string) {
      if (failNumbers.has(phone)) {
        throw new WaabekError(503, 'HTTP 503');
      }
      sent.push({ phone, message });
    },
  };
  const pushed: Array<{ endpoint: string; payload: string }> = [];
  const fakePush: PushSender = {
    async send(subscription, payload) {
      if (subscription.endpoint.endsWith('/gone')) {
        throw Object.assign(new Error('Gone'), { statusCode: 410 });
      }
      pushed.push({ endpoint: subscription.endpoint, payload });
    },
  };

  beforeAll(async () => {
    await query(adminUrl!, `create database ${dbName}`);
    ownerUrl = Object.assign(new URL(adminUrl!), { pathname: `/${dbName}` }).toString();
    await runMigrations({ connectionString: ownerUrl, migrationsDir: defaultMigrationsDir() });
    await query(adminUrl!, `create role ${login} login password '${password}' in role bedo_runtime`);
    const runtime = new URL(ownerUrl);
    runtime.username = login;
    runtime.password = password;

    const env = loadEnv(workerEnvSchema, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      REDIS_URL: redisUrl!,
      DATABASE_URL: runtime.toString(),
      QUEUE_PREFIX: prefix,
      OTP_DELIVERY: 'waabek',
      WAABEK_API_KEY: 'fake-key-not-used-by-the-fake-client',
    });
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule.forRoot(env)] })
      .overrideProvider(WaabekClient)
      .useValue(fakeWaabek)
      .overrideProvider(PUSH_SENDER)
      .useValue(fakePush)
      .compile();
    app = moduleRef;
    moduleRef.useLogger(false);
    await app.init();

    const connection = () => {
      const redis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
      connections.push(redis);
      return redis;
    };
    otpQueue = new Queue<OtpJobData>(QUEUE_NAMES.otp, {
      connection: connection(),
      prefix,
      // Same options as the API producer, with a short backoff to keep the test fast.
      defaultJobOptions: { attempts: 3, backoff: { type: 'fixed', delay: 100 }, removeOnComplete: true, removeOnFail: true },
    });
    pushQueue = new Queue<PushJobData>(QUEUE_NAMES.push, { connection: connection(), prefix });
  });

  afterAll(async () => {
    await app?.close();
    for (const queue of [otpQueue, pushQueue]) {
      await queue?.obliterate({ force: true }).catch(() => undefined);
      await queue?.close();
    }
    await Promise.all(connections.map((redis) => redis.quit()));
    const redis = new Redis(redisUrl!);
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    await redis.quit();
    await query(adminUrl!, `drop database if exists ${dbName} with (force)`);
    await query(adminUrl!, `drop role if exists ${login}`);
  });

  it('delivers a queued code through Waabek and removes the job (and the code) from Redis', async () => {
    const job = await otpQueue.add('send', { phone: '+201000000101', code: '135790', purpose: 'sign_in' });
    const delivered = await waitFor(async () => sent.find((entry) => entry.phone === '+201000000101'));
    expect(delivered.message).toBe('Your Bedo Chat verification code is: 135790');
    await waitFor(async () => (await otpQueue.getJob(job.id!)) === undefined);
  });

  it('retries a failed delivery and records the final failure in the audit history, without the code', async () => {
    failNumbers = new Set(['+201000000102']);
    await otpQueue.add('send', { phone: '+201000000102', code: '864200', purpose: 'sign_in' });
    const rows = await waitFor(async () => {
      const result = await query<{ phone: string; details: Record<string, unknown> }>(
        ownerUrl,
        "select phone, details from audit.security_events where event = 'otp_delivery_failed'",
      );
      return result.rowCount ? result.rows : null;
    });
    expect(rows).toEqual([{ phone: '+201000000102', details: { purpose: 'sign_in', error: 'Waabek send failed: HTTP 503' } }]);
    expect(JSON.stringify(rows)).not.toContain('864200');
  });

  it('sends push notices to the user\'s other active sessions only, removing expired and non-push-service subscriptions', async () => {
    const user = await query<{ id: string }>(ownerUrl, "insert into app.users (phone, name) values ('+201000000103', 'Push') returning id");
    const userId = user.rows[0]!.id;
    const session = async (revoked: boolean) =>
      (
        await query<{ id: string }>(
          ownerUrl,
          `insert into app.sessions (user_id, refresh_hash, platform, expires_at, revoked_at)
           values ($1, $2, 'web', now() + interval '1 day', ${revoked ? 'now()' : 'null'}) returning id`,
          [userId, randomBytes(16).toString('hex')],
        )
      ).rows[0]!.id;
    const current = await session(false);
    const other = await session(false);
    const expired = await session(false);
    const revoked = await session(true);
    const smuggled = await session(false);
    for (const [sessionId, endpoint] of [
      [current, 'https://fcm.googleapis.com/fcm/send/current'],
      [other, 'https://fcm.googleapis.com/fcm/send/other'],
      [expired, 'https://fcm.googleapis.com/fcm/send/gone'],
      [revoked, 'https://fcm.googleapis.com/fcm/send/revoked'],
      // Not a browser push service (the API refuses these; the worker never contacts them either).
      [smuggled, 'https://10.0.0.5:8443/internal'],
    ] as const) {
      await query(ownerUrl, "insert into app.push_subscriptions (user_id, session_id, endpoint, p256dh, auth) values ($1, $2, $3, 'p', 'a')", [
        userId,
        sessionId,
        endpoint,
      ]);
    }

    await pushQueue.add('notify', {
      userId,
      excludeSessionId: current,
      notification: { title: 'New login', body: 'A new device signed in.', tag: 'new-login' },
    });
    await waitFor(
      async () => (await query(ownerUrl, "select 1 from app.push_subscriptions where endpoint like '%/gone' or endpoint like 'https://10.%'")).rowCount === 0,
    );
    await waitFor(async () => pushed.length >= 1);
    expect(pushed.map((entry) => entry.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/other']);
    expect((await query(ownerUrl, "select 1 from app.push_subscriptions where endpoint like 'https://10.%'")).rowCount).toBe(0);
    expect(JSON.parse(pushed[0]!.payload)).toEqual({ title: 'New login', body: 'A new device signed in.', tag: 'new-login' });
  });

  it('delivers to a snapshot of subscriptions when the account no longer has sessions (account deleted)', async () => {
    pushed.length = 0;
    await pushQueue.add('notify', {
      userId: '00000000-0000-0000-0000-000000000000',
      excludeSessionId: null,
      subscriptions: [{ endpoint: 'https://fcm.googleapis.com/fcm/send/snapshot', p256dh: 'p', auth: 'a' }],
      notification: { title: 'Account deleted', body: 'Your account has been deleted.', tag: 'account-deletion' },
    });
    await waitFor(async () => pushed.length === 1);
    expect(pushed[0]?.endpoint).toBe('https://fcm.googleapis.com/fcm/send/snapshot');
  });

  it('removes retired refresh-token hashes once they cannot matter, keeping recent ones of live sessions', async () => {
    const user = await query<{ id: string }>(ownerUrl, "insert into app.users (phone, name) values ('+201000000104', 'Tokens') returning id");
    const session = async (revoked: boolean) =>
      (
        await query<{ id: string }>(
          ownerUrl,
          `insert into app.sessions (user_id, refresh_hash, platform, expires_at, revoked_at)
           values ($1, $2, 'web', now() + interval '1 day', ${revoked ? 'now()' : 'null'}) returning id`,
          [user.rows[0]!.id, randomBytes(16).toString('hex')],
        )
      ).rows[0]!.id;
    const live = await session(false);
    const ended = await session(true);
    await query(ownerUrl, "insert into app.retired_refresh_tokens (token_hash, session_id) values ('recent', $1), ('ended', $2)", [live, ended]);
    await query(ownerUrl, "insert into app.retired_refresh_tokens (token_hash, session_id, retired_at) values ('old', $1, now() - interval '31 days')", [live]);
    // The worker runs this hourly as the runtime role; call it directly here.
    await app.get(MaintenanceProcessor).pruneRetiredRefreshTokens();
    const left = await query<{ token_hash: string }>(ownerUrl, "select token_hash from app.retired_refresh_tokens where token_hash in ('recent', 'ended', 'old')");
    expect(left.rows).toEqual([{ token_hash: 'recent' }]);
  });
});
