import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ADMIN_SESSION_COOKIE, REFRESH_COOKIE } from '@bedo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@bedo/db';
import { createAdmin as createAdminAccount } from '../src/admin/create-admin.js';
import { base32Decode, currentStep, encryptSecret, generateTotpSecret, hotp } from '../src/admin/totp.js';
import {
  adminCsrf,
  adminPasswordLogin,
  clearCooldown,
  cookieValue,
  jobCount,
  type IntegrationEnv,
  latestCode,
  query,
  setAdminPassword,
  setupIntegrationEnv,
  startApp,
  TOTP_KEY,
  webCsrf,
} from './integration-env.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
let counter = 0;
const nextPhone = () => `+2011${String(Date.now() % 1e4).padStart(4, '0')}${String(++counter).padStart(4, '0')}`;
let ipCounter = 0;
const nextIp = () => `10.60.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

interface TestAdmin {
  id: string;
  phone: string;
  secret: Buffer;
}

describe.runIf(enabled)('Phase 2 admin (real Postgres + Redis, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  let superAdmin: TestAdmin;
  let moderator: TestAdmin;
  let superCookie: string;
  let moderatorCookie: string;

  async function createAdmin(role: 'super_admin' | 'moderator'): Promise<TestAdmin> {
    const phone = nextPhone();
    const secret = generateTotpSecret();
    const row = await query<{ id: string }>(
      ctx.ownerUrl,
      'insert into app.admin_accounts (phone, name, role, totp_secret_enc) values ($1, $2, $3, $4) returning id',
      [phone, `${role} tester`, role, encryptSecret(TOTP_KEY, secret)],
    );
    await setAdminPassword(app, ctx.ownerUrl, phone);
    return { id: row.rows[0]!.id, phone, secret };
  }

  const post = (url: string, payload: unknown, headers: Record<string, string>) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers, remoteAddress: nextIp() });

  /** Phone + password, then authenticator code (D-34). Returns the admin session cookie. */
  async function adminSignIn(admin: TestAdmin, stepOffset = 0): Promise<string> {
    const pending = await adminPasswordLogin(app, admin.phone);
    expect(pending.statusCode, pending.body).toBe(200);
    const totp = hotp(admin.secret, currentStep(Date.now()) + stepOffset);
    const session = await post('/v1/admin/auth/totp/verify', { pendingToken: pending.json().pendingToken, code: totp }, adminCsrf);
    expect(session.statusCode, session.body).toBe(200);
    const cookie = cookieValue(session.headers['set-cookie'], ADMIN_SESSION_COOKIE);
    expect(cookie).toBeTruthy();
    return `${ADMIN_SESSION_COOKIE}=${cookie}`;
  }

  async function studentSignIn(phone: string) {
    await clearCooldown(ctx, phone);
    await post('/v1/auth/otp/request', { phone }, {});
    const verified = await post('/v1/auth/otp/verify', { phone, code: await latestCode(ctx.waabek, phone) }, {});
    expect(verified.statusCode, verified.body).toBe(200);
    return {
      id: verified.json().user.id as string,
      accessToken: verified.json().accessToken as string,
      refresh: cookieValue(verified.headers['set-cookie'], REFRESH_COOKIE)!,
    };
  }

  const asAdmin = (cookie: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({ method, url, headers: { ...adminCsrf, cookie }, ...(payload ? { payload } : {}) });

  const adminActions = async (adminId: string) =>
    (await query<{ action: string }>(ctx.ownerUrl, "select action from app.audit_log where actor_type = 'admin' and actor_id = $1 order by id", [adminId])).rows.map(
      (row) => row.action,
    );

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    app = await startApp(ctx.env);
    superAdmin = await createAdmin('super_admin');
    moderator = await createAdmin('moderator');
    superCookie = await adminSignIn(superAdmin);
    moderatorCookie = await adminSignIn(moderator);
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  describe('admin sign-in (D-19, P-13)', () => {
    it('sends no WhatsApp code for admin sign-in (D-34)', async () => {
      const admin = await createAdmin('moderator');
      expect((await adminPasswordLogin(app, admin.phone)).statusCode).toBe(200);
      expect(await latestCode(ctx.waabek, admin.phone)).toBeNull();
      expect((await post('/v1/admin/auth/otp/request', { phone: admin.phone }, adminCsrf)).statusCode).toBe(404);
      expect((await post('/v1/admin/auth/otp/verify', { phone: admin.phone, code: '123456' }, adminCsrf)).statusCode).toBe(404);
    });

    it('requires the authenticator code, rejects wrong and replayed codes, and confirms enrolment', async () => {
      const admin = await createAdmin('moderator');
      const pending = await adminPasswordLogin(app, admin.phone);
      const token = pending.json().pendingToken;
      expect((await post('/v1/admin/auth/totp/verify', { pendingToken: token, code: '000000' }, adminCsrf)).json().error.code).toBe('TOTP_INVALID');
      const good = hotp(admin.secret, currentStep(Date.now()));
      expect((await post('/v1/admin/auth/totp/verify', { pendingToken: token, code: good }, adminCsrf)).statusCode).toBe(200);
      const confirmed = await query<{ totp_confirmed_at: Date | null }>(ctx.ownerUrl, 'select totp_confirmed_at from app.admin_accounts where id = $1', [admin.id]);
      expect(confirmed.rows[0]?.totp_confirmed_at).not.toBeNull();

      // The same authenticator code can never be used for a second sign-in.
      const second = await adminPasswordLogin(app, admin.phone);
      expect((await post('/v1/admin/auth/totp/verify', { pendingToken: second.json().pendingToken, code: good }, adminCsrf)).json().error.code).toBe(
        'TOTP_INVALID',
      );
    });

    it('keeps admin and student credentials apart', async () => {
      const phone = nextPhone();
      await query(ctx.ownerUrl, "insert into app.academy_phone_list (phone, added_by) values ($1, $2)", [phone, superAdmin.id]);
      const student = await studentSignIn(phone);
      const withBearer = await app.inject({ method: 'GET', url: '/v1/admin/session', headers: { ...adminCsrf, authorization: `Bearer ${student.accessToken}` } });
      expect(withBearer.statusCode).toBe(401);
      const adminCookieOnStudentApi = await app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: superCookie } });
      expect(adminCookieOnStudentApi.statusCode).toBe(401);
    });

    it('requires the CSRF header and origin for every admin change', async () => {
      const response = await app.inject({ method: 'POST', url: '/v1/admin/phone-list', headers: { cookie: superCookie }, payload: { phone: nextPhone() } });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('CSRF_REJECTED');
      const wrongOrigin = await app.inject({
        method: 'POST',
        url: '/v1/admin/phone-list',
        headers: { cookie: superCookie, origin: 'https://evil.example', 'x-bedo-csrf': '1' },
        payload: { phone: nextPhone() },
      });
      expect(wrongOrigin.statusCode).toBe(403);
    });

    it('ends the admin session after 30 idle minutes and on sign-out', async () => {
      const admin = await createAdmin('moderator');
      const cookie = await adminSignIn(admin);
      expect((await asAdmin(cookie, 'GET', '/v1/admin/session')).statusCode).toBe(200);
      await query(ctx.ownerUrl, "update app.admin_sessions set last_active_at = now() - interval '31 minutes' where admin_id = $1", [admin.id]);
      expect((await asAdmin(cookie, 'GET', '/v1/admin/session')).statusCode).toBe(401);

      const fresh = await adminSignIn(admin, 1);
      expect((await asAdmin(fresh, 'POST', '/v1/admin/session/logout', {})).statusCode).toBe(200);
      expect((await asAdmin(fresh, 'GET', '/v1/admin/session')).statusCode).toBe(401);
    });
  });

  describe('roles (P-12)', () => {
    it('lets a moderator read but not change anything', async () => {
      expect((await asAdmin(moderatorCookie, 'GET', '/v1/admin/phone-list')).statusCode).toBe(200);
      expect((await asAdmin(moderatorCookie, 'GET', '/v1/admin/deletion-requests')).statusCode).toBe(200);
      for (const [url, payload] of [
        ['/v1/admin/phone-list', { phone: nextPhone() }],
        ['/v1/admin/phone-list/import', { csv: nextPhone() }],
        ['/v1/admin/users/two-step-reset', { phone: nextPhone(), reason: 'checked student ID in person' }],
        ['/v1/admin/deletion-requests/00000000-0000-0000-0000-000000000001/approve', {}],
        ['/v1/admin/deletion-requests/00000000-0000-0000-0000-000000000001/reject', {}],
      ] as const) {
        const response = await asAdmin(moderatorCookie, 'POST', url, payload);
        expect(response.statusCode, url).toBe(403);
      }
    });
  });

  describe('academy phone list (D-06, P-11)', () => {
    it('adds single numbers, reports duplicates, imports CSV and records each action', async () => {
      const phone = nextPhone();
      const added = await asAdmin(superCookie, 'POST', '/v1/admin/phone-list', { phone: phone.replace('+20', '+20 '), note: 'Group A' });
      expect(added.json()).toEqual({ phone, added: true });
      expect((await asAdmin(superCookie, 'POST', '/v1/admin/phone-list', { phone })).json()).toEqual({ phone, added: false });
      expect((await asAdmin(superCookie, 'POST', '/v1/admin/phone-list', { phone: '12345' })).statusCode).toBe(400);

      const fresh1 = nextPhone();
      const fresh2 = nextPhone();
      const csv = `phone,note\n${fresh1},Group B\n${fresh2}\n${phone},dup\nnot-a-number\n\n`;
      const imported = await asAdmin(superCookie, 'POST', '/v1/admin/phone-list/import', { csv });
      expect(imported.json()).toEqual({
        added: 2,
        duplicates: [phone],
        invalid: [{ line: 5, value: 'not-a-number', reason: 'not a valid international phone number' }],
      });

      const listed = await asAdmin(superCookie, 'GET', `/v1/admin/phone-list?search=${encodeURIComponent(fresh1)}`);
      expect(listed.json().items).toEqual([{ phone: fresh1, note: 'Group B', addedAt: expect.any(String), accountStatus: null }]);

      const actions = await adminActions(superAdmin.id);
      expect(actions).toEqual(expect.arrayContaining(['admin.signed_in', 'phone_list.add', 'phone_list.import', 'view.phone_list']));
    });

    it('lets a newly listed number sign in', async () => {
      const phone = nextPhone();
      await asAdmin(superCookie, 'POST', '/v1/admin/phone-list', { phone });
      const student = await studentSignIn(phone);
      expect(student.accessToken).toBeTruthy();
    });
  });

  describe('account deletion with admin approval (D-14)', () => {
    async function studentWithRequest() {
      const phone = nextPhone();
      const username = `leaving_${++counter}`;
      await asAdmin(superCookie, 'POST', '/v1/admin/phone-list', { phone });
      const student = await studentSignIn(phone);
      await app.inject({ method: 'PATCH', url: '/v1/me', headers: { authorization: `Bearer ${student.accessToken}` }, payload: { name: 'Leaving Student', username } });
      await app.inject({
        method: 'PUT',
        url: '/v1/me/push-subscription',
        headers: { authorization: `Bearer ${student.accessToken}` },
        payload: { endpoint: `https://fcm.googleapis.com/fcm/send/${student.id}`, keys: { p256dh: 'p', auth: 'a' } },
      });
      await app.inject({ method: 'POST', url: '/v1/me/deletion-request', headers: { authorization: `Bearer ${student.accessToken}` } });
      const list = await asAdmin(superCookie, 'GET', '/v1/admin/deletion-requests');
      const request = list.json().items.find((item: { user: { id: string } }) => item.user.id === student.id);
      expect(request).toBeDefined();
      return { phone, username, student, requestId: request.id as string };
    }

    it('shows the request with account activity and history, and audits the view', async () => {
      const { requestId, student } = await studentWithRequest();
      const detail = await asAdmin(moderatorCookie, 'GET', `/v1/admin/deletion-requests/${requestId}`);
      expect(detail.statusCode).toBe(200);
      const body = detail.json();
      expect(body.request).toMatchObject({ status: 'pending', user: { id: student.id, name: 'Leaving Student' } });
      expect(body.account.activeSessions).toHaveLength(1);
      expect(body.identityHistory.map((entry: { event: string }) => entry.event)).toEqual(
        expect.arrayContaining(['name changed', 'username changed', 'phone changed']),
      );
      expect(body.accountEvents.map((entry: { event: string }) => entry.event)).toEqual(['deletion_requested', 'created']);
      expect(body.securityEvents.map((entry: { event: string }) => entry.event)).toContain('login_succeeded');
      expect(await adminActions(moderator.id)).toContain('view.deletion_request');
    });

    it('on approval: deletes the account, keeps all history, ends sessions and tells the user', async () => {
      const { phone, username, student, requestId } = await studentWithRequest();
      ctx.push.clear();
      const auditBefore = await query<{ n: number }>(
        ctx.ownerUrl,
        "select (select count(*) from audit.identity_history where user_id = $1) + (select count(*) from audit.account_events where user_id = $1) + (select count(*) from audit.security_events where subject_id = $1) as n",
        [student.id],
      );

      const approved = await asAdmin(superCookie, 'POST', `/v1/admin/deletion-requests/${requestId}/approve`, { reason: 'Student left the academy' });
      expect(approved.statusCode, approved.body).toBe(200);
      expect(approved.json().request).toMatchObject({
        status: 'approved',
        decisionReason: 'Student left the academy',
        decidedBy: 'super_admin tester',
        // the identity the account had is still shown to admins, from the audit history
        user: { id: student.id, phone, name: 'Leaving Student', username },
      });

      const user = await query(ctx.ownerUrl, 'select status, phone, name, username, deleted_at from app.users where id = $1', [student.id]);
      expect(user.rows[0]).toMatchObject({ status: 'deleted', phone: null, name: null, username: null });
      expect(user.rows[0]?.deleted_at).not.toBeNull();

      const auditAfter = await query<{ n: number }>(
        ctx.ownerUrl,
        "select (select count(*) from audit.identity_history where user_id = $1) + (select count(*) from audit.account_events where user_id = $1) + (select count(*) from audit.security_events where subject_id = $1) as n",
        [student.id],
      );
      expect(Number(auditAfter.rows[0]!.n)).toBeGreaterThan(Number(auditBefore.rows[0]!.n));
      const snapshot = await query<{ details: { identity: Record<string, string> } }>(
        ctx.ownerUrl,
        "select details from audit.account_events where user_id = $1 and event = 'deletion_approved'",
        [student.id],
      );
      expect(snapshot.rows[0]?.details.identity).toMatchObject({ phone, name: 'Leaving Student', username });

      const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${student.accessToken}` } });
      expect(me.json().error.code).toBe('ACCOUNT_DELETED');
      const refresh = await app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { ...webCsrf, cookie: `${REFRESH_COOKIE}=${student.refresh}` } });
      expect(refresh.json().error.code).toBe('ACCOUNT_DELETED');

      // D-36: sent right after the response to the subscriptions the account had (removed in the same change).
      const push = await ctx.push.all();
      expect(push).toHaveLength(1);
      expect(push[0]?.endpoint).toBe(`https://fcm.googleapis.com/fcm/send/${student.id}`);
      expect((await query(ctx.ownerUrl, 'select 1 from app.push_subscriptions where user_id = $1', [student.id])).rowCount).toBe(0);

      expect((await asAdmin(superCookie, 'POST', `/v1/admin/deletion-requests/${requestId}/approve`, {})).statusCode).toBe(409);
      expect(await adminActions(superAdmin.id)).toContain('account.deletion_approved');

      // D-24: the number leaves the academy phone list, the removed entry is recorded, and the number
      // stays in identity history.
      expect((await query(ctx.ownerUrl, 'select 1 from app.academy_phone_list where phone = $1', [phone])).rowCount).toBe(0);
      const removal = await query<{ actor_type: string; actor_id: string; metadata: Record<string, unknown> }>(
        ctx.ownerUrl,
        "select actor_type, actor_id, metadata from app.audit_log where action = 'phone_list.remove' and target_id = $1",
        [phone],
      );
      expect(removal.rows).toEqual([
        {
          actor_type: 'admin',
          actor_id: superAdmin.id,
          metadata: {
            reason: 'account_deleted',
            userId: student.id,
            wasListed: true,
            entry: { note: null, addedBy: superAdmin.id, addedAt: expect.any(String) },
          },
        },
      ]);
      const phoneHistory = await query<{ old_value: string | null; new_value: string | null }>(
        ctx.ownerUrl,
        "select old_value, new_value from audit.identity_history where user_id = $1 and field = 'phone' order by id",
        [student.id],
      );
      expect(phoneHistory.rows).toEqual([
        { old_value: null, new_value: phone },
        { old_value: phone, new_value: null },
      ]);

      // The deleted number cannot sign in again or create a new account: same neutral answer, no code.
      await clearCooldown(ctx, phone);
      const queuedBefore = await jobCount(ctx.waabek, phone);
      const again = await post('/v1/auth/otp/request', { phone }, {});
      expect(again.statusCode).toBe(200);
      expect(await jobCount(ctx.waabek, phone)).toBe(queuedBefore);
      const guess = await post('/v1/auth/otp/verify', { phone, code: '123456' }, {});
      expect(guess.json().error.code).toBe('OTP_INVALID');
      expect((await query(ctx.ownerUrl, 'select 1 from app.users where phone = $1', [phone])).rowCount).toBe(0);
    });

    it('on rejection: returns the account to active and informs the user', async () => {
      const { student, requestId } = await studentWithRequest();
      const rejected = await asAdmin(superCookie, 'POST', `/v1/admin/deletion-requests/${requestId}/reject`, { reason: 'Exams in progress' });
      expect(rejected.json().request.status).toBe('rejected');
      const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${student.accessToken}` } });
      expect(me.json().status).toBe('active');
      const notices = await app.inject({ method: 'GET', url: '/v1/me/security-notices', headers: { authorization: `Bearer ${student.accessToken}` } });
      expect(notices.json().notices.map((notice: { kind: string }) => notice.kind)).toContain('deletion_rejected');
      const events = await query<{ event: string }>(ctx.ownerUrl, 'select event from audit.account_events where user_id = $1 order by id', [student.id]);
      expect(events.rows.map((row) => row.event)).toEqual(['created', 'deletion_requested', 'deletion_rejected']);
    });
  });

  describe('2-Step reset by admin (D-12)', () => {
    it('removes the password after an identity check, informs the user and records who did it', async () => {
      const phone = nextPhone();
      await asAdmin(superCookie, 'POST', '/v1/admin/phone-list', { phone });
      const student = await studentSignIn(phone);
      await app.inject({ method: 'PUT', url: '/v1/me/two-step', headers: { authorization: `Bearer ${student.accessToken}` }, payload: { newPassword: 'forgotten pass 1' } });

      const missingReason = await asAdmin(superCookie, 'POST', '/v1/admin/users/two-step-reset', { phone });
      expect(missingReason.statusCode).toBe(400);
      const reset = await asAdmin(superCookie, 'POST', '/v1/admin/users/two-step-reset', { phone, reason: 'Verified student card in person' });
      expect(reset.json()).toEqual({ reset: true });
      expect((await asAdmin(superCookie, 'POST', '/v1/admin/users/two-step-reset', { phone, reason: 'again please' })).statusCode).toBe(404);

      const status = await app.inject({ method: 'GET', url: '/v1/me/two-step', headers: { authorization: `Bearer ${student.accessToken}` } });
      expect(status.json().enabled).toBe(false);
      const events = await query<{ details: { adminId: string; reason: string } }>(
        ctx.ownerUrl,
        "select details from audit.security_events where subject_id = $1 and event = 'two_step_reset_by_admin'",
        [student.id],
      );
      expect(events.rows[0]?.details).toEqual({ adminId: superAdmin.id, reason: 'Verified student card in person' });
      expect(await adminActions(superAdmin.id)).toContain('user.two_step_reset');
    });
  });

  describe('admin-create command', () => {
    it('creates an admin whose authenticator secret works for sign-in, and records it', async () => {
      const { db } = createDb({ connectionString: ctx.ownerUrl, poolMax: 1 });
      try {
        const phone = nextPhone();
        const result = await createAdminAccount(db, TOTP_KEY, { phone: phone.replace('+20', '+20 '), name: ' Academy Admin ', role: 'super_admin' });
        if (!result.ok) {
          throw new Error(result.reason);
        }
        expect(result.setupLink).toMatch(/^otpauth:\/\/totp\/Bedo%20Chat%20Admin%3A%2B20.*secret=[A-Z2-7]+&issuer=Bedo\+Chat\+Admin/);
        const stored = await query<{ name: string; role: string; totp_secret_enc: string }>(ctx.ownerUrl, 'select name, role, totp_secret_enc from app.admin_accounts where id = $1', [result.id]);
        expect(stored.rows[0]).toMatchObject({ name: 'Academy Admin', role: 'super_admin' });
        expect(stored.rows[0]?.totp_secret_enc).not.toContain(result.secret);
        const audit = await query(ctx.ownerUrl, "select 1 from app.audit_log where action = 'admin.created_by_cli' and target_id = $1", [result.id]);
        expect(audit.rowCount).toBe(1);

        await setAdminPassword(app, ctx.ownerUrl, phone);
        const cookie = await adminSignIn({ id: result.id, phone, secret: base32Decode(result.secret) });
        expect((await asAdmin(cookie, 'GET', '/v1/admin/session')).json().admin).toEqual({ id: result.id, name: 'Academy Admin', role: 'super_admin' });

        expect(await createAdminAccount(db, TOTP_KEY, { phone, name: 'Again', role: 'moderator' })).toEqual({ ok: false, reason: 'phone_exists' });
        expect(await createAdminAccount(db, TOTP_KEY, { phone: '123', name: 'X', role: 'moderator' })).toEqual({ ok: false, reason: 'invalid_input' });
        expect(await createAdminAccount(db, TOTP_KEY, { phone: nextPhone(), name: 'X', role: 'owner' })).toEqual({ ok: false, reason: 'invalid_input' });
      } finally {
        await db.destroy();
      }
    });
  });

  it('records every admin action and view in the append-only audit log', async () => {
    const actions = await adminActions(superAdmin.id);
    expect(actions.length).toBeGreaterThan(10);
    await expect(query(ctx.runtimeUrl, "delete from app.audit_log where actor_type = 'admin'")).rejects.toThrow(/permission denied/);
  });
});
