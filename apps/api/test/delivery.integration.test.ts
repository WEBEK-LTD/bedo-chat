import { randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { encryptWaabekApiKey } from '@bedo/server-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PushService } from '../src/delivery/push.service.js';
import { WaabekError } from '../src/delivery/waabek.client.js';
import { MaintenanceService } from '../src/runtime/maintenance.service.js';
import { EphemeralStore } from '../src/state/ephemeral.store.js';
import { RateLimitService } from '../src/state/rate-limit.service.js';
import { type IntegrationEnv, latestCode, query, SETTINGS_KEY, setupIntegrationEnv, startApp, TEST_WAABEK_KEY } from './integration-env.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
let phoneCounter = 0;
const nextPhone = () => `+2012${String(Date.now() % 1e4).padStart(4, '0')}${String(++phoneCounter).padStart(4, '0')}`;
let ipCounter = 0;
const nextIp = () => `10.61.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

/**
 * What the worker did before D-36, now inside the API, against real Postgres as the runtime role: WhatsApp
 * delivery with the Dashboard-managed key on several server instances, Web Push, hourly housekeeping, and the
 * short-lived state and limits that replaced Redis.
 */
describe.runIf(enabled)('work after the response, housekeeping and short-lived state (D-36)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  /** A second server instance on the same database (Netlify runs many). */
  let other: NestFastifyApplication;

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    app = await startApp(ctx.env);
    other = await startApp(ctx.env);
  });

  afterAll(async () => {
    await app?.close();
    await other?.close();
    await ctx?.teardown();
  });

  const listed = async () => {
    const phone = nextPhone();
    await query(ctx.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);
    return phone;
  };
  const requestCode = (server: NestFastifyApplication, phone: string, ip = nextIp()) =>
    server.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone }, remoteAddress: ip });

  describe('WhatsApp codes', () => {
    it('sends the code with the stored key, and every instance follows a replaced key on its next message', async () => {
      const first = await listed();
      expect((await requestCode(app, first)).statusCode).toBe(200);
      expect(await latestCode(ctx.waabek, first)).toMatch(/^\d{6}$/);
      expect(ctx.waabek.messages.at(-1)!.apiKey).toBe(TEST_WAABEK_KEY);
      // Replaced (as the Admin Dashboard does): both instances use the new key for their very next message.
      const replaced = 'fake-waabek-key-replaced-0002';
      await query(ctx.ownerUrl, 'update app.otp_settings set waabek_api_key_enc = $1', [encryptWaabekApiKey(SETTINGS_KEY, replaced)]);
      for (const server of [app, other]) {
        const phone = await listed();
        await requestCode(server, phone);
        expect(await latestCode(ctx.waabek, phone)).toMatch(/^\d{6}$/);
        expect(ctx.waabek.messages.at(-1)!.apiKey).toBe(replaced);
      }
      await query(ctx.ownerUrl, 'update app.otp_settings set waabek_api_key_enc = $1', [encryptWaabekApiKey(SETTINGS_KEY, TEST_WAABEK_KEY)]);
    });

    it('records a failed delivery in the security history without the code, and answers the request the same way', async () => {
      const phone = await listed();
      ctx.waabek.failWith = new WaabekError(401, 'HTTP 401', false);
      try {
        expect((await requestCode(app, phone)).statusCode).toBe(200);
        await ctx.settle();
      } finally {
        ctx.waabek.failWith = null;
      }
      const failures = await query<{ details: { purpose: string; error: string } }>(
        ctx.ownerUrl,
        "select details from audit.security_events where event = 'otp_delivery_failed' and phone = $1",
        [phone],
      );
      expect(failures.rows).toEqual([{ details: { purpose: 'sign_in', error: 'Waabek send failed: HTTP 401' } }]);
      // Fails closed with an unreadable key: nothing is sent, the reason is recorded.
      await query(ctx.ownerUrl, 'update app.otp_settings set waabek_api_key_enc = $1', [encryptWaabekApiKey(randomBytes(32), 'fake-other-key')]);
      const second = await listed();
      await requestCode(app, second);
      expect(await latestCode(ctx.waabek, second)).toBeNull();
      const unreadable = await query<{ details: { error: string } }>(ctx.ownerUrl, "select details from audit.security_events where event = 'otp_delivery_failed' and phone = $1", [second]);
      expect(unreadable.rows[0]!.details.error).toBe('OTP settings: the stored Waabek API key cannot be decrypted');
      await query(ctx.ownerUrl, 'update app.otp_settings set waabek_api_key_enc = $1', [encryptWaabekApiKey(SETTINGS_KEY, TEST_WAABEK_KEY)]);
    });

    it('lets exactly one of many parallel requests for a number through, across instances (cooldown under a lock)', async () => {
      const phone = await listed();
      const answers = await Promise.all(Array.from({ length: 12 }, (_, index) => requestCode(index % 2 === 0 ? app : other, phone)));
      expect(answers.filter((answer) => answer.statusCode === 200)).toHaveLength(1);
      expect(answers.filter((answer) => answer.statusCode === 429)).toHaveLength(11);
      await ctx.settle();
      expect(ctx.waabek.messages.filter((message) => message.phone === phone)).toHaveLength(1);
    });

    it('shares one per-address budget across numbers and instances: 20 codes an hour', async () => {
      const ip = '192.0.2.44';
      const answers = [];
      for (let index = 0; index < 22; index += 1) {
        answers.push((await requestCode(index % 2 === 0 ? app : other, nextPhone(), ip)).statusCode);
      }
      expect(answers.filter((status) => status === 200)).toHaveLength(20);
      expect(answers.slice(20)).toEqual([429, 429]);
    });
  });

  describe('Web Push', () => {
    it("sends to the user's other active sessions only, removing expired and non-push-service subscriptions", async () => {
      const user = await query<{ id: string }>(ctx.ownerUrl, "insert into app.users (phone, name) values ($1, 'Push') returning id", [nextPhone()]);
      const userId = user.rows[0]!.id;
      const session = async (revoked: boolean) =>
        (
          await query<{ id: string }>(
            ctx.ownerUrl,
            `insert into app.sessions (user_id, refresh_hash, platform, expires_at, revoked_at)
             values ($1, $2, 'web', now() + interval '1 day', ${revoked ? 'now()' : 'null'}) returning id`,
            [userId, randomBytes(16).toString('hex')],
          )
        ).rows[0]!.id;
      const current = await session(false);
      const otherSession = await session(false);
      const expired = await session(false);
      const revoked = await session(true);
      const smuggled = await session(false);
      for (const [sessionId, endpoint] of [
        [current, `https://fcm.googleapis.com/fcm/send/current-${userId}`],
        [otherSession, `https://fcm.googleapis.com/fcm/send/other-${userId}`],
        [expired, `https://fcm.googleapis.com/fcm/send/gone-${userId}`],
        [revoked, `https://fcm.googleapis.com/fcm/send/revoked-${userId}`],
        // Not a browser push service (the API refuses these when they are saved, and never contacts them).
        [smuggled, `https://10.0.0.5:8443/internal-${userId}`],
      ] as const) {
        await query(ctx.ownerUrl, "insert into app.push_subscriptions (user_id, session_id, endpoint, p256dh, auth) values ($1, $2, $3, 'p', 'a')", [userId, sessionId, endpoint]);
      }
      ctx.push.clear();
      ctx.push.statusFor.set(`https://fcm.googleapis.com/fcm/send/gone-${userId}`, 410);
      const result = await app.get(PushService).deliver({
        userId,
        excludeSessionId: current,
        notification: { title: 'New login', body: 'A new device signed in.', tag: 'new-login' },
      });
      expect(result).toEqual({ delivered: 1, removed: 2 });
      expect(ctx.push.sent).toEqual([{ endpoint: `https://fcm.googleapis.com/fcm/send/other-${userId}`, payload: { title: 'New login', body: 'A new device signed in.', tag: 'new-login' } }]);
      const left = await query<{ endpoint: string }>(ctx.ownerUrl, 'select endpoint from app.push_subscriptions where user_id = $1 order by endpoint', [userId]);
      expect(left.rows.map((row) => row.endpoint.split('/').pop()!.split('-')[0])).toEqual(['current', 'other', 'revoked']);
    });
  });

  describe('hourly housekeeping', () => {
    it('runs once an hour across all instances, started by ordinary requests', async () => {
      await query(ctx.ownerUrl, "delete from app.maintenance_runs");
      const [a, b] = await Promise.all([app.get(MaintenanceService).runIfDue(), other.get(MaintenanceService).runIfDue()]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect(await app.get(MaintenanceService).runIfDue()).toBe(false);
      await query(ctx.ownerUrl, "update app.maintenance_runs set last_run_at = now() - interval '61 minutes'");
      expect(await other.get(MaintenanceService).runIfDue()).toBe(true);
      // The runtime role cannot delete the record or forge another table's run.
      await expect(query(ctx.runtimeUrl, 'delete from app.maintenance_runs')).rejects.toThrow(/permission denied/);
    });

    it('removes retired refresh-token hashes once they cannot matter, keeping recent ones of live sessions', async () => {
      const user = await query<{ id: string }>(ctx.ownerUrl, "insert into app.users (phone, name) values ($1, 'Tokens') returning id", [nextPhone()]);
      const session = async (revoked: boolean) =>
        (
          await query<{ id: string }>(
            ctx.ownerUrl,
            `insert into app.sessions (user_id, refresh_hash, platform, expires_at, revoked_at)
             values ($1, $2, 'web', now() + interval '1 day', ${revoked ? 'now()' : 'null'}) returning id`,
            [user.rows[0]!.id, randomBytes(16).toString('hex')],
          )
        ).rows[0]!.id;
      const live = await session(false);
      const ended = await session(true);
      await query(ctx.ownerUrl, "insert into app.retired_refresh_tokens (token_hash, session_id) values ('recent', $1), ('ended', $2)", [live, ended]);
      await query(ctx.ownerUrl, "insert into app.retired_refresh_tokens (token_hash, session_id, retired_at) values ('old', $1, now() - interval '31 days')", [live]);
      await app.get(MaintenanceService).pruneRetiredRefreshTokens();
      const left = await query<{ token_hash: string }>(ctx.ownerUrl, "select token_hash from app.retired_refresh_tokens where token_hash in ('recent', 'ended', 'old')");
      expect(left.rows).toEqual([{ token_hash: 'recent' }]);
    });

    it('keeps message partitions ready for the coming months', async () => {
      await app.get(MaintenanceService).ensureMessagePartitions();
      const months = (
        await query<{ name: string }>(ctx.ownerUrl, "select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid where i.inhparent = 'app.messages'::regclass order by 1")
      ).rows.map((row) => row.name);
      const expected = Array.from({ length: 4 }, (_, offset) => {
        const date = new Date();
        const month = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1));
        return `messages_${month.getUTCFullYear()}_${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
      });
      expect(months).toEqual(expect.arrayContaining(expected));
      // Idempotent, and run as the runtime role (no DDL privilege of its own).
      expect(await app.get(MaintenanceService).ensureMessagePartitions()).toBe(0);
    });

    it('prunes update-log entries and idempotency keys older than 30 days, never messages (P-17)', async () => {
      const user = await query<{ id: string }>(ctx.ownerUrl, "insert into app.users (phone, name) values ($1, 'Sync') returning id", [nextPhone()]);
      const peer = await query<{ id: string }>(ctx.ownerUrl, "insert into app.users (phone, name) values ($1, 'Peer') returning id", [nextPhone()]);
      const userId = user.rows[0]!.id;
      const chat = await query<{ id: string }>(
        ctx.ownerUrl,
        "insert into app.conversations (type, private_low, private_high, created_by, last_seq) select 'private', least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid), $1, 1 returning id",
        [userId, peer.rows[0]!.id],
      );
      const message = await query<{ id: string }>(
        ctx.ownerUrl,
        "insert into app.messages (conversation_id, seq, sender_id, client_id, text) values ($1, 1, $2, gen_random_uuid(), 'kept') returning id",
        [chat.rows[0]!.id, userId],
      );
      await query(ctx.ownerUrl, 'insert into app.user_sync_state (user_id, last_seq) values ($1, 3)', [userId]);
      await query(
        ctx.ownerUrl,
        `insert into app.update_log (user_id, seq, kind, created_at) values
          ($1, 1, 'folders', now() - interval '40 days'), ($1, 2, 'folders', now() - interval '31 days'), ($1, 3, 'folders', now())`,
        [userId],
      );
      await query(
        ctx.ownerUrl,
        `insert into app.message_requests (sender_id, client_id, kind, conversation_id, message_ids, created_at) values
          ($1, gen_random_uuid(), 'send', $2, array[$3::uuid], now() - interval '31 days'),
          ($1, gen_random_uuid(), 'send', $2, array[$3::uuid], now())`,
        [userId, chat.rows[0]!.id, message.rows[0]!.id],
      );
      await app.get(MaintenanceService).pruneUpdateLog(1);
      const left = await query<{ seq: string }>(ctx.ownerUrl, 'select seq from app.update_log where user_id = $1', [userId]);
      expect(left.rows).toEqual([{ seq: '3' }]);
      const state = await query<{ pruned_through_seq: string }>(ctx.ownerUrl, 'select pruned_through_seq from app.user_sync_state where user_id = $1', [userId]);
      expect(state.rows[0]!.pruned_through_seq).toBe('2');
      expect((await query(ctx.ownerUrl, 'select 1 from app.messages where id = $1', [message.rows[0]!.id])).rowCount).toBe(1);
      expect((await query(ctx.ownerUrl, 'select 1 from app.message_requests where sender_id = $1', [userId])).rowCount).toBe(1);
    });

    it('removes expired short-lived state, and never treats an expired row as present before that', async () => {
      const store = app.get(EphemeralStore);
      const limits = app.get(RateLimitService);
      await store.set('test:expired', 'gone', 1);
      await store.set('test:alive', 'here', 60_000);
      await limits.reserveAttempt('test:counter-expired', 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await store.get('test:expired')).toBeNull();
      expect(await store.ttlMs('test:expired')).toBeNull();
      expect(await store.take('test:expired')).toBeNull();
      expect(await store.get('test:alive')).toBe('here');
      // An expired counter starts a new window.
      expect((await limits.reserveAttempt('test:counter-expired', 60_000)).count).toBe(1);
      await store.set('test:expired-2', 'gone', 1);
      await query(ctx.ownerUrl, "insert into app.rate_events (bucket, at) values ('test:old', now() - interval '2 hours')");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await app.get(MaintenanceService).pruneExpiredState()).toBeGreaterThanOrEqual(2);
      expect((await query(ctx.ownerUrl, "select key from app.ephemeral where key like 'test:%'")).rows).toEqual([{ key: 'test:alive' }]);
      expect((await query(ctx.ownerUrl, "select 1 from app.rate_events where bucket = 'test:old'")).rowCount).toBe(0);
    });
  });

  describe('short-lived state (what Redis held)', () => {
    it('lets only one caller create or take a value, also in parallel and across instances', async () => {
      const stores = [app.get(EphemeralStore), other.get(EphemeralStore)];
      const created = await Promise.all(Array.from({ length: 10 }, (_, index) => stores[index % 2]!.setIfAbsent('test:once', `v${index}`, 60_000)));
      expect(created.filter(Boolean)).toHaveLength(1);
      const taken = await Promise.all(Array.from({ length: 10 }, (_, index) => stores[index % 2]!.take('test:once')));
      expect(taken.filter((value) => value !== null)).toHaveLength(1);
      expect(await stores[0]!.delete('test:once')).toBe(0);
    });

    it('counts parallel attempts exactly (reserve-first) and refuses over a fixed-window limit without counting', async () => {
      const limits = [app.get(RateLimitService), other.get(RateLimitService)];
      const counts = await Promise.all(Array.from({ length: 30 }, (_, index) => limits[index % 2]!.reserveAttempt('test:parallel', 60_000)));
      expect(counts.map((attempt) => attempt.count).sort((x, y) => x - y)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
      const taken = await Promise.all(Array.from({ length: 10 }, (_, index) => limits[index % 2]!.take('test:take', 1, 4, 60_000)));
      expect(taken.filter((result) => result.allowed)).toHaveLength(4);
      expect(taken.filter((result) => !result.allowed).every((result) => result.retryAfterMs > 0)).toBe(true);
      // Refused attempts were not counted, and a request larger than the window allows is refused outright.
      expect((await query<{ count: number }>(ctx.ownerUrl, "select count from app.rate_counters where key = 'test:take'")).rows[0]!.count).toBe(4);
      expect((await limits[0]!.take('test:take-big', 5, 4, 60_000)).allowed).toBe(false);
      await limits[0]!.reset('test:parallel');
      expect((await limits[1]!.reserveAttempt('test:parallel', 60_000)).count).toBe(1);
    });

    it('gives the runtime role row access only (no truncate, no schema changes)', async () => {
      await expect(query(ctx.runtimeUrl, 'truncate app.ephemeral')).rejects.toThrow(/permission denied/);
      await expect(query(ctx.runtimeUrl, 'alter table app.rate_counters add column x int')).rejects.toThrow(/must be owner/);
    });
  });
});
