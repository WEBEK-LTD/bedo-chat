import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { loadEnv, workerEnvSchema } from '@bedo/config';
import { OTP_DELIVERY_ERRORS, OTP_JOB_NAMES, type OtpJobData, type PushJobData, QUEUE_NAMES, WAABEK_TEST_MESSAGE } from '@bedo/contracts';
import { encryptWaabekApiKey } from '@bedo/server-crypto';
import { defaultMigrationsDir, runMigrations } from '@bedo/db';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WaabekClient, WaabekError } from '../src/otp/waabek.client.js';
import { WaabekKeyProvider } from '../src/otp/waabek-key.provider.js';
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
  let runtimeUrl: string;
  let app: INestApplicationContext;
  let env: ReturnType<typeof workerEnvSchema.parse>;
  const extraWorkers: INestApplicationContext[] = [];

  /** One worker instance (its own process in production): the real module with a recording Waabek fake. */
  async function startWorker(instance: string): Promise<INestApplicationContext> {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule.forRoot(env)] })
      .overrideProvider(WaabekClient)
      .useValue(fakeWaabek(instance))
      .overrideProvider(PUSH_SENDER)
      .useValue(fakePush)
      .compile();
    moduleRef.useLogger(false);
    await moduleRef.init();
    return moduleRef;
  }
  let otpQueue: Queue<OtpJobData>;
  let pushQueue: Queue<PushJobData>;
  const connections: Redis[] = [];

  // Fake keys only: real keys are set from the Admin Dashboard and never appear in tests (D-32).
  const settingsKey = randomBytes(32);
  const sent: Array<{ apiKey: string; phone: string; message: string; instance: string }> = [];
  let failNumbers = new Set<string>();
  const fakeWaabek = (instance: string) => ({
    async send(apiKey: string, phone: string, message: string) {
      if (failNumbers.has(phone)) {
        throw new WaabekError(503, 'HTTP 503');
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      sent.push({ apiKey, phone, message, instance });
    },
  });
  /** What a Super Admin does from the Admin Dashboard: store a new encrypted key (the version rises). */
  const setStoredKey = (apiKey: string | null) =>
    query(ownerUrl, 'update app.otp_settings set waabek_api_key_enc = $1', [apiKey === null ? null : encryptWaabekApiKey(settingsKey, apiKey)]);
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
    runtimeUrl = runtime.toString();

    env = loadEnv(workerEnvSchema, {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      REDIS_URL: redisUrl!,
      DATABASE_URL: runtime.toString(),
      QUEUE_PREFIX: prefix,
      OTP_DELIVERY: 'waabek',
      SETTINGS_ENCRYPTION_KEY: settingsKey.toString('base64'),
      WORKER_CONCURRENCY: '1',
    });
    await setStoredKey('fake-waabek-key-A-0001');
    app = await startWorker('A');

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
    for (const worker of extraWorkers) {
      await worker.close();
    }
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
    expect(delivered.apiKey).toBe('fake-waabek-key-A-0001');
    await waitFor(async () => (await otpQueue.getJob(job.id!)) === undefined);
  });

  it('retries a failed delivery and records the final failure in the audit history, without the code', async () => {
    failNumbers = new Set(['+201000000102']);
    await otpQueue.add('send', { phone: '+201000000102', code: '864200', purpose: 'sign_in' });
    const rows = await waitFor(async () => {
      const result = await query<{ phone: string; details: Record<string, unknown> }>(
        ownerUrl,
        "select phone, details from audit.security_events where event = 'otp_delivery_failed' and phone = '+201000000102'",
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

  it('keeps message partitions ready for the coming months (Phase 3)', async () => {
    const months = (await query<{ name: string }>(ownerUrl, "select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'app.messages'::regclass order by 1")).rows.map((row) => row.name);
    const expected = Array.from({ length: 4 }, (_, offset) => {
      const date = new Date();
      const month = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
      return `messages_${month.getUTCFullYear()}_${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
    });
    expect(months).toEqual(expect.arrayContaining(expected));
    // Idempotent, and run as the runtime role (no DDL privilege of its own).
    expect(await app.get(MaintenanceProcessor).ensureMessagePartitions()).toBe(0);
  });

  it('prunes update-log entries and idempotency keys older than 30 days, never messages (P-17)', async () => {
    const user = await query<{ id: string }>(ownerUrl, "insert into app.users (phone, name) values ('+201000000105', 'Sync') returning id");
    const other = await query<{ id: string }>(ownerUrl, "insert into app.users (phone, name) values ('+201000000106', 'Peer') returning id");
    const userId = user.rows[0]!.id;
    const chat = await query<{ id: string }>(
      ownerUrl,
      "insert into app.conversations (type, private_low, private_high, created_by, last_seq) select 'private', least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid), $1, 1 returning id",
      [userId, other.rows[0]!.id],
    );
    const message = await query<{ id: string }>(
      ownerUrl,
      "insert into app.messages (conversation_id, seq, sender_id, client_id, text) values ($1, 1, $2, gen_random_uuid(), 'kept') returning id",
      [chat.rows[0]!.id, userId],
    );
    await query(ownerUrl, 'insert into app.user_sync_state (user_id, last_seq) values ($1, 3)', [userId]);
    await query(
      ownerUrl,
      `insert into app.update_log (user_id, seq, kind, created_at) values
        ($1, 1, 'folders', now() - interval '40 days'), ($1, 2, 'folders', now() - interval '31 days'), ($1, 3, 'folders', now())`,
      [userId],
    );
    await query(
      ownerUrl,
      `insert into app.message_requests (sender_id, client_id, kind, conversation_id, message_ids, created_at) values
        ($1, gen_random_uuid(), 'send', $2, array[$3::uuid], now() - interval '31 days'),
        ($1, gen_random_uuid(), 'send', $2, array[$3::uuid], now())`,
      [userId, chat.rows[0]!.id, message.rows[0]!.id],
    );
    const result = await app.get(MaintenanceProcessor).pruneUpdateLog(1);
    expect(result).toEqual({ updates: 2, requests: 1 });
    const left = await query<{ seq: string }>(ownerUrl, 'select seq from app.update_log where user_id = $1', [userId]);
    expect(left.rows).toEqual([{ seq: '3' }]);
    const state = await query<{ pruned_through_seq: string }>(ownerUrl, 'select pruned_through_seq from app.user_sync_state where user_id = $1', [userId]);
    expect(state.rows[0]!.pruned_through_seq).toBe('2');
    expect((await query(ownerUrl, 'select 1 from app.messages where id = $1', [message.rows[0]!.id])).rowCount).toBe(1);
    expect((await query(ownerUrl, 'select 1 from app.message_requests where sender_id = $1', [userId])).rowCount).toBe(1);
  });

  describe('Dashboard-managed Waabek key (D-32, Phase 3.1)', () => {
    const failuresFor = async (phone: string) =>
      (
        await query<{ details: { error: string } }>(
          ownerUrl,
          "select details from audit.security_events where event = 'otp_delivery_failed' and phone = $1",
          [phone],
        )
      ).rows;

    it('uses the stored key and follows a replaced key on the next message, without a restart', async () => {
      await otpQueue.add(OTP_JOB_NAMES.send, { phone: '+201000000201', code: '111111', purpose: 'sign_in' });
      expect((await waitFor(async () => sent.find((entry) => entry.phone === '+201000000201'))).apiKey).toBe('fake-waabek-key-A-0001');
      const before = app.get(WaabekKeyProvider).cachedVersion;

      await setStoredKey('fake-waabek-key-B-0002');
      await otpQueue.add(OTP_JOB_NAMES.send, { phone: '+201000000202', code: '222222', purpose: 'sign_in' });
      expect((await waitFor(async () => sent.find((entry) => entry.phone === '+201000000202'))).apiKey).toBe('fake-waabek-key-B-0002');
      const version = (await query<{ version: string }>(ownerUrl, 'select version from app.otp_settings')).rows[0]!.version;
      expect(app.get(WaabekKeyProvider).cachedVersion).toBe(version);
      expect(app.get(WaabekKeyProvider).cachedVersion).not.toBe(before);
    });

    it('fails closed at once, without retries, when no key is stored or the stored key cannot be decrypted', async () => {
      await setStoredKey(null);
      await otpQueue.add(OTP_JOB_NAMES.send, { phone: '+201000000203', code: '333333', purpose: 'sign_in' });
      const notConfigured = await waitFor(async () => {
        const rows = await failuresFor('+201000000203');
        return rows.length ? rows : null;
      });
      expect(notConfigured).toEqual([{ details: { purpose: 'sign_in', error: OTP_DELIVERY_ERRORS.notConfigured } }]);
      expect(app.get(WaabekKeyProvider).cachedVersion).toBeNull();

      // Encrypted with another key (a wrong SETTINGS_ENCRYPTION_KEY or a damaged value).
      await query(ownerUrl, 'update app.otp_settings set waabek_api_key_enc = $1', [encryptWaabekApiKey(randomBytes(32), 'fake-waabek-key-X-0003')]);
      await otpQueue.add(OTP_JOB_NAMES.send, { phone: '+201000000204', code: '444444', purpose: 'sign_in' });
      const unreadable = await waitFor(async () => {
        const rows = await failuresFor('+201000000204');
        return rows.length ? rows : null;
      });
      expect(unreadable).toEqual([{ details: { purpose: 'sign_in', error: OTP_DELIVERY_ERRORS.keyUnreadable } }]);
      expect(sent.some((entry) => ['+201000000203', '+201000000204'].includes(entry.phone))).toBe(false);
      // Not retried: one failure record each, and nothing about the key in the history.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await failuresFor('+201000000203')).toHaveLength(1);
      expect(await failuresFor('+201000000204')).toHaveLength(1);
      const history = JSON.stringify((await query(ownerUrl, 'select details from audit.security_events')).rows);
      expect(history).not.toContain('fake-waabek-key');
      expect(history).not.toContain('333333');
    });

    it('keeps several worker instances on the current key: each checks the settings before every message', async () => {
      await setStoredKey('fake-waabek-key-C-0004');
      const second = await startWorker('B');
      extraWorkers.push(second);
      const batch = async (from: number) => {
        const phones = Array.from({ length: 12 }, (_, index) => `+2010000003${String(from + index).padStart(2, '0')}`);
        for (const phone of phones) {
          await otpQueue.add(OTP_JOB_NAMES.send, { phone, code: '555555', purpose: 'sign_in' });
        }
        return waitFor(async () => {
          const delivered = sent.filter((entry) => phones.includes(entry.phone));
          return delivered.length === phones.length ? delivered : null;
        });
      };
      const first = await batch(0);
      expect(new Set(first.map((entry) => entry.apiKey))).toEqual(new Set(['fake-waabek-key-C-0004']));
      expect(new Set(first.map((entry) => entry.instance))).toEqual(new Set(['A', 'B']));

      // Changed once in the Admin Dashboard: both instances use the new key from the next message on.
      await setStoredKey('fake-waabek-key-D-0005');
      const after = await batch(20);
      expect(new Set(after.map((entry) => entry.apiKey))).toEqual(new Set(['fake-waabek-key-D-0005']));
      expect(new Set(after.map((entry) => entry.instance))).toEqual(new Set(['A', 'B']));
      expect(app.get(WaabekKeyProvider).cachedVersion).toBe(second.get(WaabekKeyProvider).cachedVersion);
    });

    it('follows an owner recovery (D-33) on every worker instance: the API\'s write raises the same version', async () => {
      const before = (await query<{ version: string }>(ownerUrl, 'select version from app.otp_settings')).rows[0]!.version;
      // Exactly the write the API makes for a recovery, as the runtime role.
      await query(runtimeUrl, "update app.otp_settings set waabek_api_key_enc = $1, updated_by = null, updated_via = 'owner_recovery'", [
        encryptWaabekApiKey(settingsKey, 'fake-waabek-key-R-0006'),
      ]);
      const after = (await query<{ version: string }>(ownerUrl, 'select version from app.otp_settings')).rows[0]!.version;
      expect(Number(after)).toBe(Number(before) + 1);
      const phones = Array.from({ length: 12 }, (_, index) => `+2010000005${String(index).padStart(2, '0')}`);
      for (const phone of phones) {
        await otpQueue.add(OTP_JOB_NAMES.send, { phone, code: '666666', purpose: 'sign_in' });
      }
      const delivered = await waitFor(async () => {
        const found = sent.filter((entry) => phones.includes(entry.phone));
        return found.length === phones.length ? found : null;
      });
      expect(new Set(delivered.map((entry) => entry.apiKey))).toEqual(new Set(['fake-waabek-key-R-0006']));
      expect(new Set(delivered.map((entry) => entry.instance))).toEqual(new Set(['A', 'B']));
      expect(app.get(WaabekKeyProvider).cachedVersion).toBe(after);
      expect(extraWorkers[0]!.get(WaabekKeyProvider).cachedVersion).toBe(after);
      await setStoredKey('fake-waabek-key-D-0005');
    });

    it('sends Admin Dashboard test messages through the same path and reports the result without recording a code failure', async () => {
      const connection = new Redis(redisUrl!, { maxRetriesPerRequest: null });
      connections.push(connection);
      const events = new QueueEvents(QUEUE_NAMES.otp, { connection, prefix });
      await events.waitUntilReady();
      try {
        const ok = await otpQueue.add(OTP_JOB_NAMES.waabekTest, { phone: '+201000000401' } as never, { attempts: 1, removeOnComplete: { age: 60 } });
        expect(await ok.waitUntilFinished(events, 10_000)).toEqual({ delivered: true });
        const delivered = sent.find((entry) => entry.phone === '+201000000401');
        expect(delivered?.message).toBe(WAABEK_TEST_MESSAGE);
        expect(delivered?.apiKey).toBe('fake-waabek-key-D-0005');

        failNumbers = new Set(['+201000000402']);
        const refused = await otpQueue.add(OTP_JOB_NAMES.waabekTest, { phone: '+201000000402' } as never, { attempts: 1, removeOnFail: { age: 60 } });
        await expect(refused.waitUntilFinished(events, 10_000)).rejects.toThrow('Waabek send failed: HTTP 503');
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(await failuresFor('+201000000402')).toEqual([]);
      } finally {
        await events.close();
      }
    });
  });
});
