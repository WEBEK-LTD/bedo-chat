import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { REFRESH_COOKIE } from '@bedo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizePhone } from '../src/common/phone.js';
import {
  clearCooldown,
  cookieValue,
  type IntegrationEnv,
  jobCount,
  latestCode,
  query,
  setupIntegrationEnv,
  startApp,
  webCsrf,
} from './integration-env.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.REDIS_URL);
let counter = 0;
let ipCounter = 0;
/** A distinct client address per request, so tests are not throttled by the per-IP limit unless they mean to be. */
const nextIp = () => `10.50.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;
/** Valid Egyptian mobile numbers, unique per call. */
const nextPhone = () => `+2010${String(Date.now() % 1e4).padStart(4, '0')}${String(++counter).padStart(4, '0')}`;

describe.runIf(enabled)('Phase 2 sign-in, sessions and account (real Postgres + Redis, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    app = await startApp(ctx.env);
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  async function addToList(phone: string) {
    await query(ctx.ownerUrl, "insert into app.academy_phone_list (phone, added_by) values ($1, '00000000-0000-0000-0000-000000000000')", [phone]);
  }

  const post = (url: string, payload: unknown, headers: Record<string, string> = {}, remoteAddress?: string) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers, ...(remoteAddress ? { remoteAddress } : {}) });

  async function requestCode(phone: string, remoteAddress: string = nextIp()) {
    return post('/v1/auth/otp/request', { phone }, {}, remoteAddress);
  }

  /** Full sign-in for a listed number. Returns access token and refresh cookie. */
  async function signIn(phone: string, deviceName = 'Test browser') {
    await clearCooldown(ctx.redis, ctx.prefix, phone);
    const requested = await requestCode(phone);
    expect(requested.statusCode).toBe(200);
    const code = await latestCode(ctx.otpQueue, phone);
    expect(code).toMatch(/^\d{6}$/);
    const verified = await post('/v1/auth/otp/verify', { phone, code, deviceName });
    expect(verified.statusCode, verified.body).toBe(200);
    const body = verified.json();
    return {
      body,
      accessToken: body.accessToken as string,
      refresh: cookieValue(verified.headers['set-cookie'], REFRESH_COOKIE),
      setCookie: verified.headers['set-cookie'],
    };
  }

  const authed = (token: string) => ({ authorization: `Bearer ${token}` });

  it('normalises phone numbers to E.164', () => {
    expect(normalizePhone('+20 101 234 5678')).toBe('+201012345678');
    expect(normalizePhone('0020 1012345678')).toBe('+201012345678');
    expect(normalizePhone('01012345678')).toBeNull();
    expect(normalizePhone('+999')).toBeNull();
  });

  describe('academy-only access (D-06)', () => {
    it('gives listed and unlisted numbers the identical answer, and sends a code only to the listed one', async () => {
      const listed = nextPhone();
      const unlisted = nextPhone();
      await addToList(listed);
      const a = await requestCode(listed);
      const b = await requestCode(unlisted);
      expect(a.statusCode).toBe(200);
      expect(b.statusCode).toBe(200);
      expect(a.body).toBe(b.body);
      expect(a.json()).toEqual({ status: 'accepted', resendAfterSeconds: 60, expiresInSeconds: 300 });
      expect(await jobCount(ctx.otpQueue, listed)).toBe(1);
      expect(await jobCount(ctx.otpQueue, unlisted)).toBe(0);
      const events = await query<{ event: string }>(ctx.ownerUrl, 'select event from audit.security_events where phone = $1', [unlisted]);
      expect(events.rows.map((row) => row.event)).toContain('otp_requested_not_eligible');
    });

    it('rejects text that is not a phone number', async () => {
      const response = await requestCode('not a number');
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_FAILED');
    });

    it('gives the same wrong-code and lock answers for listed and unlisted numbers', async () => {
      const listed = nextPhone();
      const unlisted = nextPhone();
      await addToList(listed);
      await requestCode(listed);
      await requestCode(unlisted);
      const codes = (phone: string) => post('/v1/auth/otp/verify', { phone, code: '000000' }).then((r) => r.json().error.code);
      const listedRun: string[] = [];
      const unlistedRun: string[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        listedRun.push(await codes(listed));
        unlistedRun.push(await codes(unlisted));
      }
      expect(listedRun).toEqual(['OTP_INVALID', 'OTP_INVALID', 'OTP_INVALID', 'OTP_INVALID', 'OTP_LOCKED', 'OTP_LOCKED']);
      expect(unlistedRun).toEqual(listedRun);
    });
  });

  describe('OTP limits (blueprint values)', () => {
    it('sends 6-digit codes that expire after 5 minutes', async () => {
      const phone = nextPhone();
      await addToList(phone);
      await requestCode(phone);
      expect(await latestCode(ctx.otpQueue, phone)).toMatch(/^\d{6}$/);
      const row = await query<{ seconds: number }>(
        ctx.ownerUrl,
        'select extract(epoch from (expires_at - created_at))::int as seconds from app.otp_challenges where phone = $1',
        [phone],
      );
      expect(row.rows[0]?.seconds).toBe(300);
    });

    it('enforces the 60-second resend cooldown for every number', async () => {
      for (const listed of [true, false]) {
        const phone = nextPhone();
        if (listed) await addToList(phone);
        expect((await requestCode(phone)).statusCode).toBe(200);
        const again = await requestCode(phone);
        expect(again.statusCode).toBe(429);
        expect(again.json().error.code).toBe('RATE_LIMITED');
        expect(again.json().error.retryAfterSeconds).toBeGreaterThan(55);
        expect(again.json().error.retryAfterSeconds).toBeLessThanOrEqual(60);
        expect(again.headers['retry-after']).toBeDefined();
      }
    });

    it('allows 5 codes per number per hour', async () => {
      const phone = nextPhone();
      await addToList(phone);
      for (let index = 0; index < 5; index += 1) {
        await clearCooldown(ctx.redis, ctx.prefix, phone);
        expect((await requestCode(phone, `10.1.0.${index + 1}`)).statusCode).toBe(200);
      }
      await clearCooldown(ctx.redis, ctx.prefix, phone);
      const sixth = await requestCode(phone, '10.1.0.99');
      expect(sixth.statusCode).toBe(429);
      expect(sixth.json().error.retryAfterSeconds).toBeGreaterThan(3500);
      expect(await jobCount(ctx.otpQueue, phone)).toBe(5);
    });

    it('allows 20 codes per IP per hour', async () => {
      const ip = '10.2.0.1';
      for (let index = 0; index < 20; index += 1) {
        expect((await requestCode(nextPhone(), ip)).statusCode).toBe(200);
      }
      const blocked = await requestCode(nextPhone(), ip);
      expect(blocked.statusCode).toBe(429);
      expect((await requestCode(nextPhone(), '10.2.0.2')).statusCode).toBe(200);
    });

    it('rejects an expired code and never accepts a code twice', async () => {
      const phone = nextPhone();
      await addToList(phone);
      await requestCode(phone);
      const code = await latestCode(ctx.otpQueue, phone);
      await query(ctx.ownerUrl, "update app.otp_challenges set expires_at = now() - interval '1 second' where phone = $1", [phone]);
      expect((await post('/v1/auth/otp/verify', { phone, code })).json().error.code).toBe('OTP_INVALID');

      await clearCooldown(ctx.redis, ctx.prefix, phone);
      await requestCode(phone);
      const fresh = await latestCode(ctx.otpQueue, phone);
      expect((await post('/v1/auth/otp/verify', { phone, code: fresh })).statusCode).toBe(200);
      expect((await post('/v1/auth/otp/verify', { phone, code: fresh })).json().error.code).toBe('OTP_INVALID');
    });

    it('stores only a hash of the code', async () => {
      const phone = nextPhone();
      await addToList(phone);
      await requestCode(phone);
      const code = (await latestCode(ctx.otpQueue, phone))!;
      const row = await query<{ code_hash: string }>(ctx.ownerUrl, 'select code_hash from app.otp_challenges where phone = $1', [phone]);
      expect(row.rows[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.rows[0]?.code_hash).not.toContain(code);
    });
  });

  describe('first sign-in and sessions', () => {
    it('creates the account on first sign-in, with history, and asks for a name (P-03)', async () => {
      const phone = nextPhone();
      await addToList(phone);
      const { body, refresh, setCookie } = await signIn(phone);
      expect(body.status).toBe('authenticated');
      expect(body.accessTokenExpiresIn).toBe(600);
      expect(body.user).toMatchObject({ phone, name: null, profileComplete: false, status: 'active', twoStepEnabled: false });
      expect(refresh).toBeTruthy();
      const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\/v1\/auth/);
      const events = await query<{ event: string }>(ctx.ownerUrl, 'select event from audit.account_events where user_id = $1', [body.user.id]);
      expect(events.rows.map((row) => row.event)).toEqual(['created']);
      const identity = await query(ctx.ownerUrl, "select * from audit.identity_history where user_id = $1 and field = 'phone'", [body.user.id]);
      expect(identity.rowCount).toBe(1);
      const stored = await query<{ refresh_hash: string }>(ctx.ownerUrl, 'select refresh_hash from app.sessions where user_id = $1', [body.user.id]);
      expect(stored.rows[0]?.refresh_hash).not.toBe(refresh);
    });

    it('requires a valid access token for the account API', async () => {
      expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/v1/me', headers: authed('not-a-token') })).statusCode).toBe(401);
    });

    it('rotates the refresh token and ends the session when a used token is replayed later', async () => {
      const phone = nextPhone();
      await addToList(phone);
      const first = await signIn(phone);
      const refresh = (cookie: string | null, headers = webCsrf) =>
        app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { ...headers, cookie: `${REFRESH_COOKIE}=${cookie}` } });

      const rotated = await refresh(first.refresh);
      expect(rotated.statusCode).toBe(200);
      const second = cookieValue(rotated.headers['set-cookie'], REFRESH_COOKIE);
      expect(second).toBeTruthy();
      expect(second).not.toBe(first.refresh);

      // Two tabs refreshing at the same moment: the old token within the grace window gets an access token, no new cookie.
      const concurrent = await refresh(first.refresh);
      expect(concurrent.statusCode).toBe(200);
      expect(cookieValue(concurrent.headers['set-cookie'], REFRESH_COOKIE)).toBeNull();

      // Later, the same old token means someone has a copy: the session ends for everyone.
      await query(ctx.ownerUrl, "update app.sessions set last_used_at = now() - interval '1 minute' where user_id = $1", [first.body.user.id]);
      const replay = await refresh(first.refresh);
      expect(replay.statusCode).toBe(401);
      expect(replay.json().error.code).toBe('SESSION_INVALID');
      expect((await refresh(second)).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/v1/me', headers: authed(first.accessToken) })).statusCode).toBe(401);
      const audit = await query(ctx.ownerUrl, "select 1 from audit.security_events where subject_id = $1 and event = 'refresh_reuse_detected'", [first.body.user.id]);
      expect(audit.rowCount).toBe(1);
    });

    it('refuses refresh and logout without the CSRF header or from another origin', async () => {
      const phone = nextPhone();
      await addToList(phone);
      const { refresh } = await signIn(phone);
      const cookie = `${REFRESH_COOKIE}=${refresh}`;
      for (const headers of [
        { cookie },
        { cookie, origin: 'https://chat.bedo.test' },
        { cookie, origin: 'https://evil.example', 'x-bedo-csrf': '1' },
      ]) {
        for (const url of ['/v1/auth/refresh', '/v1/auth/logout']) {
          const response = await app.inject({ method: 'POST', url, headers });
          expect(response.statusCode, `${url} ${JSON.stringify(headers)}`).toBe(403);
          expect(response.json().error.code).toBe('CSRF_REJECTED');
        }
      }
    });

    it('ends the session immediately on logout', async () => {
      const phone = nextPhone();
      await addToList(phone);
      const { accessToken, refresh } = await signIn(phone);
      expect((await app.inject({ method: 'GET', url: '/v1/me', headers: authed(accessToken) })).statusCode).toBe(200);
      const logout = await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { ...webCsrf, cookie: `${REFRESH_COOKIE}=${refresh}` } });
      expect(logout.statusCode).toBe(200);
      expect(String(logout.headers['set-cookie'])).toMatch(/bedo_refresh=;/);
      expect((await app.inject({ method: 'GET', url: '/v1/me', headers: authed(accessToken) })).statusCode).toBe(401);
    });

    it('lists devices, ends one, and ends all others; raises login alerts on other sessions (D-13)', async () => {
      const phone = nextPhone();
      await addToList(phone);
      const laptop = await signIn(phone, 'Laptop');
      await ctx.pushQueue.obliterate({ force: true });
      const phoneSession = await signIn(phone, 'Phone');

      // Login alert: in-app notice for the other session, push to the other session, audit record.
      const notices = await app.inject({ method: 'GET', url: '/v1/me/security-notices', headers: authed(laptop.accessToken) });
      // The alert names the device from its browser signature only, never from the name the client sent
      // ("Phone"); this test client sends no recognisable browser signature.
      expect(notices.json().notices[0]).toMatchObject({ kind: 'new_login', read: false, details: { deviceName: null, platform: 'web' } });
      expect(JSON.stringify(notices.json())).not.toContain('Phone');
      const ownView = await app.inject({ method: 'GET', url: '/v1/me/security-notices', headers: authed(phoneSession.accessToken) });
      expect(ownView.json().notices.filter((notice: { kind: string }) => notice.kind === 'new_login')).toHaveLength(1);
      const pushJobs = await ctx.pushQueue.getJobs(['waiting']);
      expect(pushJobs).toHaveLength(1);
      expect(pushJobs[0]?.data).toMatchObject({ userId: laptop.body.user.id, notification: { tag: 'new-login' } });
      expect(pushJobs[0]?.data.excludeSessionId).not.toBeNull();
      const logins = await query(ctx.ownerUrl, "select 1 from audit.security_events where subject_id = $1 and event = 'login_succeeded'", [laptop.body.user.id]);
      expect(logins.rowCount).toBe(2);

      const read = await app.inject({ method: 'POST', url: '/v1/me/security-notices/read', headers: authed(laptop.accessToken), payload: {} });
      expect(read.json().unreadCount).toBe(0);

      const list = await app.inject({ method: 'GET', url: '/v1/me/sessions', headers: authed(laptop.accessToken) });
      const sessions = list.json().sessions as Array<{ id: string; deviceName: string; current: boolean }>;
      expect(sessions.map((s) => s.deviceName).sort()).toEqual(['Laptop', 'Phone']);
      const other = sessions.find((s) => !s.current)!;
      const ended = await app.inject({ method: 'DELETE', url: `/v1/me/sessions/${other.id}`, headers: authed(laptop.accessToken) });
      expect(ended.statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/v1/me', headers: authed(phoneSession.accessToken) })).statusCode).toBe(401);

      const third = await signIn(phone, 'Tablet');
      const endOthers = await app.inject({ method: 'POST', url: '/v1/me/sessions/terminate-others', headers: authed(third.accessToken) });
      expect(endOthers.statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/v1/me', headers: authed(laptop.accessToken) })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/v1/me', headers: authed(third.accessToken) })).statusCode).toBe(200);
    });

    it('cannot end another user’s session', async () => {
      const a = nextPhone();
      const b = nextPhone();
      await addToList(a);
      await addToList(b);
      const alice = await signIn(a);
      const bob = await signIn(b);
      const bobSessions = await app.inject({ method: 'GET', url: '/v1/me/sessions', headers: authed(bob.accessToken) });
      const target = bobSessions.json().sessions[0].id;
      const attempt = await app.inject({ method: 'DELETE', url: `/v1/me/sessions/${target}`, headers: authed(alice.accessToken) });
      expect(attempt.statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/v1/me', headers: authed(bob.accessToken) })).statusCode).toBe(200);
    });

    it('blocks suspended and banned accounts at sign-in and on existing sessions', async () => {
      const phone = nextPhone();
      await addToList(phone);
      const { accessToken, body } = await signIn(phone);
      await query(ctx.ownerUrl, "update app.users set status = 'suspended' where id = $1", [body.user.id]);
      const me = await app.inject({ method: 'GET', url: '/v1/me', headers: authed(accessToken) });
      expect(me.statusCode).toBe(403);
      expect(me.json().error.code).toBe('ACCOUNT_BLOCKED');
      await clearCooldown(ctx.redis, ctx.prefix, phone);
      await requestCode(phone);
      const code = await latestCode(ctx.otpQueue, phone);
      const verify = await post('/v1/auth/otp/verify', { phone, code });
      expect(verify.json().error.code).toBe('ACCOUNT_BLOCKED');
    });
  });

  describe('2-Step Verification (Argon2id, P-09)', () => {
    it('enables, requires the password at sign-in, limits wrong passwords and disables', async () => {
      const phone = nextPhone();
      await addToList(phone);
      const { accessToken, body } = await signIn(phone);
      const put = (payload: object) => app.inject({ method: 'PUT', url: '/v1/me/two-step', headers: authed(accessToken), payload });

      expect((await put({ newPassword: 'short' })).statusCode).toBe(400);
      expect((await put({ newPassword: 'correct horse 1', hint: 'Correct Horse 1 is it' })).statusCode).toBe(400);
      const enabled = await put({ newPassword: 'correct horse 1', hint: 'favourite animal' });
      expect(enabled.json()).toEqual({ enabled: true, hint: 'favourite animal' });
      const stored = await query<{ password_hash: string }>(ctx.ownerUrl, 'select password_hash from app.two_step where user_id = $1', [body.user.id]);
      expect(stored.rows[0]?.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);

      // Sign-in now needs the password.
      await clearCooldown(ctx.redis, ctx.prefix, phone);
      await requestCode(phone);
      const step = await post('/v1/auth/otp/verify', { phone, code: await latestCode(ctx.otpQueue, phone) });
      expect(step.json()).toMatchObject({ status: 'two_step_required', hint: 'favourite animal' });
      expect(step.headers['set-cookie']).toBeUndefined();
      const token = step.json().twoStepToken;
      const tries: string[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        tries.push((await post('/v1/auth/two-step/verify', { twoStepToken: token, password: 'wrong password' })).json().error.code);
      }
      expect(tries).toEqual(['TWO_STEP_INVALID', 'TWO_STEP_INVALID', 'TWO_STEP_INVALID', 'TWO_STEP_INVALID', 'SESSION_INVALID']);
      expect((await post('/v1/auth/two-step/verify', { twoStepToken: token, password: 'correct horse 1' })).json().error.code).toBe(
        'SESSION_INVALID',
      );

      await clearCooldown(ctx.redis, ctx.prefix, phone);
      await requestCode(phone);
      const again = await post('/v1/auth/otp/verify', { phone, code: await latestCode(ctx.otpQueue, phone) });
      const ok = await post('/v1/auth/two-step/verify', { twoStepToken: again.json().twoStepToken, password: 'correct horse 1' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().user.twoStepEnabled).toBe(true);

      // Changing needs the current password; disabling too.
      expect((await put({ newPassword: 'another secret 2' })).json().error.code).toBe('TWO_STEP_INVALID');
      expect((await put({ currentPassword: 'correct horse 1', newPassword: 'another secret 2' })).statusCode).toBe(200);
      const disable = (password: string) =>
        app.inject({ method: 'POST', url: '/v1/me/two-step/disable', headers: authed(accessToken), payload: { currentPassword: password } });
      expect((await disable('another secret 2')).json()).toEqual({ enabled: false, hint: null });
      const events = await query<{ event: string }>(ctx.ownerUrl, "select event from audit.security_events where subject_id = $1 and event like 'two_step%' order by id", [body.user.id]);
      expect(events.rows.map((row) => row.event)).toEqual(
        expect.arrayContaining(['two_step_enabled', 'two_step_failed', 'two_step_attempts_exhausted', 'two_step_changed', 'two_step_disabled']),
      );
    });

    it('limits password guesses inside a signed-in session', async () => {
      const phone = nextPhone();
      await addToList(phone);
      const { accessToken } = await signIn(phone);
      await app.inject({ method: 'PUT', url: '/v1/me/two-step', headers: authed(accessToken), payload: { newPassword: 'right password 9' } });
      const disable = (password: string) =>
        app.inject({ method: 'POST', url: '/v1/me/two-step/disable', headers: authed(accessToken), payload: { currentPassword: password } });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await disable('wrong')).json().error.code).toBe('TWO_STEP_INVALID');
      }
      const limited = await disable('right password 9');
      expect(limited.statusCode).toBe(429);
    });
  });

  describe('profile, privacy and identity history (D-17)', () => {
    it('records every identity change and enforces the profile rules', async () => {
      const phone = nextPhone();
      await addToList(phone);
      const { accessToken, body } = await signIn(phone);
      const patch = (payload: object) => app.inject({ method: 'PATCH', url: '/v1/me', headers: authed(accessToken), payload });
      const named = await patch({ name: 'Mona Adel', username: 'mona_adel', bio: 'Second-year student' });
      expect(named.json()).toMatchObject({ name: 'Mona Adel', username: 'mona_adel', bio: 'Second-year student', profileComplete: true });
      await patch({ name: 'Mona A.', bio: '' });
      await patch({ username: null });

      const history = await query<{ field: string; old_value: string | null; new_value: string | null; actor_type: string }>(
        ctx.ownerUrl,
        "select field, old_value, new_value, actor_type from audit.identity_history where user_id = $1 and field <> 'phone' order by id",
        [body.user.id],
      );
      expect(history.rows).toEqual([
        { field: 'name', old_value: null, new_value: 'Mona Adel', actor_type: 'user' },
        { field: 'username', old_value: null, new_value: 'mona_adel', actor_type: 'user' },
        { field: 'bio', old_value: null, new_value: 'Second-year student', actor_type: 'user' },
        { field: 'name', old_value: 'Mona Adel', new_value: 'Mona A.', actor_type: 'user' },
        { field: 'bio', old_value: 'Second-year student', new_value: null, actor_type: 'user' },
        { field: 'username', old_value: 'mona_adel', new_value: null, actor_type: 'user' },
      ]);

      expect((await patch({ username: '1bad' })).statusCode).toBe(400);
      expect((await patch({ name: 'x'.repeat(65) })).statusCode).toBe(400);
      expect((await patch({ bio: 'x'.repeat(141) })).statusCode).toBe(400);

      const other = nextPhone();
      await addToList(other);
      const second = await signIn(other);
      await patch({ username: 'Taken_Name' });
      const clash = await app.inject({ method: 'PATCH', url: '/v1/me', headers: authed(second.accessToken), payload: { username: 'taken_name' } });
      expect(clash.statusCode).toBe(409);
      expect(clash.json().error.code).toBe('USERNAME_TAKEN');
    });

    it('stores privacy settings with Everyone/Nobody options and records changes', async () => {
      const phone = nextPhone();
      await addToList(phone);
      const { accessToken, body } = await signIn(phone);
      const initial = await app.inject({ method: 'GET', url: '/v1/me/privacy', headers: authed(accessToken) });
      expect(initial.json()).toEqual({
        phoneVisibility: 'nobody',
        lastSeenVisibility: 'everyone',
        photoVisibility: 'everyone',
        messagesFrom: 'everyone',
        callsFrom: 'everyone',
      });
      const updated = await app.inject({ method: 'PATCH', url: '/v1/me/privacy', headers: authed(accessToken), payload: { lastSeenVisibility: 'nobody' } });
      expect(updated.json().lastSeenVisibility).toBe('nobody');
      expect((await app.inject({ method: 'PATCH', url: '/v1/me/privacy', headers: authed(accessToken), payload: { callsFrom: 'contacts' } })).statusCode).toBe(400);
      const audit = await query(ctx.ownerUrl, "select 1 from audit.security_events where subject_id = $1 and event = 'privacy_changed'", [body.user.id]);
      expect(audit.rowCount).toBe(1);
    });

    it('changes the phone number only to a listed, unused number, with identity history', async () => {
      const phone = nextPhone();
      const target = nextPhone();
      const unlisted = nextPhone();
      await addToList(phone);
      await addToList(target);
      const { accessToken, body } = await signIn(phone);
      const request = (newPhone: string) => app.inject({ method: 'POST', url: '/v1/me/phone/request', headers: authed(accessToken), payload: { newPhone } });
      const a = await request(unlisted);
      const b = await request(target);
      expect(a.body).toBe(b.body);
      expect(await jobCount(ctx.otpQueue, unlisted)).toBe(0);
      expect(await jobCount(ctx.otpQueue, target)).toBe(1);
      const verify = await app.inject({
        method: 'POST',
        url: '/v1/me/phone/verify',
        headers: authed(accessToken),
        payload: { newPhone: target, code: await latestCode(ctx.otpQueue, target) },
      });
      expect(verify.statusCode, verify.body).toBe(200);
      expect(verify.json().phone).toBe(target);
      const history = await query<{ old_value: string; new_value: string }>(
        ctx.ownerUrl,
        "select old_value, new_value from audit.identity_history where user_id = $1 and field = 'phone' and old_value is not null",
        [body.user.id],
      );
      expect(history.rows).toEqual([{ old_value: phone, new_value: target }]);
    });

    it('returns 503 for profile pictures when storage is not configured', async () => {
      const phone = nextPhone();
      await addToList(phone);
      const { accessToken } = await signIn(phone);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/me/photo/upload',
        headers: authed(accessToken),
        payload: { contentType: 'image/png', size: 1000 },
      });
      expect(response.statusCode).toBe(503);
    });
  });

  describe('push subscription and deletion request', () => {
    it('stores one push subscription per session and removes it on logout', async () => {
      const phone = nextPhone();
      await addToList(phone);
      const { accessToken, refresh, body } = await signIn(phone);
      const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'key', auth: 'auth' } };
      expect((await app.inject({ method: 'PUT', url: '/v1/me/push-subscription', headers: authed(accessToken), payload: subscription })).statusCode).toBe(200);
      expect((await app.inject({ method: 'PUT', url: '/v1/me/push-subscription', headers: authed(accessToken), payload: subscription })).statusCode).toBe(200);
      const rows = await query(ctx.ownerUrl, 'select 1 from app.push_subscriptions where user_id = $1', [body.user.id]);
      expect(rows.rowCount).toBe(1);
      await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { ...webCsrf, cookie: `${REFRESH_COOKIE}=${refresh}` } });
      expect((await query(ctx.ownerUrl, 'select 1 from app.push_subscriptions where user_id = $1', [body.user.id])).rowCount).toBe(0);
      expect((await app.inject({ method: 'GET', url: '/v1/push/config' })).json()).toEqual({ vapidPublicKey: 'BPublicKeyForTests' });
    });

    it('puts the account into Deletion Requested, keeps it usable, and records it (D-14, P-10)', async () => {
      const phone = nextPhone();
      await addToList(phone);
      const { accessToken, body } = await signIn(phone);
      const requested = await app.inject({ method: 'POST', url: '/v1/me/deletion-request', headers: authed(accessToken) });
      expect(requested.json().status).toBe('deletion_requested');
      expect((await app.inject({ method: 'POST', url: '/v1/me/deletion-request', headers: authed(accessToken) })).statusCode).toBe(409);
      const me = await app.inject({ method: 'GET', url: '/v1/me', headers: authed(accessToken) });
      expect(me.json().status).toBe('deletion_requested');
      const events = await query<{ event: string }>(ctx.ownerUrl, 'select event from audit.account_events where user_id = $1 order by id', [body.user.id]);
      expect(events.rows.map((row) => row.event)).toEqual(['created', 'deletion_requested']);
    });
  });
});
