import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ADMIN_PASSWORD_RULES, ADMIN_SESSION_COOKIE } from '@bedo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../src/common/crypto.js';
import { currentStep, encryptSecret, generateTotpSecret, hotp } from '../src/admin/totp.js';
import {
  ADMIN_ORIGIN,
  ADMIN_TEST_PASSWORD,
  adminCsrf,
  allShortLivedState,
  clearState,
  cookieValue,
  type IntegrationEnv,
  issuePasswordSetup,
  latestCode,
  nextAdminIp,
  query,
  setupIntegrationEnv,
  startApp,
  TOTP_KEY,
} from './integration-env.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
let counter = 0;
const nextPhone = () => `+2010${String(Date.now() % 1e4).padStart(4, '0')}${String(++counter).padStart(4, '0')}`;

const tally = (codes: Array<string | undefined>) =>
  codes.reduce<Record<string, number>>((all, code) => ({ ...all, [code ?? 'ok']: (all[code ?? 'ok'] ?? 0) + 1 }), {});
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

interface Admin {
  id: string;
  phone: string;
  secret: Buffer;
}

/** Every password used in this file; none may ever appear in a response, the audit history or a stored value. */
const PASSWORDS = new Set<string>([ADMIN_TEST_PASSWORD]);
const remember = (password: string) => {
  PASSWORDS.add(password);
  return password;
};

/**
 * Phase 3.2 (D-34): admin sign-in is phone + password, then the mandatory authenticator code. Real Postgres and
 * Redis, with the API connected as the least-privilege runtime role.
 */
describe.runIf(enabled)('Phase 3.2 admin passwords (D-34, real Postgres + Redis, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  const responses: string[] = [];

  const send = async (method: 'GET' | 'POST', url: string, payload?: object, headers: Record<string, string> = adminCsrf, ip = nextAdminIp()) => {
    const response = await app.inject({ method, url, headers, remoteAddress: ip, ...(payload ? { payload } : {}) });
    responses.push(response.body);
    return response;
  };
  const login = (phone: string, password = ADMIN_TEST_PASSWORD, ip = nextAdminIp()) => send('POST', '/v1/admin/auth/password/login', { phone, password }, adminCsrf, ip);
  const setup = (phone: string, setupToken: string, password = ADMIN_TEST_PASSWORD, ip = nextAdminIp()) =>
    send('POST', '/v1/admin/auth/password/setup', { phone, setupToken, password }, adminCsrf, ip);
  const owner = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => query<T>(ctx.ownerUrl, sql, params);
  const runtime = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => query<T>(ctx.runtimeUrl, sql, params);
  const events = async (subjectId: string) =>
    (await owner<{ event: string }>('select event from audit.security_events where subject_id = $1 order by id', [subjectId])).rows.map((row) => row.event);
  const setupRow = async (adminId: string) =>
    (await owner<{ failed_attempts: number; used_at: Date | null; token_hash: string; is_reset: boolean }>('select * from app.admin_password_setup where admin_id = $1', [adminId]))
      .rows[0]!;
  const passwordHash = async (adminId: string) =>
    (await owner<{ password_hash: string | null }>('select password_hash from app.admin_accounts where id = $1', [adminId])).rows[0]!.password_hash;
  const liveSessions = async (adminId: string) =>
    Number((await owner<{ n: string }>('select count(*) as n from app.admin_sessions where admin_id = $1 and revoked_at is null', [adminId])).rows[0]!.n);
  const clearLimits = async (phone: string) => {
    await clearState(ctx, `rl:admin-password-lock:${phone}`, `rl:admin-password-fail:${phone}`);
  };

  /** An admin with an authenticator, created by SQL (no password yet). */
  async function createAdmin(role: 'super_admin' | 'moderator' = 'moderator'): Promise<Admin> {
    const phone = nextPhone();
    const secret = generateTotpSecret();
    const row = await owner<{ id: string }>('insert into app.admin_accounts (phone, name, role, totp_secret_enc) values ($1, $2, $3, $4) returning id', [
      phone,
      `${role} password tester`,
      role,
      encryptSecret(TOTP_KEY, secret),
    ]);
    return { id: row.rows[0]!.id, phone, secret };
  }

  async function withPassword(role: 'super_admin' | 'moderator' = 'moderator', password = ADMIN_TEST_PASSWORD): Promise<Admin> {
    const admin = await createAdmin(role);
    const response = await setup(admin.phone, await issuePasswordSetup(ctx.ownerUrl, admin.phone), password);
    expect(response.statusCode, response.body).toBe(200);
    return admin;
  }

  /** The last authenticator step this admin used (replay protection). */
  const lastStep = async (admin: Admin) =>
    Number((await owner<{ totp_last_step: string }>('select totp_last_step from app.admin_accounts where id = $1', [admin.id])).rows[0]!.totp_last_step);
  /** The next authenticator code the server accepts for this admin. */
  const nextCode = async (admin: Admin) => hotp(admin.secret, (await lastStep(admin)) + 1);

  /**
   * Password, then authenticator code. Returns the session cookie. Clears the replay marker first so that one
   * test can sign the same admin in several times within one 30-second step.
   */
  async function signIn(admin: Admin, password = ADMIN_TEST_PASSWORD): Promise<string> {
    await owner('update app.admin_accounts set totp_last_step = null where id = $1', [admin.id]);
    const pending = await login(admin.phone, password);
    expect(pending.statusCode, pending.body).toBe(200);
    const session = await send('POST', '/v1/admin/auth/totp/verify', { pendingToken: pending.json().pendingToken, code: hotp(admin.secret, currentStep(Date.now())) });
    expect(session.statusCode, session.body).toBe(200);
    return `${ADMIN_SESSION_COOKIE}=${cookieValue(session.headers['set-cookie'], ADMIN_SESSION_COOKIE)}`;
  }

  const asAdmin = (cookie: string, method: 'GET' | 'POST', url: string, payload?: object) => send(method, url, payload, { ...adminCsrf, cookie });
  const change = (cookie: string, body: { currentPassword: string; newPassword: string; totpCode: string }) => asAdmin(cookie, 'POST', '/v1/admin/account/password', body);

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    app = await startApp(ctx.env);
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  describe('password storage', () => {
    it('stores only an Argon2id hash (OWASP parameters) and the database refuses anything else', async () => {
      const admin = await withPassword();
      const stored = await passwordHash(admin.id);
      expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
      expect(stored).not.toContain(ADMIN_TEST_PASSWORD);
      // A second account with the same password gets a different salt and hash.
      const other = await withPassword();
      expect(await passwordHash(other.id)).not.toBe(stored);
      await expect(owner('update app.admin_accounts set password_hash = $1 where id = $2', [ADMIN_TEST_PASSWORD, admin.id])).rejects.toThrow(/check constraint/);
      await expect(owner('update app.admin_accounts set password_hash = $1 where id = $2', ['$argon2i$v=19$m=4096,t=3,p=1$abc$def', admin.id])).rejects.toThrow(
        /check constraint/,
      );
      const changedAt = (await owner<{ password_changed_at: Date | null }>('select password_changed_at from app.admin_accounts where id = $1', [admin.id])).rows[0]!;
      expect(changedAt.password_changed_at).not.toBeNull();
    });

    it('keeps the setup function and token issuing away from the runtime role', async () => {
      const admin = await createAdmin();
      await expect(runtime('select * from app.issue_admin_password_setup($1)', [admin.phone])).rejects.toThrow(/permission denied/);
      const token = await issuePasswordSetup(ctx.ownerUrl, admin.phone);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const row = await setupRow(admin.id);
      expect(row.token_hash).toBe(hashToken(token));
      expect(JSON.stringify(row)).not.toContain(token);
      await expect(runtime('update app.admin_password_setup set expires_at = now() + interval \'1 day\' where admin_id = $1', [admin.id])).rejects.toThrow(
        /permission denied/,
      );
      await expect(runtime('update app.admin_password_setup set token_hash = $1 where admin_id = $2', ['0'.repeat(64), admin.id])).rejects.toThrow(/permission denied/);
      await runtime('update app.admin_password_setup set failed_attempts = 2 where admin_id = $1', [admin.id]);
      await expect(runtime('update app.admin_password_setup set failed_attempts = 0 where admin_id = $1', [admin.id])).rejects.toThrow(/only the table owner/);
      await expect(runtime('insert into app.admin_password_setup (admin_id, token_hash, expires_at) values ($1, $2, now())', [admin.id, '0'.repeat(64)])).rejects.toThrow(
        /permission denied/,
      );
      await expect(runtime('delete from app.admin_password_setup where admin_id = $1', [admin.id])).rejects.toThrow(/permission denied/);
      await expect(runtime('update app.admin_accounts set password_changed_at = now() - interval \'1 day\' where id = $1', [admin.id])).rejects.toThrow(
        /permission denied/,
      );
      await expect(owner('select * from app.issue_admin_password_setup($1)', ['+19999999999'])).rejects.toThrow(/No admin account/);
      await owner("update app.admin_accounts set status = 'disabled' where id = $1", [admin.id]);
      await expect(owner('select * from app.issue_admin_password_setup($1)', [admin.phone])).rejects.toThrow(/not active/);
    });
  });

  describe('password rules', () => {
    it('refuses passwords shorter than 12 or longer than 128 characters, counting characters, and never echoes them', async () => {
      const admin = await createAdmin();
      const token = await issuePasswordSetup(ctx.ownerUrl, admin.phone);
      const short = remember('elevenchars');
      const tooShort = await setup(admin.phone, token, short);
      expect(tooShort.json().error.code).toBe('VALIDATION_FAILED');
      expect(tooShort.body).not.toContain(short);
      expect((await setup(admin.phone, token, remember('x'.repeat(129)))).json().error.code).toBe('VALIDATION_FAILED');
      // 12 emoji are 12 characters (24 UTF-16 units); no character classes are required.
      const emoji = remember('🔒'.repeat(12));
      expect((await setup(admin.phone, token, emoji)).statusCode).toBe(200);
      expect((await login(admin.phone, emoji)).statusCode).toBe(200);
      const maxLength = await withPassword('moderator', remember('a'.repeat(127) + 'z'));
      expect((await login(maxLength.phone, 'a'.repeat(127) + 'z')).statusCode).toBe(200);
    });

    it('refuses the admin\'s own phone number in any common spelling, without using up the token', async () => {
      const admin = await createAdmin();
      const token = await issuePasswordSetup(ctx.ownerUrl, admin.phone);
      const digits = admin.phone.slice(1);
      const national = `0${digits.slice(2)}`;
      // Phone-number spellings are not added to PASSWORDS: the number itself is rightly in the audit history.
      for (const spelling of [
        admin.phone,
        digits,
        `00${digits}`,
        national,
        `${admin.phone.slice(0, 3)} ${digits.slice(2, 6)} ${digits.slice(6)}`,
        `(${national.slice(0, 4)}) ${national.slice(4)}`,
        `+${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`,
        `${national}   `,
      ]) {
        // Spellings shorter than 12 characters are already refused by the length rule.
        const expected = [...spelling].length < ADMIN_PASSWORD_RULES.minLength ? 'VALIDATION_FAILED' : 'PASSWORD_IS_PHONE';
        expect((await setup(admin.phone, token, spelling)).json().error.code, spelling).toBe(expected);
      }
      const row = await setupRow(admin.id);
      expect(row.used_at).toBeNull();
      expect(row.failed_attempts).toBe(0);
      expect(await passwordHash(admin.id)).toBeNull();
      // A password that merely contains digits of the number is fine.
      expect((await setup(admin.phone, token, remember(`my ${digits} lantern`))).statusCode).toBe(200);
    });

    it('refuses passwords on the built-in common-password list (case-insensitive), without using up the token', async () => {
      const admin = await createAdmin();
      const token = await issuePasswordSetup(ctx.ownerUrl, admin.phone);
      for (const common of ['123456789012', 'qwertyuiopasdfghjkl', 'Password1234', 'IloveYOU1234']) {
        const response = await setup(admin.phone, token, remember(common));
        expect(response.json().error.code, common).toBe('PASSWORD_TOO_COMMON');
      }
      expect((await setupRow(admin.id)).used_at).toBeNull();
      expect((await setup(admin.phone, token, ADMIN_TEST_PASSWORD)).statusCode).toBe(200);
    });
  });

  describe('sign-in answers (no account discovery)', () => {
    it('answers unknown numbers, accounts without a password, disabled accounts and wrong passwords identically', async () => {
      const right = await withPassword();
      const noPassword = await createAdmin();
      const disabled = await withPassword();
      await owner("update app.admin_accounts set status = 'disabled' where id = $1", [disabled.id]);

      const cases = {
        unknown: () => login(nextPhone(), remember('some-guess-password-1')),
        noPassword: () => login(noPassword.phone, remember('some-guess-password-2')),
        disabled: () => login(disabled.phone, ADMIN_TEST_PASSWORD),
        wrongPassword: () => login(right.phone, remember('some-guess-password-3')),
      };
      const shapes = new Set<string>();
      const timings: Record<string, number[]> = {};
      for (let round = 0; round < 4; round += 1) {
        for (const [name, run] of Object.entries(cases)) {
          const started = performance.now();
          const response = await run();
          (timings[name] ??= []).push(performance.now() - started);
          expect(response.statusCode, name).toBe(401);
          const { requestId, ...error } = response.json().error;
          expect(requestId).toBeTruthy();
          shapes.add(JSON.stringify({ status: response.statusCode, error, cookie: response.headers['set-cookie'] ?? null }));
        }
      }
      expect([...shapes]).toEqual([JSON.stringify({ status: 401, error: { code: 'CREDENTIALS_INVALID', message: 'The phone number or password is incorrect.' }, cookie: null })]);
      // Every path does one Argon2id verification, so none is markedly faster than a wrong password.
      const reference = median(timings.wrongPassword!);
      for (const [name, values] of Object.entries(timings)) {
        expect(median(values) / reference, name).toBeGreaterThan(0.5);
        expect(median(values) / reference, name).toBeLessThan(2);
      }
      // Unknown numbers are locked out exactly like admin numbers.
      const stranger = nextPhone();
      for (let attempt = 0; attempt < ADMIN_PASSWORD_RULES.maxFailedPerAccount; attempt += 1) {
        expect((await login(stranger, 'whatever-password')).json().error.code).toBe('CREDENTIALS_INVALID');
      }
      expect((await login(stranger, 'whatever-password')).json().error.code).toBe('RATE_LIMITED');
    });

    it('records the real reason only in the security history', async () => {
      const noPassword = await createAdmin();
      await login(noPassword.phone, 'some-guess-password-4');
      const details = (await owner<{ details: { reason: string } }>("select details from audit.security_events where subject_id = $1 and event = 'admin_password_failed'", [noPassword.id]))
        .rows;
      expect(details.map((row) => row.details.reason)).toEqual(['no_password']);
    });
  });

  describe('account lockout and IP limit', () => {
    it('locks the number for 15 minutes after 5 wrong passwords, even for the right password, then works again', async () => {
      const admin = await withPassword();
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        expect((await login(admin.phone, `wrong-password-${attempt}xx`)).json().error.code).toBe('CREDENTIALS_INVALID');
      }
      const locked = await login(admin.phone, ADMIN_TEST_PASSWORD);
      expect(locked.statusCode).toBe(429);
      expect(locked.json().error.code).toBe('RATE_LIMITED');
      expect(locked.json().error.retryAfterSeconds).toBeGreaterThan(14 * 60);
      expect(locked.json().error.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
      const lock = await owner<{ ttl: string }>("select extract(epoch from (expires_at - now()))::text as ttl from app.ephemeral where key = $1", [`rl:admin-password-lock:${admin.phone}`]);
      expect(Number(lock.rows[0]!.ttl)).toBeGreaterThan(14 * 60);
      expect(await events(admin.id)).toContain('admin_password_failed');
      expect((await owner("select 1 from audit.security_events where phone = $1 and event = 'admin_password_locked'", [admin.phone])).rowCount).toBe(1);
      expect((await owner("select 1 from audit.security_events where phone = $1 and event = 'admin_password_locked_attempt'", [admin.phone])).rowCount).toBe(1);
      // After the 15 minutes (simulated), the right password works and clears the count.
      await clearLimits(admin.phone);
      expect((await login(admin.phone)).statusCode).toBe(200);
    });

    it('counts attempts before checking the password: 30 parallel guesses get at most 5 checks', async () => {
      const admin = await withPassword();
      const results = await Promise.all(Array.from({ length: 30 }, (_, index) => login(admin.phone, `parallel-guess-${index}-xyz`)));
      const counts = tally(results.map((result) => result.json().error?.code));
      expect(counts.CREDENTIALS_INVALID ?? 0).toBeLessThanOrEqual(5);
      expect(counts.RATE_LIMITED ?? 0).toBeGreaterThanOrEqual(25);
      expect((await login(admin.phone)).json().error.code).toBe('RATE_LIMITED');
      const checked = (await owner("select 1 from audit.security_events where subject_id = $1 and event = 'admin_password_failed'", [admin.id])).rowCount;
      expect(checked).toBeLessThanOrEqual(5);
    });

    it('a correct password clears earlier failures', async () => {
      const admin = await withPassword();
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await login(admin.phone, `wrong-password-${attempt}yy`);
      }
      expect((await login(admin.phone)).statusCode).toBe(200);
      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect((await login(admin.phone, `wrong-password-${attempt}zz`)).json().error.code).toBe('CREDENTIALS_INVALID');
      }
      expect((await login(admin.phone)).statusCode).toBe(200);
    });

    it('allows 20 password attempts per IP address per 15 minutes, across numbers', async () => {
      const ip = '198.51.100.20';
      for (let attempt = 0; attempt < ADMIN_PASSWORD_RULES.maxAttemptsPerIp; attempt += 1) {
        expect((await login(nextPhone(), 'from-one-address-pw', ip)).json().error.code).toBe('CREDENTIALS_INVALID');
      }
      const limited = await login(nextPhone(), 'from-one-address-pw', ip);
      expect(limited.json().error.code).toBe('RATE_LIMITED');
      expect(limited.json().error.retryAfterSeconds).toBeGreaterThan(14 * 60);
      // Even the right password for a real admin is refused from that address; other addresses are unaffected.
      const admin = await withPassword();
      expect((await login(admin.phone, ADMIN_TEST_PASSWORD, ip)).json().error.code).toBe('RATE_LIMITED');
      expect((await login(admin.phone)).statusCode).toBe(200);
      // The setup endpoint has its own per-IP limit.
      for (let attempt = 0; attempt < ADMIN_PASSWORD_RULES.maxAttemptsPerIp; attempt += 1) {
        await setup(nextPhone(), 'x'.repeat(43), ADMIN_TEST_PASSWORD, '198.51.100.21');
      }
      expect((await setup(nextPhone(), 'x'.repeat(43), ADMIN_TEST_PASSWORD, '198.51.100.21')).json().error.code).toBe('RATE_LIMITED');
    });
  });

  describe('setup token', () => {
    it('sets the first password, never signs in, and works only once', async () => {
      const admin = await createAdmin();
      const token = await issuePasswordSetup(ctx.ownerUrl, admin.phone);
      const response = await setup(admin.phone, token);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(await liveSessions(admin.id)).toBe(0);
      expect((await setupRow(admin.id)).used_at).not.toBeNull();
      expect((await setup(admin.phone, token, remember('second-use-password-1'))).json().error.code).toBe('PASSWORD_SETUP_INVALID');
      // The second attempt changed nothing.
      expect((await login(admin.phone)).statusCode).toBe(200);
      expect((await login(admin.phone, 'second-use-password-1')).json().error.code).toBe('CREDENTIALS_INVALID');
      expect(await events(admin.id)).toEqual(expect.arrayContaining(['admin_password_setup_issued', 'admin_password_set', 'admin_password_setup_refused', 'admin_password_verified']));
      const audit = await owner<{ action: string; metadata: Record<string, unknown> }>("select action, metadata from app.audit_log where target_id = $1 order by id", [admin.id]);
      expect(audit.rows.map((row) => row.action)).toEqual(['admin.password_setup_issued', 'admin.password_set']);
      expect(audit.rows[1]!.metadata).toMatchObject({ source: 'owner_setup_token', reset: false, sessionsEnded: 0 });
    });

    it('expires after 60 minutes', async () => {
      const admin = await createAdmin();
      const token = await issuePasswordSetup(ctx.ownerUrl, admin.phone);
      const issued = (await owner<{ minutes: number }>('select extract(epoch from expires_at - issued_at) / 60 as minutes from app.admin_password_setup where admin_id = $1', [admin.id]))
        .rows[0]!;
      expect(Number(issued.minutes)).toBe(60);
      await owner("update app.admin_password_setup set expires_at = now() - interval '1 second' where admin_id = $1", [admin.id]);
      expect((await setup(admin.phone, token)).json().error.code).toBe('PASSWORD_SETUP_INVALID');
      expect(await passwordHash(admin.id)).toBeNull();
    });

    it('stops after 5 wrong tokens (also in parallel) and gives every problem the same answer', async () => {
      const admin = await createAdmin();
      const token = await issuePasswordSetup(ctx.ownerUrl, admin.phone);
      const wrong = await Promise.all(Array.from({ length: 8 }, (_, index) => setup(admin.phone, `wrong-setup-token-${index}-${'q'.repeat(20)}`)));
      const shapes = new Set(wrong.map((response) => `${response.statusCode}:${response.json().error.code}`));
      expect([...shapes]).toEqual(['400:PASSWORD_SETUP_INVALID']);
      expect((await setupRow(admin.id)).failed_attempts).toBe(ADMIN_PASSWORD_RULES.maxFailedSetupTokenAttempts);
      // The right token no longer works; the answer is the same as for an unknown number or a wrong token.
      const late = await setup(admin.phone, token);
      const unknown = await setup(nextPhone(), token);
      const otherAdmin = await createAdmin();
      const crossAccount = await setup(otherAdmin.phone, token);
      for (const response of [late, unknown, crossAccount]) {
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('PASSWORD_SETUP_INVALID');
        expect(response.json().error.message).toBe(late.json().error.message);
      }
      expect(await passwordHash(admin.id)).toBeNull();
      expect(await events(admin.id)).toContain('admin_password_setup_token_failed');
      // The owner can issue a new token, which starts from zero.
      const fresh = await issuePasswordSetup(ctx.ownerUrl, admin.phone);
      expect((await setupRow(admin.id)).failed_attempts).toBe(0);
      expect((await setup(admin.phone, token)).json().error.code).toBe('PASSWORD_SETUP_INVALID');
      expect((await setup(admin.phone, fresh)).statusCode).toBe(200);
    });
  });

  describe('owner reset', () => {
    it('removes the password at once, ends every session and pending sign-in, and lifts a lockout once a new password is set', async () => {
      const admin = await withPassword('super_admin');
      const first = await signIn(admin);
      const second = await signIn(admin);
      const pending = (await login(admin.phone)).json().pendingToken as string;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await login(admin.phone, `locking-out-pw-${attempt}`);
      }
      expect(await liveSessions(admin.id)).toBe(2);

      const token = await issuePasswordSetup(ctx.ownerUrl, admin.phone);
      expect(await passwordHash(admin.id)).toBeNull();
      expect(await liveSessions(admin.id)).toBe(0);
      expect((await asAdmin(first, 'GET', '/v1/admin/session')).statusCode).toBe(401);
      expect((await asAdmin(second, 'GET', '/v1/admin/session')).statusCode).toBe(401);
      // A sign-in started with the old password cannot be finished.
      const finish = await send('POST', '/v1/admin/auth/totp/verify', { pendingToken: pending, code: await nextCode(admin) });
      expect(finish.json().error.code).toBe('SESSION_INVALID');
      expect((await setupRow(admin.id)).is_reset).toBe(true);
      const audit = await owner<{ action: string; metadata: { sessionsEnded: number } }>("select action, metadata from app.audit_log where target_id = $1 and action = 'admin.password_reset_issued'", [admin.id]);
      expect(audit.rows[0]?.metadata.sessionsEnded).toBe(2);
      expect(await events(admin.id)).toContain('admin_password_reset_issued');

      const newPassword = remember('after-the-reset-pass-9');
      expect((await setup(admin.phone, token, newPassword)).statusCode).toBe(200);
      expect((await login(admin.phone, ADMIN_TEST_PASSWORD)).json().error.code).toBe('CREDENTIALS_INVALID');
      const cookie = await signIn(admin, newPassword);
      expect((await asAdmin(cookie, 'GET', '/v1/admin/session')).statusCode).toBe(200);
      const set = await owner<{ metadata: { reset: boolean } }>("select metadata from app.audit_log where target_id = $1 and action = 'admin.password_set'", [admin.id]);
      expect(set.rows.at(-1)?.metadata.reset).toBe(true);
    });
  });

  describe('mandatory authenticator', () => {
    it('never creates a session from the password alone', async () => {
      const admin = await withPassword('super_admin');
      const response = await login(admin.phone);
      expect(response.json()).toEqual({ status: 'totp_required', pendingToken: expect.any(String) });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(await liveSessions(admin.id)).toBe(0);
      const pendingToken = response.json().pendingToken as string;
      for (const cookie of [`${ADMIN_SESSION_COOKIE}=${pendingToken}`, `${ADMIN_SESSION_COOKIE}=`]) {
        expect((await asAdmin(cookie, 'GET', '/v1/admin/session')).statusCode).toBe(401);
      }
      const bearer = await send('GET', '/v1/admin/session', undefined, { ...adminCsrf, authorization: `Bearer ${pendingToken}` });
      expect(bearer.statusCode).toBe(401);
      expect((await send('POST', '/v1/admin/auth/totp/verify', { pendingToken, code: '000000' })).json().error.code).toBe('TOTP_INVALID');
      expect(await liveSessions(admin.id)).toBe(0);
    });

    it('requires authenticator setup first for an account without one', async () => {
      const phone = nextPhone();
      const row = await owner<{ id: string }>("insert into app.admin_accounts (phone, name, role) values ($1, 'No authenticator', 'moderator') returning id", [phone]);
      expect((await setup(phone, await issuePasswordSetup(ctx.ownerUrl, phone))).statusCode).toBe(200);
      const response = await login(phone);
      expect(response.json().status).toBe('totp_setup_required');
      expect(await liveSessions(row.rows[0]!.id)).toBe(0);
    });

    it('sends no WhatsApp code for admin sign-in', async () => {
      const admin = await withPassword();
      await signIn(admin);
      expect(await latestCode(ctx.waabek, admin.phone)).toBeNull();
    });
  });

  describe('password change', () => {
    it('needs the current password and a current authenticator code, ends the other sessions and keeps this one', async () => {
      const admin = await withPassword();
      const current = await signIn(admin);
      const other = await signIn(admin);
      const pendingWithOld = (await login(admin.phone)).json().pendingToken as string;
      const newPassword = remember('changed-by-myself-pass-1');

      const wrongPassword = await change(current, { currentPassword: remember('not-my-current-pw'), newPassword, totpCode: await nextCode(admin) });
      expect(wrongPassword.statusCode).toBe(401);
      expect(wrongPassword.json().error.code).toBe('CREDENTIALS_INVALID');
      // The last code used for sign-in cannot be used again (replay protection).
      const replay = await change(current, { currentPassword: ADMIN_TEST_PASSWORD, newPassword, totpCode: hotp(admin.secret, await lastStep(admin)) });
      expect(replay.json().error.code).toBe('CREDENTIALS_INVALID');
      // Rules are checked before the code is used up.
      expect((await change(current, { currentPassword: ADMIN_TEST_PASSWORD, newPassword: remember('Password1234'), totpCode: await nextCode(admin) })).json().error.code).toBe(
        'PASSWORD_TOO_COMMON',
      );
      expect((await change(current, { currentPassword: ADMIN_TEST_PASSWORD, newPassword: admin.phone, totpCode: await nextCode(admin) })).json().error.code).toBe(
        'PASSWORD_IS_PHONE',
      );
      expect(await passwordHash(admin.id)).toMatch(/^\$argon2id\$/);

      const usedCode = await nextCode(admin);
      const done = await change(current, { currentPassword: ADMIN_TEST_PASSWORD, newPassword, totpCode: usedCode });
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json()).toEqual({ changed: true, otherSessionsEnded: 1 });
      expect((await asAdmin(current, 'GET', '/v1/admin/session')).statusCode).toBe(200);
      expect((await asAdmin(other, 'GET', '/v1/admin/session')).statusCode).toBe(401);
      expect(await liveSessions(admin.id)).toBe(1);
      // The same code cannot change it again.
      expect((await change(current, { currentPassword: newPassword, newPassword: remember('changed-again-pass-22'), totpCode: usedCode })).json().error.code).toBe(
        'CREDENTIALS_INVALID',
      );
      // A sign-in started with the old password cannot be finished.
      expect((await send('POST', '/v1/admin/auth/totp/verify', { pendingToken: pendingWithOld, code: await nextCode(admin) })).json().error.code).toBe(
        'SESSION_INVALID',
      );
      expect((await login(admin.phone, ADMIN_TEST_PASSWORD)).json().error.code).toBe('CREDENTIALS_INVALID');
      expect((await login(admin.phone, newPassword)).statusCode).toBe(200);

      expect(await events(admin.id)).toEqual(expect.arrayContaining(['admin_password_changed']));
      const audit = await owner<{ action: string; actor_id: string; metadata: Record<string, unknown> }>(
        "select action, actor_id, metadata from app.audit_log where action = 'admin.password_changed' and target_id = $1",
        [admin.id],
      );
      expect(audit.rows).toEqual([{ action: 'admin.password_changed', actor_id: admin.id, metadata: { otherSessionsEnded: 1 } }]);
    });

    it('is open to every role and limited to 5 attempts per 15 minutes', async () => {
      const admin = await withPassword('moderator');
      const cookie = await signIn(admin);
      const attempts = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        attempts.push(await change(cookie, { currentPassword: `wrong-current-${attempt}`, newPassword: remember('moderator-new-pass-1'), totpCode: '000000' }));
      }
      expect(attempts.slice(0, 5).map((response) => response.json().error.code)).toEqual(Array(5).fill('CREDENTIALS_INVALID'));
      expect(attempts[5]!.json().error.code).toBe('RATE_LIMITED');
      expect(await passwordHash(admin.id)).not.toBeNull();
    });

    it('needs a signed-in admin session', async () => {
      const response = await send('POST', '/v1/admin/account/password', { currentPassword: ADMIN_TEST_PASSWORD, newPassword: 'whatever-new-pass', totpCode: '123456' });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('CSRF and admin origin', () => {
    it('refuses sign-in, set password and change password without the CSRF header or from another origin', async () => {
      const admin = await withPassword();
      const cookie = await signIn(admin);
      const token = await issuePasswordSetup(ctx.ownerUrl, (await createAdmin()).phone);
      const bodies = {
        '/v1/admin/auth/password/login': { phone: admin.phone, password: ADMIN_TEST_PASSWORD },
        '/v1/admin/auth/password/setup': { phone: admin.phone, setupToken: token, password: ADMIN_TEST_PASSWORD },
        '/v1/admin/account/password': { currentPassword: ADMIN_TEST_PASSWORD, newPassword: 'csrf-new-password-1', totpCode: '123456' },
      };
      for (const [url, payload] of Object.entries(bodies)) {
        const attempts: Array<Record<string, string>> = [
          { origin: ADMIN_ORIGIN, cookie },
          { origin: 'http://localhost:8080', 'x-bedo-csrf': '1', cookie },
          { origin: 'https://evil.example', 'x-bedo-csrf': '1', cookie },
          { 'x-bedo-csrf': '1', 'sec-fetch-site': 'cross-site', cookie },
        ];
        for (const headers of attempts) {
          const response = await send('POST', url, payload, headers);
          expect(response.statusCode, `${url} ${JSON.stringify(headers)}`).toBe(403);
          expect(response.json().error.code).toBe('CSRF_REJECTED');
        }
      }
      expect(await liveSessions(admin.id)).toBe(1);
    });
  });

  it('never puts a password into responses, the audit history or stored values', async () => {
    const history = JSON.stringify([
      (await owner('select * from app.audit_log')).rows,
      (await owner('select * from audit.security_events')).rows,
      (await owner('select * from app.admin_password_setup')).rows,
      (await owner('select id, phone, name, password_hash from app.admin_accounts')).rows,
    ]);
    const stateValues = await allShortLivedState(ctx);
    for (const password of PASSWORDS) {
      expect(history.includes(password), password).toBe(false);
      expect(stateValues.includes(password), password).toBe(false);
      expect(responses.some((body) => body.includes(password)), password).toBe(false);
    }
  });
});
