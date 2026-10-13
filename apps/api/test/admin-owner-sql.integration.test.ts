import { readFileSync } from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ADMIN_SESSION_COOKIE } from '@bedo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, currentStep, encryptSecret, generateTotpSecret, hotp } from '../src/admin/totp.js';
import {
  adminCsrf,
  allShortLivedState,
  clearState,
  cookieValue,
  type IntegrationEnv,
  issuePasswordSetup,
  nextAdminIp,
  query,
  setupIntegrationEnv,
  startApp,
  TOTP_KEY,
} from './integration-env.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

/** The owner script exactly as delivered (D-35). Tests only replace the three input values. */
const SCRIPT = readFileSync(new URL('../../../docs/owner-sql/set-super-admin.sql', import.meta.url), 'utf8');
const sqlText = (value: string) => `'${value.replace(/'/g, "''")}'`;
function ownerScript(input: { phone: string; name?: string; password: string }): string {
  const lines = [
    [/input_phone {4}constant text := '[^']*';/, `input_phone    constant text := ${sqlText(input.phone)};`],
    [/input_name {5}constant text := '[^']*';/, `input_name     constant text := ${sqlText(input.name ?? 'Academy Admin')};`],
    [/input_password constant text := 'MY_PASSWORD_HERE';/, `input_password constant text := ${sqlText(input.password)};`],
  ] as const;
  let script = SCRIPT;
  for (const [pattern, replacement] of lines) {
    expect(script).toMatch(pattern);
    script = script.replace(pattern, replacement);
  }
  return script;
}

let counter = 0;
const nextPhone = () => `+90544${String(Date.now() % 1e3).padStart(3, '0')}${String(++counter).padStart(4, '0')}`;
const PASSWORD = ['harbour', 'violet', 'compass', '8826'].join('-');
const PASSWORDS = new Set<string>([PASSWORD]);
const remember = (value: string) => {
  PASSWORDS.add(value);
  return value;
};

/**
 * D-35 (Phase 3.2.1): the owner sets an admin's password with ONE SQL script in the Supabase SQL editor. Real
 * Postgres (all migrations, from an empty database) and Redis; the API connects as the least-privilege runtime role.
 */
describe.runIf(enabled)('D-35 owner SQL password (real Postgres + Redis, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  const responses: string[] = [];

  const send = async (url: string, payload: object, headers: Record<string, string> = adminCsrf) => {
    const response = await app.inject({ method: 'POST', url, headers, payload, remoteAddress: nextAdminIp() });
    responses.push(response.body);
    return response;
  };
  const login = (phone: string, password: string) => send('/v1/admin/auth/password/login', { phone, password });
  const owner = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => query<T>(ctx.ownerUrl, sql, params);
  const account = async (phone: string) =>
    (
      await owner<{ id: string; name: string; role: string; status: string; password_hash: string | null; password_changed_at: Date | null; totp_secret_enc: string | null }>(
        'select * from app.admin_accounts where phone = $1',
        [phone],
      )
    ).rows[0]!;
  const liveSessions = async (adminId: string) =>
    Number((await owner<{ n: string }>('select count(*) as n from app.admin_sessions where admin_id = $1 and revoked_at is null', [adminId])).rows[0]!.n);
  /** Runs the whole script (several statements) and returns the rows of its final select. */
  const runScript = async (input: { phone: string; name?: string; password: string }) => {
    const results = (await owner(ownerScript(input))) as unknown as Array<{ rows: Record<string, unknown>[] }> | { rows: Record<string, unknown>[] };
    return { rows: Array.isArray(results) ? results.at(-1)!.rows : results.rows };
  };
  const clearLimits = (phone: string) => clearState(ctx, `rl:admin-password-lock:${phone}`, `rl:admin-password-fail:${phone}`);

  /** Sets up the authenticator at the first sign-in and returns the secret and the session cookie. */
  async function firstSignIn(phone: string, password: string) {
    const step1 = await login(phone, password);
    expect(step1.statusCode, step1.body).toBe(200);
    expect(step1.json().status).toBe('totp_setup_required');
    const setup = await send('/v1/admin/auth/totp/setup', { pendingToken: step1.json().pendingToken });
    const secret = base32Decode(setup.json().setupKey);
    const done = await send('/v1/admin/auth/totp/verify', { pendingToken: step1.json().pendingToken, code: hotp(secret, currentStep(Date.now())) });
    expect(done.statusCode, done.body).toBe(200);
    return { secret, cookie: `${ADMIN_SESSION_COOKIE}=${cookieValue(done.headers['set-cookie'], ADMIN_SESSION_COOKIE)}` };
  }

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    app = await startApp(ctx.env);
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  describe('database (migration 20261006120000)', () => {
    it('applies from an empty database and allows only Argon2id or the exact owner-SQL bcrypt form', async () => {
      const applied = await owner<{ version: string }>("select version from app_meta.schema_migrations where version = '20261006120000'");
      expect(applied.rowCount).toBe(1);
      const phone = nextPhone();
      await owner("insert into app.admin_accounts (phone, name, role) values ($1, 'Constraint', 'moderator')", [phone]);
      const set = (hash: string) => owner('update app.admin_accounts set password_hash = $1 where phone = $2', [hash, phone]);
      const salt22 = 'abcdefghijklmnopqrstuv';
      const hash31 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
      await expect(set(`$2a$12$${salt22}${hash31}`)).resolves.toBeDefined();
      await expect(set('$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA')).resolves.toBeDefined();
      for (const refused of [`$2a$04$${salt22}${hash31}`, `$2b$12$${salt22}${hash31}`, `$2a$12$${salt22}${hash31}x`, 'plain-text-password', '$argon2i$v=19$m=4096,t=3,p=1$c2FsdA$aGFzaA']) {
        await expect(set(refused), refused).rejects.toThrow(/admin_accounts_password_hash_check/);
      }
    });

    it('the script refuses wrong input, a placeholder password and a non-owner, and changes nothing then', async () => {
      const phone = nextPhone();
      await expect(owner(SCRIPT)).rejects.toThrow(/replace MY_PASSWORD_HERE/);
      await expect(runScript({ phone, password: remember('short-pass') })).rejects.toThrow(/12 to 128 characters/);
      await expect(runScript({ phone, password: remember('x'.repeat(129)) })).rejects.toThrow(/12 to 128 characters/);
      await expect(runScript({ phone: phone.slice(1), password: PASSWORD })).rejects.toThrow(/international form/);
      await expect(runScript({ phone, name: '', password: PASSWORD })).rejects.toThrow(/name must be 1 to 64/);
      for (const spelling of [phone, phone.slice(1), `00${phone.slice(1)}`, `0${phone.slice(3)}  `, `${phone.slice(0, 3)} ${phone.slice(3, 6)} ${phone.slice(6)}`]) {
        expect([...spelling].length, spelling).toBeGreaterThanOrEqual(12);
        await expect(runScript({ phone, password: spelling }), spelling).rejects.toThrow(/cannot be your phone number/);
      }
      await expect(query(ctx.runtimeUrl, ownerScript({ phone, password: PASSWORD }))).rejects.toThrow(/run this as postgres/);
      expect((await owner('select 1 from app.admin_accounts where phone = $1', [phone])).rowCount).toBe(0);
    });
  });

  describe('new admin', () => {
    it('creates an active super_admin whose password works, with the authenticator still required', async () => {
      const phone = nextPhone();
      const result = await runScript({ phone, password: PASSWORD });
      expect(result.rows.at(-1)).toMatchObject({ phone, name: 'Academy Admin', role: 'super_admin', status: 'active', has_password: true, authenticator_set_up: false });
      const created = await account(phone);
      expect(created.password_hash).toMatch(/^\$2a\$12\$[./A-Za-z0-9]{53}$/);
      expect(created.totp_secret_enc).toBeNull();
      const audit = await owner<{ metadata: Record<string, unknown> }>("select metadata from app.audit_log where action = 'admin.password_set' and target_id = $1", [created.id]);
      expect(audit.rows[0]!.metadata).toMatchObject({ source: 'owner_sql', created: true, sessionsEnded: 0, setupTokensClosed: 0 });

      // A wrong password fails like any other wrong password, and nothing is upgraded.
      const wrong = await login(phone, remember('harbour-violet-compass-8827'));
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json().error.code).toBe('CREDENTIALS_INVALID');
      expect((await account(phone)).password_hash).toBe(created.password_hash);

      // The password alone never creates a session: authenticator setup, then a session.
      const step1 = await login(phone, PASSWORD);
      expect(step1.json().status).toBe('totp_setup_required');
      expect(step1.headers['set-cookie']).toBeUndefined();
      expect(await liveSessions(created.id)).toBe(0);
    });

    it('upgrades the bcrypt hash to the normal Argon2id hash on the first successful sign-in', async () => {
      const phone = nextPhone();
      await runScript({ phone, password: PASSWORD });
      const before = await account(phone);
      const { cookie } = await firstSignIn(phone, PASSWORD);
      const after = await account(phone);
      expect(after.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(after.password_changed_at).not.toBeNull();
      expect(new Date(after.password_changed_at!).getTime()).toBeGreaterThanOrEqual(new Date(before.password_changed_at!).getTime());
      expect((await owner("select 1 from audit.security_events where subject_id = $1 and event = 'admin_password_upgraded'", [after.id])).rowCount).toBe(1);
      expect((await owner("select 1 from app.audit_log where target_id = $1 and action = 'admin.password_hash_upgraded'", [after.id])).rowCount).toBe(1);
      expect((await app.inject({ method: 'GET', url: '/v1/admin/session', headers: { ...adminCsrf, cookie } })).json().admin.role).toBe('super_admin');
      // Later sign-ins use Argon2id: the same password still works, a wrong one does not, nothing is upgraded again.
      expect((await login(phone, PASSWORD)).json().status).toBe('totp_required');
      expect((await login(phone, remember('harbour-violet-compass-8828'))).json().error.code).toBe('CREDENTIALS_INVALID');
      expect((await account(phone)).password_hash).toBe(after.password_hash);
      expect((await owner("select 1 from audit.security_events where subject_id = $1 and event = 'admin_password_upgraded'", [after.id])).rowCount).toBe(1);
    });

    it('lets the admin change the password afterwards (current password + authenticator code)', async () => {
      const phone = nextPhone();
      await runScript({ phone, password: PASSWORD });
      const { secret, cookie } = await firstSignIn(phone, PASSWORD);
      const admin = await account(phone);
      const lastStep = Number((await owner<{ totp_last_step: string }>('select totp_last_step from app.admin_accounts where id = $1', [admin.id])).rows[0]!.totp_last_step);
      const newPassword = remember('lighthouse-amber-orchard-5150');
      const changed = await send('/v1/admin/account/password', { currentPassword: PASSWORD, newPassword, totpCode: hotp(secret, lastStep + 1) }, { ...adminCsrf, cookie });
      expect(changed.statusCode, changed.body).toBe(200);
      expect((await account(phone)).password_hash).toMatch(/^\$argon2id\$/);
      expect((await login(phone, PASSWORD)).json().error.code).toBe('CREDENTIALS_INVALID');
      expect((await login(phone, newPassword)).json().status).toBe('totp_required');
    });

    it('accepts any characters (quotes typed twice in SQL, non-ASCII) and uses all 128 characters', async () => {
      const phone = nextPhone();
      const unusual = remember("Çay'ı demle — ünïcode ✓ 2026");
      await runScript({ phone, password: unusual });
      expect((await login(phone, unusual)).json().status).toBe('totp_setup_required');

      // bcrypt alone would ignore everything after 72 bytes; the SHA-256 step makes the whole password count.
      const longPhone = nextPhone();
      const long = remember(`${'q'.repeat(100)}-tail-A`);
      await runScript({ phone: longPhone, password: long });
      expect((await login(longPhone, remember(`${'q'.repeat(100)}-tail-B`))).json().error.code).toBe('CREDENTIALS_INVALID');
      expect((await login(longPhone, long)).json().status).toBe('totp_setup_required');
    });
  });

  describe('existing admin', () => {
    it('updates role, status, name and password; ends sessions and sign-ins in progress; closes setup tokens; keeps the authenticator', async () => {
      const phone = nextPhone();
      const secret = generateTotpSecret();
      const created = await owner<{ id: string }>(
        "insert into app.admin_accounts (phone, name, role, status, totp_secret_enc, totp_confirmed_at) values ($1, 'Old Name', 'moderator', 'active', $2, now()) returning id",
        [phone, encryptSecret(TOTP_KEY, secret)],
      );
      const adminId = created.rows[0]!.id;
      // A password set the D-34 way, a sign-in in progress with it, a live session, then an open setup token.
      const oldPassword = remember('previous-password-for-d35');
      const setupToken = await issuePasswordSetup(ctx.ownerUrl, phone);
      expect((await send('/v1/admin/auth/password/setup', { phone, setupToken, password: oldPassword })).statusCode).toBe(200);
      const pending = (await login(phone, oldPassword)).json().pendingToken as string;
      await owner("insert into app.admin_sessions (admin_id, token_hash, expires_at) values ($1, repeat('d', 64), now() + interval '1 hour')", [adminId]);
      await owner("insert into app.admin_sessions (admin_id, token_hash, expires_at) values ($1, repeat('e', 64), now() + interval '1 hour')", [adminId]);
      await owner("update app.admin_password_setup set used_at = null, expires_at = now() + interval '1 hour', token_hash = encode(extensions.digest('open-token-xxxxxxxxxxxxxxxxxxxxx', 'sha256'), 'hex') where admin_id = $1", [adminId]);
      await owner("update app.admin_accounts set status = 'disabled' where id = $1", [adminId]);
      const before = await account(phone);

      const result = await runScript({ phone, name: 'Academy Admin', password: PASSWORD });
      expect(result.rows.at(-1)).toMatchObject({ phone, name: 'Academy Admin', role: 'super_admin', status: 'active', has_password: true, authenticator_set_up: true });
      const after = await account(phone);
      expect(after.id).toBe(adminId);
      expect((await owner('select count(*)::int as n from app.admin_accounts where phone = $1', [phone])).rows[0]).toEqual({ n: 1 });
      expect(after.totp_secret_enc).toBe(before.totp_secret_enc);
      expect(after.password_hash).toMatch(/^\$2a\$12\$/);
      expect(await liveSessions(adminId)).toBe(0);
      const token = (await owner<{ used_at: Date | null }>('select used_at from app.admin_password_setup where admin_id = $1', [adminId])).rows[0]!;
      expect(token.used_at).not.toBeNull();
      expect((await send('/v1/admin/auth/password/setup', { phone, setupToken: 'open-token-xxxxxxxxxxxxxxxxxxxxx', password: remember('token-would-set-this-1') })).json().error.code).toBe(
        'PASSWORD_SETUP_INVALID',
      );
      expect((await send('/v1/admin/auth/totp/verify', { pendingToken: pending, code: hotp(secret, currentStep(Date.now())) })).json().error.code).toBe('SESSION_INVALID');
      const audit = await owner<{ metadata: Record<string, unknown> }>("select metadata from app.audit_log where action = 'admin.password_set' and target_id = $1 order by id desc limit 1", [adminId]);
      expect(audit.rows[0]!.metadata).toMatchObject({ source: 'owner_sql', created: false, previousRole: 'moderator', previousStatus: 'disabled', sessionsEnded: 2, setupTokensClosed: 1 });

      // Old password refused; new one, then the existing authenticator (mandatory) -> Super Admin session.
      await clearLimits(phone);
      expect((await login(phone, oldPassword)).json().error.code).toBe('CREDENTIALS_INVALID');
      const step1 = await login(phone, PASSWORD);
      expect(step1.json().status).toBe('totp_required');
      expect(step1.headers['set-cookie']).toBeUndefined();
      expect((await send('/v1/admin/auth/totp/verify', { pendingToken: step1.json().pendingToken, code: '000000' })).json().error.code).toBe('TOTP_INVALID');
      const step2 = await send('/v1/admin/auth/totp/verify', { pendingToken: step1.json().pendingToken, code: hotp(secret, currentStep(Date.now()) + 1) });
      expect(step2.statusCode, step2.body).toBe(200);
      expect(step2.json().admin).toMatchObject({ name: 'Academy Admin', role: 'super_admin' });
      expect((await account(phone)).password_hash).toMatch(/^\$argon2id\$/);
    });

    it('running the script again ends the sessions it finds, including a live dashboard session', async () => {
      const phone = nextPhone();
      await runScript({ phone, password: PASSWORD });
      const { cookie } = await firstSignIn(phone, PASSWORD);
      expect((await app.inject({ method: 'GET', url: '/v1/admin/session', headers: { ...adminCsrf, cookie } })).statusCode).toBe(200);
      const again = remember('second-owner-password-77');
      await runScript({ phone, password: again });
      expect((await app.inject({ method: 'GET', url: '/v1/admin/session', headers: { ...adminCsrf, cookie } })).statusCode).toBe(401);
      expect((await login(phone, PASSWORD)).json().error.code).toBe('CREDENTIALS_INVALID');
      expect((await login(phone, again)).json().status).toBe('totp_required');
    });
  });

  describe('password rules at the first sign-in', () => {
    it('refuses a common password at the first sign-in like a wrong one, and keeps it from being upgraded or used', async () => {
      const phone = nextPhone();
      await runScript({ phone, password: remember('Password1234') });
      const stored = (await account(phone)).password_hash;
      const response = await login(phone, 'Password1234');
      // Refused exactly like a wrong password, so the refusal never confirms a guessed password.
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('CREDENTIALS_INVALID');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect((await account(phone)).password_hash).toBe(stored);
      expect((await owner("select details from audit.security_events where event = 'admin_password_upgrade_refused' and phone = $1", [phone])).rows[0]).toEqual({
        details: { reason: 'too_common' },
      });
      // The owner sets an allowed password; it works.
      await runScript({ phone, password: PASSWORD });
      await clearLimits(phone);
      expect((await login(phone, PASSWORD)).json().status).toBe('totp_setup_required');
    });

    it('keeps the D-34 behaviour for passwords set with a setup token (Argon2id from the start)', async () => {
      const phone = nextPhone();
      await owner("insert into app.admin_accounts (phone, name, role) values ($1, 'Token Admin', 'moderator')", [phone]);
      const token = await issuePasswordSetup(ctx.ownerUrl, phone);
      expect((await send('/v1/admin/auth/password/setup', { phone, setupToken: token, password: PASSWORD })).statusCode).toBe(200);
      const stored = (await account(phone)).password_hash;
      expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect((await login(phone, PASSWORD)).json().status).toBe('totp_setup_required');
      expect((await account(phone)).password_hash).toBe(stored);
      expect((await owner("select 1 from audit.security_events where phone = $1 and event = 'admin_password_upgraded'", [phone])).rowCount).toBe(0);
    });
  });

  it('never writes a password to the audit or security history, the short-lived state or a response', async () => {
    const history = JSON.stringify([
      (await owner('select * from app.audit_log')).rows,
      (await owner('select * from audit.security_events')).rows,
      (await owner('select * from app.admin_password_setup')).rows,
    ]);
    const stateValues = await allShortLivedState(ctx);
    for (const password of PASSWORDS) {
      expect(history.includes(password), password).toBe(false);
      expect(stateValues.includes(password), password).toBe(false);
      expect(responses.some((body) => body.includes(password)), password).toBe(false);
    }
  });
});
