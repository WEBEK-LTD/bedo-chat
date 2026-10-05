import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ADMIN_SESSION_COOKIE, OTP_DELIVERY_ERRORS, OTP_JOB_NAMES, QUEUE_NAMES } from '@bedo/contracts';
import { decryptWaabekApiKey } from '@bedo/server-crypto';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, currentStep, decryptSecret, encryptSecret, generateTotpSecret, hotp } from '../src/admin/totp.js';
import {
  adminCsrf,
  clearCooldown,
  cookieValue,
  type IntegrationEnv,
  query,
  setupIntegrationEnv,
  SETTINGS_KEY,
  startApp,
  TOTP_KEY,
} from './integration-env.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.REDIS_URL);

// Fake keys only: a real Waabek key never appears in tests (D-32).
const FIRST_KEY = 'fake-waabek-key-initial-setup-0001';
const SECOND_KEY = 'fake-waabek-key-replaced-from-dashboard-0002';
const SUPER_PHONE = '+905446731942';
let ipCounter = 0;
const nextIp = () => `10.71.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

/**
 * Phase 3.1 end to end against real Postgres and Redis, with the API connected as the least-privilege
 * runtime role: SQL-created Super Admin, one-time setup token, first Waabek key, first-time authenticator
 * setup, permanent closure, and the Super Admin OTP settings. A stand-in consumer takes the worker's place
 * on the OTP queue (the real worker's delivery path is covered in apps/worker).
 */
describe.runIf(enabled)('Phase 3.1 admin bootstrap and OTP settings (real Postgres + Redis, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  let consumer: Worker;
  const codes = new Map<string, string>();
  const testMessages: string[] = [];
  let testOutcome: 'ok' | Error = 'ok';
  let superCookie = '';
  let superSecret: Buffer;
  let setupToken = '';

  const post = (url: string, payload: unknown, headers: Record<string, string> = adminCsrf, ip = nextIp()) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers, remoteAddress: ip });
  const asAdmin = (cookie: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url, headers: { ...adminCsrf, cookie }, remoteAddress: nextIp(), ...(payload ? { payload } : {}) });
  const owner = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => query<T>(ctx.ownerUrl, sql, params);
  const runtime = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => query<T>(ctx.runtimeUrl, sql, params);
  const openBootstrap = async () => (await owner<{ setup_token: string; expires_at: Date }>('select * from app.open_admin_bootstrap()')).rows[0]!;
  const bootstrapRow = async () =>
    (await owner<{ failed_attempts: number; closed_at: Date | null; closed_by: string | null; token_hash: string | null }>('select * from app.admin_bootstrap')).rows[0]!;
  const settingsRow = async () =>
    (await owner<{ waabek_api_key_enc: string | null; version: string; updated_by: string | null }>('select * from app.otp_settings')).rows[0]!;
  const allHistory = async () =>
    JSON.stringify([
      (await owner('select * from app.audit_log')).rows,
      (await owner('select * from audit.security_events')).rows,
    ]);

  async function waitForCode(phone: string): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = codes.get(phone);
      if (code) {
        codes.delete(phone);
        return code;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no code for ${phone}`);
  }

  /** WhatsApp code step. Returns the answer of otp/verify. */
  async function phoneStep(phone: string) {
    await clearCooldown(ctx.redis, ctx.prefix, phone, 'otp-admin');
    expect((await post('/v1/admin/auth/otp/request', { phone })).statusCode).toBe(200);
    const verified = await post('/v1/admin/auth/otp/verify', { phone, code: await waitForCode(phone) });
    expect(verified.statusCode, verified.body).toBe(200);
    return verified.json() as { status: string; pendingToken: string };
  }

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    app = await startApp(ctx.env);
    consumer = new Worker(
      QUEUE_NAMES.otp,
      async (job) => {
        if (job.name === OTP_JOB_NAMES.send) {
          codes.set(job.data.phone, job.data.code);
          return undefined;
        }
        testMessages.push(job.data.phone);
        if (testOutcome !== 'ok') {
          throw testOutcome;
        }
        return { delivered: true };
      },
      { connection: new Redis(ctx.redisUrl, { maxRetriesPerRequest: null }), prefix: ctx.prefix },
    );
    await consumer.waitUntilReady();
  });

  afterAll(async () => {
    await consumer?.close();
    await (consumer?.opts.connection as Redis | undefined)?.quit().catch(() => undefined);
    await app?.close();
    await ctx?.teardown();
  });

  describe('database protections (runtime role)', () => {
    it('lets only the owner open the setup, and the runtime role cannot change tokens or delete settings', async () => {
      await expect(runtime('select * from app.open_admin_bootstrap()')).rejects.toThrow(/permission denied/);
      await expect(runtime("update app.admin_bootstrap set token_hash = repeat('a', 64), expires_at = now() + interval '1 day'")).rejects.toThrow(
        /permission denied/,
      );
      await expect(runtime('update app.admin_bootstrap set opened_at = now()')).rejects.toThrow(/permission denied/);
      // The wrong-token counter can only go up for the runtime role.
      await runtime('update app.admin_bootstrap set failed_attempts = failed_attempts + 1');
      await expect(runtime('update app.admin_bootstrap set failed_attempts = 0')).rejects.toThrow(/only the table owner/);
      await owner('update app.admin_bootstrap set failed_attempts = 0');
      await expect(runtime('delete from app.admin_bootstrap')).rejects.toThrow(/permission denied/);
      await expect(runtime('delete from app.otp_settings')).rejects.toThrow(/permission denied/);
      await expect(runtime('update app.otp_settings set version = 0')).rejects.toThrow(/permission denied/);
      await expect(owner('delete from app.otp_settings')).rejects.toThrow(/cannot be deleted/);
      await expect(owner('insert into app.otp_settings (id) values (false)')).rejects.toThrow(/check constraint/);
    });

    it('refuses a Waabek key recovery before the initial setup is complete, and keeps it from the runtime role (D-33)', async () => {
      await expect(owner('select * from app.open_otp_settings_recovery()')).rejects.toThrow(/use app.open_admin_bootstrap\(\) instead/);
      await expect(runtime('select * from app.open_otp_settings_recovery()')).rejects.toThrow(/permission denied/);
      await expect(runtime("update app.otp_settings_recovery set token_hash = repeat('a', 64), expires_at = now() + interval '1 day'")).rejects.toThrow(
        /permission denied/,
      );
      await expect(runtime('update app.otp_settings_recovery set opened_at = now()')).rejects.toThrow(/permission denied/);
      await expect(runtime('delete from app.otp_settings_recovery')).rejects.toThrow(/permission denied/);
      await runtime('update app.otp_settings_recovery set failed_attempts = failed_attempts + 1');
      await expect(runtime('update app.otp_settings_recovery set failed_attempts = 0')).rejects.toThrow(/only the table owner/);
      await expect(owner('delete from app.otp_settings_recovery')).rejects.toThrow(/cannot be deleted/);
      // A used token stays used: the runtime role can set the mark but never clear or move it.
      await runtime('update app.otp_settings_recovery set key_saved_at = now()');
      await expect(runtime('update app.otp_settings_recovery set key_saved_at = null')).rejects.toThrow(/only the table owner/);
      await expect(runtime("update app.otp_settings_recovery set key_saved_at = now() - interval '1 day'")).rejects.toThrow(/only the table owner/);
      await owner('update app.otp_settings_recovery set failed_attempts = 0, key_saved_at = null');
      expect((await app.inject({ method: 'GET', url: '/v1/admin/otp-recovery', headers: adminCsrf })).json()).toEqual({ recoveryOpen: false });
    });

    it('refuses to open the setup before the Super Admin account exists', async () => {
      await expect(openBootstrap()).rejects.toThrow(/Create the Super Admin account first/);
      expect((await post('/v1/admin/bootstrap/waabek-key', { setupToken: 'x'.repeat(43), apiKey: FIRST_KEY })).json().error.code).toBe('SETUP_UNAVAILABLE');
      const status = await app.inject({ method: 'GET', url: '/v1/admin/bootstrap', headers: adminCsrf });
      expect(status.json()).toEqual({ setupOpen: false });
    });

    it('keeps an existing authenticator secret out of the runtime role\'s reach', async () => {
      const legacy = await owner<{ id: string }>(
        "insert into app.admin_accounts (phone, name, role, totp_secret_enc) values ('+201100000901', 'Legacy', 'moderator', $1) returning id",
        [encryptSecret(TOTP_KEY, generateTotpSecret())],
      );
      await expect(
        runtime('update app.admin_accounts set totp_secret_enc = $1 where id = $2', [encryptSecret(TOTP_KEY, generateTotpSecret()), legacy.rows[0]!.id]),
      ).rejects.toThrow(/only be replaced by the table owner/);
      await expect(runtime('update app.admin_accounts set totp_secret_enc = null where id = $1', [legacy.rows[0]!.id])).rejects.toThrow(
        /only be replaced by the table owner/,
      );
      await expect(owner("update app.admin_accounts set totp_confirmed_at = now(), totp_secret_enc = null where id = $1", [legacy.rows[0]!.id])).rejects.toThrow(
        /admin_accounts_confirmed_has_secret/,
      );
      await owner('delete from app.admin_accounts where id = $1', [legacy.rows[0]!.id]);
    });
  });

  describe('initial setup', () => {
    it('opens with the owner\'s SQL and stores only the token hash, recorded without the token', async () => {
      // Exactly the statement the owner runs (Phase 3.1 report).
      await owner("insert into app.admin_accounts (phone, name, role, status) values ('+905446731942', 'Academy Admin', 'super_admin', 'active')");
      const opened = await openBootstrap();
      setupToken = opened.setup_token;
      expect(setupToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(new Date(opened.expires_at).getTime() - Date.now()).toBeGreaterThan(59 * 60 * 1000);
      const row = await bootstrapRow();
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.token_hash).not.toContain(setupToken);
      expect(await allHistory()).not.toContain(setupToken);
      expect((await owner("select 1 from app.audit_log where action = 'admin.bootstrap_opened'")).rowCount).toBe(1);
      expect((await app.inject({ method: 'GET', url: '/v1/admin/bootstrap', headers: adminCsrf })).json()).toEqual({ setupOpen: true });
    });

    it('needs the CSRF header and the admin origin', async () => {
      const noCsrf = await app.inject({ method: 'POST', url: '/v1/admin/bootstrap/waabek-key', payload: { setupToken, apiKey: FIRST_KEY } });
      expect(noCsrf.json().error.code).toBe('CSRF_REJECTED');
      const otherOrigin = await post('/v1/admin/bootstrap/waabek-key', { setupToken, apiKey: FIRST_KEY }, { origin: 'https://evil.example', 'x-bedo-csrf': '1' });
      expect(otherOrigin.statusCode).toBe(403);
    });

    it('validates the key without echoing it', async () => {
      const bad = await post('/v1/admin/bootstrap/waabek-key', { setupToken, apiKey: 'has spaces in-it-0001' });
      expect(bad.statusCode).toBe(400);
      expect(bad.body).not.toContain('has spaces');
      expect((await settingsRow()).waabek_api_key_enc).toBeNull();
    });

    it('stores the first Waabek key encrypted (D-32) and records the change without the key', async () => {
      const response = await post('/v1/admin/bootstrap/waabek-key', { setupToken, apiKey: FIRST_KEY });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(response.body).not.toContain(FIRST_KEY);
      const row = await settingsRow();
      expect(row.waabek_api_key_enc).not.toContain(FIRST_KEY);
      expect(Buffer.from(row.waabek_api_key_enc!, 'base64').toString('latin1')).not.toContain(FIRST_KEY);
      expect(decryptWaabekApiKey(SETTINGS_KEY, row.waabek_api_key_enc!)).toBe(FIRST_KEY);
      expect(row.version).toBe('1');
      expect(row.updated_by).toBeNull();
      const audit = await owner<{ actor_type: string; metadata: Record<string, unknown> }>(
        "select actor_type, metadata from app.audit_log where action = 'otp_settings.waabek_key_replaced'",
      );
      expect(audit.rows).toEqual([{ actor_type: 'system', metadata: { source: 'initial_setup', version: 1 } }]);
      expect(await allHistory()).not.toContain(FIRST_KEY);
    });

    it('sends a test message to the waiting Super Admin and reports Waabek refusals', async () => {
      testOutcome = 'ok';
      const ok = await post('/v1/admin/bootstrap/test-message', { setupToken });
      expect(ok.json()).toEqual({ delivered: true, sentTo: '+905******942', reason: null, httpStatus: null });
      expect(testMessages).toEqual([SUPER_PHONE]);
      testOutcome = new Error('Waabek send failed: HTTP 401');
      expect((await post('/v1/admin/bootstrap/test-message', { setupToken })).json()).toEqual({
        delivered: false,
        sentTo: '+905******942',
        reason: 'rejected',
        httpStatus: 401,
      });
      testOutcome = new Error(OTP_DELIVERY_ERRORS.keyUnreadable);
      expect((await post('/v1/admin/bootstrap/test-message', { setupToken })).json().reason).toBe('key_unreadable');
      testOutcome = 'ok';
      const recorded = await owner<{ metadata: Record<string, unknown> }>("select metadata from app.audit_log where action = 'otp_settings.test_message' order by id");
      expect(recorded.rows.map((row) => row.metadata.delivered)).toEqual([true, false, false]);
    });

    it('counts wrong setup tokens, also in parallel, and stops the token after 5', async () => {
      const before = (await bootstrapRow()).failed_attempts;
      const wrong = 'w'.repeat(43);
      const answers = await Promise.all([1, 2, 3].map(() => post('/v1/admin/bootstrap/waabek-key', { setupToken: wrong, apiKey: SECOND_KEY })));
      expect(answers.map((answer) => answer.json().error.code)).toEqual(['SETUP_TOKEN_INVALID', 'SETUP_TOKEN_INVALID', 'SETUP_TOKEN_INVALID']);
      expect((await bootstrapRow()).failed_attempts).toBe(before + 3);
      await post('/v1/admin/bootstrap/test-message', { setupToken: wrong });
      await post('/v1/admin/bootstrap/test-message', { setupToken: wrong });
      expect((await bootstrapRow()).failed_attempts).toBe(5);
      // Locked: even the right token no longer works, and the key was not changed.
      expect((await post('/v1/admin/bootstrap/waabek-key', { setupToken, apiKey: SECOND_KEY })).json().error.code).toBe('SETUP_UNAVAILABLE');
      expect((await app.inject({ method: 'GET', url: '/v1/admin/bootstrap', headers: adminCsrf })).json()).toEqual({ setupOpen: false });
      expect(decryptWaabekApiKey(SETTINGS_KEY, (await settingsRow()).waabek_api_key_enc!)).toBe(FIRST_KEY);
      const failures = await owner("select 1 from audit.security_events where event = 'admin_bootstrap_token_failed'");
      expect(failures.rowCount).toBe(5);

      // The owner issues a new token by SQL; the old one stays invalid.
      const reopened = await openBootstrap();
      expect(reopened.setup_token).not.toBe(setupToken);
      expect((await post('/v1/admin/bootstrap/waabek-key', { setupToken, apiKey: SECOND_KEY })).json().error.code).toBe('SETUP_TOKEN_INVALID');
      setupToken = reopened.setup_token;
    });

    it('expires the token after its time', async () => {
      await owner("update app.admin_bootstrap set expires_at = now() - interval '1 second'");
      expect((await post('/v1/admin/bootstrap/waabek-key', { setupToken, apiKey: SECOND_KEY })).json().error.code).toBe('SETUP_UNAVAILABLE');
      setupToken = (await openBootstrap()).setup_token;
    });

    it('limits initial-setup requests per IP address', async () => {
      const ip = '10.72.0.1';
      const answers = [];
      for (let index = 0; index < 21; index += 1) {
        answers.push((await post('/v1/admin/bootstrap/test-message', { setupToken: 'r'.repeat(43) }, adminCsrf, ip)).statusCode);
      }
      expect(answers.slice(0, 20).every((code) => code === 400 || code === 403)).toBe(true);
      expect(answers[20]).toBe(429);
      setupToken = (await openBootstrap()).setup_token;
    });
  });

  describe('first sign-in: WhatsApp code, then authenticator setup', () => {
    it('never signs in with the setup token alone', async () => {
      const response = await post('/v1/admin/auth/totp/verify', { pendingToken: setupToken, code: '123456' });
      expect(response.json().error.code).toBe('SESSION_INVALID');
      expect(cookieValue(response.headers['set-cookie'], ADMIN_SESSION_COOKIE)).toBeNull();
    });

    it('requires authenticator setup after the WhatsApp code, confirms it, and closes the setup for good', async () => {
      const pending = await phoneStep(SUPER_PHONE);
      expect(pending.status).toBe('totp_setup_required');

      // No secret yet: a code cannot be checked until the setup step has generated one.
      expect((await post('/v1/admin/auth/totp/verify', { pendingToken: pending.pendingToken, code: '000000' })).json().error.code).toBe('SESSION_INVALID');

      const setup = await post('/v1/admin/auth/totp/setup', { pendingToken: pending.pendingToken });
      expect(setup.statusCode, setup.body).toBe(200);
      expect(setup.headers['cache-control']).toBe('no-store');
      const { otpauthUri, setupKey, issuer, accountName } = setup.json();
      expect(issuer).toBe('Bedo Chat Admin');
      expect(accountName).toBe(SUPER_PHONE);
      expect(otpauthUri).toContain(`secret=${setupKey}`);
      superSecret = base32Decode(setupKey);
      expect(superSecret).toHaveLength(20);
      // The same secret for the whole attempt, and kept encrypted until it is confirmed.
      expect((await post('/v1/admin/auth/totp/setup', { pendingToken: pending.pendingToken })).json().setupKey).toBe(setupKey);
      const redisValues = await Promise.all((await ctx.redis.keys(`${ctx.prefix}:admin-pending-enrolment:*`)).map((key) => ctx.redis.get(key)));
      expect(redisValues).toHaveLength(1);
      expect(decryptSecret(TOTP_KEY, redisValues[0]!).equals(superSecret)).toBe(true);
      expect(redisValues[0]).not.toContain(setupKey);
      const unconfirmed = (await owner<{ totp_secret_enc: string | null; totp_confirmed_at: Date | null }>('select * from app.admin_accounts where phone = $1', [SUPER_PHONE])).rows[0]!;
      expect(unconfirmed).toMatchObject({ totp_secret_enc: null, totp_confirmed_at: null });

      expect((await post('/v1/admin/auth/totp/verify', { pendingToken: pending.pendingToken, code: '000000' })).json().error.code).toBe('TOTP_INVALID');
      expect((await bootstrapRow()).closed_at).toBeNull();

      const confirmed = await post('/v1/admin/auth/totp/verify', { pendingToken: pending.pendingToken, code: hotp(superSecret, currentStep(Date.now())) });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json().admin).toMatchObject({ name: 'Academy Admin', role: 'super_admin' });
      superCookie = `${ADMIN_SESSION_COOKIE}=${cookieValue(confirmed.headers['set-cookie'], ADMIN_SESSION_COOKIE)}`;

      const account = (await owner<{ id: string; totp_secret_enc: string; totp_confirmed_at: Date | null }>('select * from app.admin_accounts where phone = $1', [SUPER_PHONE])).rows[0]!;
      expect(account.totp_confirmed_at).not.toBeNull();
      expect(account.totp_secret_enc).not.toContain(setupKey);
      expect(decryptSecret(TOTP_KEY, account.totp_secret_enc).equals(superSecret)).toBe(true);
      expect(await ctx.redis.keys(`${ctx.prefix}:admin-pending-enrolment:*`)).toEqual([]);

      const closed = await bootstrapRow();
      expect(closed.closed_at).not.toBeNull();
      expect(closed.closed_by).toBe(account.id);
      const actions = (await owner<{ action: string }>('select action from app.audit_log where actor_id = $1 order by id', [account.id])).rows.map((row) => row.action);
      expect(actions).toEqual(['admin.totp_enrolled', 'admin.bootstrap_closed', 'admin.signed_in']);
      expect((await owner("select 1 from audit.security_events where event = 'admin_totp_enrolled' and subject_id = $1", [account.id])).rowCount).toBe(1);
      expect(await allHistory()).not.toContain(setupKey);
    });

    it('stays closed: no token works, the owner cannot reopen it, and the row cannot be changed back', async () => {
      expect((await app.inject({ method: 'GET', url: '/v1/admin/bootstrap', headers: adminCsrf })).json()).toEqual({ setupOpen: false });
      expect((await post('/v1/admin/bootstrap/waabek-key', { setupToken, apiKey: SECOND_KEY })).json().error.code).toBe('SETUP_UNAVAILABLE');
      expect((await post('/v1/admin/bootstrap/test-message', { setupToken })).json().error.code).toBe('SETUP_UNAVAILABLE');
      await expect(openBootstrap()).rejects.toThrow(/cannot be opened again/);
      await expect(owner('update app.admin_bootstrap set closed_at = null')).rejects.toThrow(/closed permanently/);
      await expect(owner('delete from app.admin_bootstrap')).rejects.toThrow(/cannot be deleted/);
      await expect(runtime('update app.admin_bootstrap set closed_at = null')).rejects.toThrow(/closed permanently/);
      expect(decryptWaabekApiKey(SETTINGS_KEY, (await settingsRow()).waabek_api_key_enc!)).toBe(FIRST_KEY);
    });

    it('signs in normally afterwards with the confirmed authenticator, and refuses a replayed code', async () => {
      const pending = await phoneStep(SUPER_PHONE);
      expect(pending.status).toBe('totp_required');
      expect((await post('/v1/admin/auth/totp/setup', { pendingToken: pending.pendingToken })).json().error.code).toBe('SESSION_INVALID');
      const used = hotp(superSecret, currentStep(Date.now()));
      expect((await post('/v1/admin/auth/totp/verify', { pendingToken: pending.pendingToken, code: used })).json().error.code).toBe('TOTP_INVALID');
      const next = hotp(superSecret, currentStep(Date.now()) + 1);
      expect((await post('/v1/admin/auth/totp/verify', { pendingToken: pending.pendingToken, code: next })).statusCode).toBe(200);
    });

    it('ends the setup attempt after 5 wrong authenticator codes', async () => {
      await owner("insert into app.admin_accounts (phone, name, role) values ('+201100000902', 'Brute', 'moderator')");
      const pending = await phoneStep('+201100000902');
      await post('/v1/admin/auth/totp/setup', { pendingToken: pending.pendingToken });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await post('/v1/admin/auth/totp/verify', { pendingToken: pending.pendingToken, code: '000000' });
      }
      expect((await post('/v1/admin/auth/totp/setup', { pendingToken: pending.pendingToken })).json().error.code).toBe('SESSION_INVALID');
      expect((await owner<{ totp_secret_enc: string | null }>("select totp_secret_enc from app.admin_accounts where phone = '+201100000902'")).rows[0]!.totp_secret_enc).toBeNull();
    });

    it('lets later SQL-created admins set up their authenticator the same way, without the setup', async () => {
      await owner("insert into app.admin_accounts (phone, name, role) values ('+201100000903', 'Second Moderator', 'moderator')");
      const pending = await phoneStep('+201100000903');
      expect(pending.status).toBe('totp_setup_required');
      const secret = base32Decode((await post('/v1/admin/auth/totp/setup', { pendingToken: pending.pendingToken })).json().setupKey);
      const done = await post('/v1/admin/auth/totp/verify', { pendingToken: pending.pendingToken, code: hotp(secret, currentStep(Date.now())) });
      expect(done.statusCode).toBe(200);
      const moderatorCookie = `${ADMIN_SESSION_COOKIE}=${cookieValue(done.headers['set-cookie'], ADMIN_SESSION_COOKIE)}`;
      expect((await bootstrapRow()).closed_by).not.toBeNull();

      // Moderators cannot see or change the OTP settings; each refusal is recorded.
      expect((await asAdmin(moderatorCookie, 'GET', '/v1/admin/settings/otp')).statusCode).toBe(403);
      expect((await asAdmin(moderatorCookie, 'PUT', '/v1/admin/settings/otp/waabek-key', { apiKey: SECOND_KEY, totpCode: '123456' })).statusCode).toBe(403);
      expect((await asAdmin(moderatorCookie, 'POST', '/v1/admin/settings/otp/test-message', {})).statusCode).toBe(403);
      expect((await owner("select 1 from app.audit_log where action = 'admin.action_refused'")).rowCount).toBe(3);
      expect(decryptWaabekApiKey(SETTINGS_KEY, (await settingsRow()).waabek_api_key_enc!)).toBe(FIRST_KEY);
    });

    it('keeps the Phase 2 flow for admins whose secret was stored before Phase 3.1', async () => {
      const secret = generateTotpSecret();
      await owner("insert into app.admin_accounts (phone, name, role, totp_secret_enc) values ('+201100000904', 'Earlier', 'moderator', $1)", [encryptSecret(TOTP_KEY, secret)]);
      const pending = await phoneStep('+201100000904');
      expect(pending.status).toBe('totp_required');
      expect((await post('/v1/admin/auth/totp/setup', { pendingToken: pending.pendingToken })).json().error.code).toBe('SESSION_INVALID');
      expect((await post('/v1/admin/auth/totp/verify', { pendingToken: pending.pendingToken, code: hotp(secret, currentStep(Date.now())) })).statusCode).toBe(200);
    });
  });

  describe('OTP / WhatsApp (Waabek) settings for Super Admins (D-32)', () => {
    it('shows whether a key is set, never the key', async () => {
      const response = await asAdmin(superCookie, 'GET', '/v1/admin/settings/otp');
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ provider: 'waabek', apiKeyConfigured: true, version: 1, updatedBy: null, updatedVia: 'initial_setup' });
      expect(response.body).not.toContain(FIRST_KEY);
      expect(response.body).not.toContain((await settingsRow()).waabek_api_key_enc!);
      expect((await owner("select 1 from app.audit_log where action = 'view.otp_settings'")).rowCount).toBe(1);
    });

    it('replaces the key only with a current authenticator code, and records it without the key', async () => {
      const wrong = await asAdmin(superCookie, 'PUT', '/v1/admin/settings/otp/waabek-key', { apiKey: SECOND_KEY, totpCode: '000000' });
      expect(wrong.json().error.code).toBe('TOTP_INVALID');
      expect(decryptWaabekApiKey(SETTINGS_KEY, (await settingsRow()).waabek_api_key_enc!)).toBe(FIRST_KEY);

      // As after an earlier sign-in: the authenticator's current code has not been used yet.
      await owner('update app.admin_accounts set totp_last_step = $1 where phone = $2', [currentStep(Date.now()) - 2, SUPER_PHONE]);
      const fresh = hotp(superSecret, currentStep(Date.now()));
      const saved = await asAdmin(superCookie, 'PUT', '/v1/admin/settings/otp/waabek-key', { apiKey: SECOND_KEY, totpCode: fresh });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json()).toEqual({ saved: true, version: 2 });
      expect(saved.body).not.toContain(SECOND_KEY);
      // The same code cannot be used again.
      expect((await asAdmin(superCookie, 'PUT', '/v1/admin/settings/otp/waabek-key', { apiKey: FIRST_KEY, totpCode: fresh })).json().error.code).toBe('TOTP_INVALID');

      const row = await settingsRow();
      expect(decryptWaabekApiKey(SETTINGS_KEY, row.waabek_api_key_enc!)).toBe(SECOND_KEY);
      expect(row.version).toBe('2');
      const view = (await asAdmin(superCookie, 'GET', '/v1/admin/settings/otp')).json();
      expect(view).toMatchObject({ apiKeyConfigured: true, version: 2, updatedBy: { name: 'Academy Admin' }, updatedVia: 'admin_dashboard' });
      const audit = await owner<{ actor_type: string; metadata: Record<string, unknown> }>(
        "select actor_type, metadata from app.audit_log where action = 'otp_settings.waabek_key_replaced' order by id",
      );
      expect(audit.rows).toEqual([
        { actor_type: 'system', metadata: { source: 'initial_setup', version: 1 } },
        { actor_type: 'admin', metadata: { source: 'admin_dashboard', version: 2 } },
      ]);
      const history = await allHistory();
      expect(history).not.toContain(FIRST_KEY);
      expect(history).not.toContain(SECOND_KEY);
    });

    it('sends a test message to the Super Admin\'s own number and records the result', async () => {
      testMessages.length = 0;
      testOutcome = 'ok';
      const ok = await asAdmin(superCookie, 'POST', '/v1/admin/settings/otp/test-message', {});
      expect(ok.json()).toEqual({ delivered: true, sentTo: '+905******942', reason: null, httpStatus: null });
      expect(testMessages).toEqual([SUPER_PHONE]);
      testOutcome = new Error(OTP_DELIVERY_ERRORS.notConfigured);
      expect((await asAdmin(superCookie, 'POST', '/v1/admin/settings/otp/test-message', {})).json()).toMatchObject({ delivered: false, reason: 'not_configured' });
      testOutcome = new Error('Waabek send failed: network error');
      expect((await asAdmin(superCookie, 'POST', '/v1/admin/settings/otp/test-message', {})).json()).toMatchObject({ delivered: false, reason: 'unreachable' });
      testOutcome = 'ok';
      const recorded = await owner("select 1 from app.audit_log where action = 'otp_settings.test_message' and actor_type = 'admin'");
      expect(recorded.rowCount).toBe(3);
    });

    it('limits test messages per admin', async () => {
      const answers = [];
      for (let index = 0; index < 3; index += 1) {
        answers.push((await asAdmin(superCookie, 'POST', '/v1/admin/settings/otp/test-message', {})).statusCode);
      }
      expect(answers).toEqual([200, 200, 429]);
    });
  });

  describe('owner-only Waabek key recovery (D-33)', () => {
    const RECOVERED_KEY = 'fake-waabek-key-owner-recovery-0003';
    let recoveryToken = '';
    let adminState = '';
    const snapshotAdminState = async () =>
      JSON.stringify([
        (await owner('select * from app.admin_accounts order by id')).rows,
        (await owner('select * from app.admin_sessions order by id')).rows,
        (await owner('select * from app.admin_bootstrap')).rows,
      ]);
    const recoveryRow = async () =>
      (await owner<{ token_hash: string | null; failed_attempts: number }>('select * from app.otp_settings_recovery')).rows[0]!;
    const status = async () => (await app.inject({ method: 'GET', url: '/v1/admin/otp-recovery', headers: adminCsrf })).json();

    it('is closed until the owner opens it', async () => {
      expect(await status()).toEqual({ recoveryOpen: false });
      const refused = await post('/v1/admin/otp-recovery/waabek-key', { recoveryToken: 'x'.repeat(43), apiKey: RECOVERED_KEY });
      expect(refused.json().error.code).toBe('RECOVERY_UNAVAILABLE');
      expect(await allHistory()).not.toContain(RECOVERED_KEY);
    });

    it('opens by the owner\'s SQL only, stores only the token hash and records the opening', async () => {
      adminState = await snapshotAdminState();
      const opened = (await owner<{ recovery_token: string; expires_at: Date }>('select * from app.open_otp_settings_recovery()')).rows[0]!;
      recoveryToken = opened.recovery_token;
      expect(recoveryToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const minutes = (new Date(opened.expires_at).getTime() - Date.now()) / 60_000;
      expect(minutes).toBeGreaterThan(29);
      expect(minutes).toBeLessThanOrEqual(30);
      expect((await recoveryRow()).token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(await allHistory()).not.toContain(recoveryToken);
      expect((await owner("select 1 from app.audit_log where action = 'otp_settings.recovery_opened' and actor_type = 'system'")).rowCount).toBe(1);
      expect(await status()).toEqual({ recoveryOpen: true });
      await expect(runtime('select * from app.open_otp_settings_recovery()')).rejects.toThrow(/permission denied/);
    });

    it('never signs anyone in and is not a setup token', async () => {
      const asPending = await post('/v1/admin/auth/totp/verify', { pendingToken: recoveryToken, code: '123456' });
      expect(asPending.json().error.code).toBe('SESSION_INVALID');
      expect(cookieValue(asPending.headers['set-cookie'], ADMIN_SESSION_COOKIE)).toBeNull();
      expect((await post('/v1/admin/auth/totp/setup', { pendingToken: recoveryToken })).json().error.code).toBe('SESSION_INVALID');
      expect((await post('/v1/admin/bootstrap/waabek-key', { setupToken: recoveryToken, apiKey: RECOVERED_KEY })).json().error.code).toBe('SETUP_UNAVAILABLE');
      const withoutCsrf = await app.inject({ method: 'POST', url: '/v1/admin/otp-recovery/waabek-key', payload: { recoveryToken, apiKey: RECOVERED_KEY } });
      expect(withoutCsrf.json().error.code).toBe('CSRF_REJECTED');
    });

    it('stores the new key encrypted, raises the settings version, and records the recovery without the key', async () => {
      const before = Number((await settingsRow()).version);
      expect((await post('/v1/admin/otp-recovery/waabek-key', { recoveryToken: 'w'.repeat(43), apiKey: RECOVERED_KEY })).json().error.code).toBe(
        'RECOVERY_TOKEN_INVALID',
      );
      expect((await recoveryRow()).failed_attempts).toBe(1);
      expect(decryptWaabekApiKey(SETTINGS_KEY, (await settingsRow()).waabek_api_key_enc!)).toBe(SECOND_KEY);

      const saved = await post('/v1/admin/otp-recovery/waabek-key', { recoveryToken, apiKey: RECOVERED_KEY });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json()).toEqual({ ok: true });
      expect(saved.headers['set-cookie']).toBeUndefined();
      expect(saved.body).not.toContain(RECOVERED_KEY);

      const row = (await owner<{ waabek_api_key_enc: string; version: string; updated_by: string | null; updated_via: string }>('select * from app.otp_settings')).rows[0]!;
      expect(Number(row.version)).toBe(before + 1);
      expect(row.waabek_api_key_enc).not.toContain(RECOVERED_KEY);
      expect(decryptWaabekApiKey(SETTINGS_KEY, row.waabek_api_key_enc)).toBe(RECOVERED_KEY);
      expect(row.updated_by).toBeNull();
      expect(row.updated_via).toBe('owner_recovery');
      const audit = await owner<{ actor_type: string; metadata: Record<string, unknown> }>(
        "select actor_type, metadata from app.audit_log where action = 'otp_settings.waabek_key_replaced' order by id desc limit 1",
      );
      expect(audit.rows).toEqual([{ actor_type: 'system', metadata: { source: 'owner_recovery', version: before + 1 } }]);
      expect((await owner("select 1 from audit.security_events where event = 'waabek_key_recovered'")).rowCount).toBe(1);
      expect(await allHistory()).not.toContain(RECOVERED_KEY);

      // One-time: the same token cannot save a second key, also not in parallel.
      const again = await Promise.all(
        [1, 2].map(() => post('/v1/admin/otp-recovery/waabek-key', { recoveryToken, apiKey: 'fake-waabek-key-second-attempt-0009' })),
      );
      expect(again.map((answer) => answer.json().error.code)).toEqual(['RECOVERY_TOKEN_USED', 'RECOVERY_TOKEN_USED']);
      expect(again.map((answer) => answer.statusCode)).toEqual([409, 409]);
      expect(decryptWaabekApiKey(SETTINGS_KEY, (await settingsRow()).waabek_api_key_enc!)).toBe(RECOVERED_KEY);
      expect(Number((await settingsRow()).version)).toBe(before + 1);
      expect((await owner("select 1 from audit.security_events where event = 'otp_recovery_token_reused'")).rowCount).toBe(2);
    });

    it('sends a test message to the first Super Admin with the recovery token', async () => {
      testMessages.length = 0;
      testOutcome = 'ok';
      const ok = await post('/v1/admin/otp-recovery/test-message', { recoveryToken });
      expect(ok.json()).toEqual({ delivered: true, sentTo: '+905******942', reason: null, httpStatus: null });
      expect(testMessages).toEqual([SUPER_PHONE]);
      expect(ok.headers['set-cookie']).toBeUndefined();
      const recorded = await owner<{ metadata: Record<string, unknown> }>(
        "select metadata from app.audit_log where action = 'otp_settings.test_message' order by id desc limit 1",
      );
      expect(recorded.rows[0]!.metadata).toMatchObject({ source: 'owner_recovery', delivered: true });
    });

    it('leaves admin accounts, authenticator secrets, roles, sessions and the closed bootstrap exactly as they were', async () => {
      expect(await snapshotAdminState()).toBe(adminState);
      expect((await bootstrapRow()).closed_at).not.toBeNull();
      await expect(openBootstrap()).rejects.toThrow(/cannot be opened again/);
      expect((await app.inject({ method: 'GET', url: '/v1/admin/bootstrap', headers: adminCsrf })).json()).toEqual({ setupOpen: false });
      // Signing in still needs the WhatsApp code and the authenticator; the recovered key is what delivers the code.
      const pending = await phoneStep(SUPER_PHONE);
      expect(pending.status).toBe('totp_required');
      expect((await post('/v1/admin/auth/totp/verify', { pendingToken: pending.pendingToken, code: '000000' })).json().error.code).toBe('TOTP_INVALID');
      const view = (await asAdmin(superCookie, 'GET', '/v1/admin/settings/otp')).json();
      expect(view).toMatchObject({ apiKeyConfigured: true, updatedBy: null, updatedVia: 'owner_recovery' });
    });

    it('locks the recovery token after 5 wrong attempts, expires it, and lets the owner issue a new one', async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await post('/v1/admin/otp-recovery/test-message', { recoveryToken: 'w'.repeat(43) });
      }
      expect((await recoveryRow()).failed_attempts).toBe(5);
      expect(await status()).toEqual({ recoveryOpen: false });
      expect((await post('/v1/admin/otp-recovery/waabek-key', { recoveryToken, apiKey: RECOVERED_KEY })).json().error.code).toBe('RECOVERY_UNAVAILABLE');

      const reissued = (await owner<{ recovery_token: string }>('select * from app.open_otp_settings_recovery()')).rows[0]!.recovery_token;
      expect(reissued).not.toBe(recoveryToken);
      expect((await post('/v1/admin/otp-recovery/waabek-key', { recoveryToken, apiKey: RECOVERED_KEY })).json().error.code).toBe('RECOVERY_TOKEN_INVALID');
      await owner("update app.otp_settings_recovery set expires_at = now() - interval '1 second'");
      expect((await post('/v1/admin/otp-recovery/waabek-key', { recoveryToken: reissued, apiKey: RECOVERED_KEY })).json().error.code).toBe(
        'RECOVERY_UNAVAILABLE',
      );
    });

    it('limits recovery requests per IP address', async () => {
      const ip = '10.73.0.1';
      const answers = [];
      for (let index = 0; index < 21; index += 1) {
        answers.push((await post('/v1/admin/otp-recovery/test-message', { recoveryToken: 'r'.repeat(43) }, adminCsrf, ip)).statusCode);
      }
      expect(answers.slice(0, 20).every((code) => code === 400 || code === 403)).toBe(true);
      expect(answers[20]).toBe(429);
    });
  });
});
