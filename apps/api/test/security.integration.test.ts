import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ADMIN_SESSION_COOKIE, REFRESH_COOKIE } from '@bedo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashOtp } from '../src/common/crypto.js';
import { currentStep, encryptSecret, generateTotpSecret, hotp } from '../src/admin/totp.js';
import {
  ADMIN_ORIGIN,
  adminCsrf,
  clearCooldown,
  cookieValue,
  type IntegrationEnv,
  jobCount,
  latestCode,
  query,
  setupIntegrationEnv,
  startApp,
  TOTP_KEY,
  WEB_ORIGIN,
  webCsrf,
} from './integration-env.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.REDIS_URL);
let counter = 0;
const nextPhone = () => `+2012${String(Date.now() % 1e4).padStart(4, '0')}${String(++counter).padStart(4, '0')}`;
let ipCounter = 0;
const nextIp = () => `10.80.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`;

const tally = (codes: Array<string | undefined>) =>
  codes.reduce<Record<string, number>>((all, code) => ({ ...all, [code ?? 'ok']: (all[code ?? 'ok'] ?? 0) + 1 }), {});

/**
 * Regression tests for the independent security review of Phase 2: attempt limits under parallel
 * requests, refresh-token reuse after several rotations, identical behaviour for numbers on and off the
 * academy list, origin separation between the two apps, push endpoint rules and phone-change codes.
 */
describe.runIf(enabled)('Phase 2 security hardening (real Postgres + Redis, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;

  const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers, remoteAddress: nextIp() });
  const authed = (token: string) => ({ authorization: `Bearer ${token}` });
  const addToList = (phone: string) =>
    query(ctx.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [phone]);

  async function signIn(phone: string) {
    await clearCooldown(ctx.redis, ctx.prefix, phone);
    await post('/v1/auth/otp/request', { phone });
    const verified = await post('/v1/auth/otp/verify', { phone, code: await latestCode(ctx.otpQueue, phone) });
    return { body: verified.json(), refresh: cookieValue(verified.headers['set-cookie'], REFRESH_COOKIE) };
  }

  const refresh = (token: string, origin = WEB_ORIGIN) =>
    app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: { ...webCsrf, origin, cookie: `${REFRESH_COOKIE}=${token}` } });

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    app = await startApp(ctx.env);
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  it('allows at most 5 password guesses per sign-in, even with 30 parallel requests (P-09)', async () => {
    const phone = nextPhone();
    await addToList(phone);
    const account = await signIn(phone);
    await app.inject({ method: 'PUT', url: '/v1/me/two-step', headers: authed(account.body.accessToken), payload: { newPassword: 'correct horse 1' } });

    await clearCooldown(ctx.redis, ctx.prefix, phone);
    await post('/v1/auth/otp/request', { phone });
    const step = await post('/v1/auth/otp/verify', { phone, code: await latestCode(ctx.otpQueue, phone) });
    const token = step.json().twoStepToken as string;
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) => post('/v1/auth/two-step/verify', { twoStepToken: token, password: `wrong ${index}` })),
    );
    const counts = tally(results.map((result) => result.json().error?.code));
    expect(counts.TWO_STEP_INVALID ?? 0).toBeLessThanOrEqual(5);
    expect((counts.TWO_STEP_INVALID ?? 0) + (counts.SESSION_INVALID ?? 0)).toBe(30);
    // The attempt has ended: even the right password now needs a new code.
    const late = await post('/v1/auth/two-step/verify', { twoStepToken: token, password: 'correct horse 1' });
    expect(late.json().error.code).toBe('SESSION_INVALID');
  });

  it('lets only one of two parallel correct passwords complete the sign-in', async () => {
    const phone = nextPhone();
    await addToList(phone);
    const account = await signIn(phone);
    await app.inject({ method: 'PUT', url: '/v1/me/two-step', headers: authed(account.body.accessToken), payload: { newPassword: 'correct horse 2' } });
    await clearCooldown(ctx.redis, ctx.prefix, phone);
    await post('/v1/auth/otp/request', { phone });
    const step = await post('/v1/auth/otp/verify', { phone, code: await latestCode(ctx.otpQueue, phone) });
    const token = step.json().twoStepToken as string;
    const results = await Promise.all([0, 1, 2].map(() => post('/v1/auth/two-step/verify', { twoStepToken: token, password: 'correct horse 2' })));
    expect(results.filter((result) => result.statusCode === 200)).toHaveLength(1);
  });

  it('limits in-session password checks to 5 per hour under parallel requests', async () => {
    const phone = nextPhone();
    await addToList(phone);
    const account = await signIn(phone);
    await app.inject({ method: 'PUT', url: '/v1/me/two-step', headers: authed(account.body.accessToken), payload: { newPassword: 'correct horse 3' } });
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        app.inject({ method: 'POST', url: '/v1/me/two-step/disable', headers: authed(account.body.accessToken), payload: { currentPassword: `wrong ${index}` } }),
      ),
    );
    const counts = tally(results.map((result) => result.json().error?.code));
    expect(counts.TWO_STEP_INVALID ?? 0).toBeLessThanOrEqual(5);
    expect(counts.RATE_LIMITED ?? 0).toBeGreaterThanOrEqual(25);
  });

  it('allows at most 5 authenticator guesses per admin sign-in under parallel requests (P-13)', async () => {
    const phone = nextPhone();
    const secret = generateTotpSecret();
    await query(ctx.ownerUrl, "insert into app.admin_accounts (phone, name, role, totp_secret_enc) values ($1, 'Admin', 'super_admin', $2)", [
      phone,
      encryptSecret(TOTP_KEY, secret),
    ]);
    await post('/v1/admin/auth/otp/request', { phone }, adminCsrf);
    const pending = await post('/v1/admin/auth/otp/verify', { phone, code: await latestCode(ctx.otpQueue, phone) }, adminCsrf);
    const token = pending.json().pendingToken as string;
    const good = hotp(secret, currentStep(Date.now()));
    const wrong = good === '000000' ? '111111' : '000000';
    const results = await Promise.all(Array.from({ length: 30 }, () => post('/v1/admin/auth/totp/verify', { pendingToken: token, code: wrong }, adminCsrf)));
    const counts = tally(results.map((result) => result.json().error?.code));
    expect(counts.TOTP_INVALID ?? 0).toBeLessThanOrEqual(5);
    const late = await post('/v1/admin/auth/totp/verify', { pendingToken: token, code: good }, adminCsrf);
    expect(late.json().error.code).toBe('SESSION_INVALID');
  });

  it('ends the session when any earlier refresh token is reused, even after several rotations (P-02)', async () => {
    const phone = nextPhone();
    await addToList(phone);
    const victim = await signIn(phone);
    const t0 = victim.refresh!;
    // A thief exchanges the stolen token twice.
    const t1 = cookieValue((await refresh(t0)).headers['set-cookie'], REFRESH_COOKIE)!;
    const t2 = cookieValue((await refresh(t1)).headers['set-cookie'], REFRESH_COOKIE)!;
    // Outside the 20-second grace window, the victim's browser presents its old token.
    await query(ctx.ownerUrl, "update app.sessions set last_used_at = now() - interval '1 minute' where user_id = $1", [victim.body.user.id]);
    const victimAttempt = await refresh(t0);
    expect(victimAttempt.json().error.code).toBe('SESSION_INVALID');
    // The whole session is ended, so the thief's newest token stops working too.
    expect((await refresh(t2)).json().error.code).toBe('SESSION_INVALID');
    const events = await query(ctx.ownerUrl, "select 1 from audit.security_events where event = 'refresh_reuse_detected' and subject_id = $1", [
      victim.body.user.id,
    ]);
    expect(events.rowCount).toBe(1);
  });

  it('answers verification attempts identically for numbers on and off the academy list (D-06)', async () => {
    const listed = nextPhone();
    const unlisted = nextPhone();
    await addToList(listed);
    const sequences: Record<string, string[]> = {};
    for (const phone of [listed, unlisted]) {
      const ip = nextIp();
      await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone }, remoteAddress: ip });
      const wrong = async () => (await post('/v1/auth/otp/verify', { phone, code: '000000' })).json().error?.code as string;
      const sequence = [await wrong()];
      // The code's 5-minute lifetime passes.
      await query(ctx.ownerUrl, "update app.otp_challenges set expires_at = now() - interval '1 second' where phone = $1", [phone]);
      for (let index = 0; index < 5; index += 1) sequence.push(await wrong());
      // A new code, then five wrong attempts: locked in both cases.
      await clearCooldown(ctx.redis, ctx.prefix, phone);
      await post('/v1/auth/otp/request', { phone });
      for (let index = 0; index < 6; index += 1) sequence.push(await wrong());
      sequences[phone === listed ? 'listed' : 'unlisted'] = sequence;
    }
    expect(sequences.unlisted).toEqual(sequences.listed);
    expect(sequences.listed?.slice(-2)).toEqual(['OTP_LOCKED', 'OTP_LOCKED']);
    expect(await latestCode(ctx.otpQueue, unlisted)).toBeNull();
  });

  it('never signs in or moves a phone number to a number off the list, even if its never-sent code is guessed', async () => {
    // Stand-in for a lucky guess: set the never-sent code of the challenge to a known value.
    const forceCode = (phone: string, code: string) =>
      query(ctx.ownerUrl, 'select id from app.otp_challenges where phone = $1 order by created_at desc limit 1', [phone]).then((rows) =>
        query(ctx.ownerUrl, 'update app.otp_challenges set code_hash = $2 where id = $1', [
          rows.rows[0]!.id,
          hashOtp(ctx.env.OTP_HMAC_SECRET, rows.rows[0]!.id as string, code),
        ]),
      );
    const unlisted = nextPhone();
    await post('/v1/auth/otp/request', { phone: unlisted });
    await forceCode(unlisted, '123456');
    const guessed = await post('/v1/auth/otp/verify', { phone: unlisted, code: '123456' });
    expect(guessed.json().error.code).toBe('OTP_INVALID');
    expect((await query(ctx.ownerUrl, 'select 1 from app.users where phone = $1', [unlisted])).rowCount).toBe(0);

    const member = nextPhone();
    await addToList(member);
    const account = await signIn(member);
    const target = nextPhone();
    await app.inject({ method: 'POST', url: '/v1/me/phone/request', headers: authed(account.body.accessToken), payload: { newPhone: target } });
    await forceCode(target, '654321');
    const moved = await app.inject({
      method: 'POST',
      url: '/v1/me/phone/verify',
      headers: authed(account.body.accessToken),
      payload: { newPhone: target, code: '654321' },
    });
    expect(moved.json().error.code).toBe('OTP_INVALID');
    expect((await query<{ phone: string }>(ctx.ownerUrl, 'select phone from app.users where id = $1', [account.body.user.id])).rows[0]?.phone).toBe(member);
  });

  it('keeps the two apps apart: admin routes refuse the web origin, user cookie routes refuse the admin origin', async () => {
    const fromWeb = { origin: WEB_ORIGIN, 'x-bedo-csrf': '1' };
    expect((await post('/v1/admin/auth/otp/request', { phone: nextPhone() }, fromWeb)).json().error.code).toBe('CSRF_REJECTED');
    const read = await app.inject({ method: 'GET', url: '/v1/admin/phone-list', headers: { ...fromWeb, cookie: `${ADMIN_SESSION_COOKIE}=anything` } });
    expect(read.json().error.code).toBe('CSRF_REJECTED');

    const phone = nextPhone();
    await addToList(phone);
    const account = await signIn(phone);
    expect((await refresh(account.refresh!, ADMIN_ORIGIN)).json().error.code).toBe('CSRF_REJECTED');
    expect((await refresh(account.refresh!, WEB_ORIGIN)).statusCode).toBe(200);
  });

  it('accepts only browser push services as push endpoints and never takes over another user\'s live subscription', async () => {
    const [a, b] = [nextPhone(), nextPhone()];
    await addToList(a);
    await addToList(b);
    const userA = await signIn(a);
    const userB = await signIn(b);
    const subscribe = (token: string, endpoint: string) =>
      app.inject({ method: 'PUT', url: '/v1/me/push-subscription', headers: authed(token), payload: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });

    for (const endpoint of ['https://10.0.0.5:8443/hook', 'https://internal.example/push', 'https://fcm.googleapis.com.evil.example/x', 'https://fcm.googleapis.com:444/x']) {
      expect((await subscribe(userA.body.accessToken, endpoint)).statusCode, endpoint).toBe(400);
    }
    const endpoint = 'https://fcm.googleapis.com/fcm/send/shared-browser';
    expect((await subscribe(userA.body.accessToken, endpoint)).statusCode).toBe(200);
    expect((await subscribe(userB.body.accessToken, endpoint)).json().error.code).toBe('CONFLICT');
    const rows = await query<{ user_id: string }>(ctx.ownerUrl, 'select user_id from app.push_subscriptions where endpoint = $1', [endpoint]);
    expect(rows.rows).toEqual([{ user_id: userA.body.user.id }]);

    // Once A signs out on that browser, B may use it.
    await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { ...webCsrf, cookie: `${REFRESH_COOKIE}=${userA.refresh}` } });
    expect((await subscribe(userB.body.accessToken, endpoint)).statusCode).toBe(200);
  });

  it('accepts a phone-change code only from the account that asked for it', async () => {
    const [a, b, target] = [nextPhone(), nextPhone(), nextPhone()];
    for (const phone of [a, b, target]) await addToList(phone);
    const userA = await signIn(a);
    const userB = await signIn(b);
    await app.inject({ method: 'POST', url: '/v1/me/phone/request', headers: authed(userA.body.accessToken), payload: { newPhone: target } });
    const code = await latestCode(ctx.otpQueue, target);
    const stolen = await app.inject({ method: 'POST', url: '/v1/me/phone/verify', headers: authed(userB.body.accessToken), payload: { newPhone: target, code } });
    expect(stolen.json().error.code).toBe('OTP_INVALID');
    const own = await app.inject({ method: 'POST', url: '/v1/me/phone/verify', headers: authed(userA.body.accessToken), payload: { newPhone: target, code } });
    expect(own.json().phone).toBe(target);

    // D-24: the old number is no longer a login number; the new one is. History keeps both.
    expect((await query(ctx.ownerUrl, 'select 1 from app.academy_phone_list where phone = $1', [a])).rowCount).toBe(0);
    expect((await query(ctx.ownerUrl, 'select 1 from app.academy_phone_list where phone = $1', [target])).rowCount).toBe(1);
    const removal = await query<{ actor_type: string; actor_id: string; metadata: { reason: string; wasListed: boolean } }>(
      ctx.ownerUrl,
      "select actor_type, actor_id, metadata from app.audit_log where action = 'phone_list.remove' and target_id = $1",
      [a],
    );
    expect(removal.rows).toEqual([
      { actor_type: 'user', actor_id: userA.body.user.id, metadata: expect.objectContaining({ reason: 'phone_changed', wasListed: true }) },
    ]);
    const history = await query<{ old_value: string; new_value: string }>(
      ctx.ownerUrl,
      "select old_value, new_value from audit.identity_history where user_id = $1 and field = 'phone' and old_value is not null",
      [userA.body.user.id],
    );
    expect(history.rows).toEqual([{ old_value: a, new_value: target }]);

    await clearCooldown(ctx.redis, ctx.prefix, a);
    const queuedBefore = await jobCount(ctx.otpQueue, a);
    expect((await post('/v1/auth/otp/request', { phone: a })).statusCode).toBe(200);
    expect(await jobCount(ctx.otpQueue, a)).toBe(queuedBefore);
    // The account signs in with its new number.
    const next = await signIn(target);
    expect(next.body.user.id).toBe(userA.body.user.id);
  });

  it('counts student and admin code requests against one 20-per-hour budget per IP', async () => {
    const ip = '203.0.113.77';
    const request = (url: string, phone: string, headers: Record<string, string> = {}) =>
      app.inject({ method: 'POST', url, payload: { phone }, headers, remoteAddress: ip });
    for (let index = 0; index < 15; index += 1) {
      expect((await request('/v1/auth/otp/request', nextPhone())).statusCode).toBe(200);
    }
    for (let index = 0; index < 5; index += 1) {
      expect((await request('/v1/admin/auth/otp/request', nextPhone(), adminCsrf)).statusCode).toBe(200);
    }
    expect((await request('/v1/auth/otp/request', nextPhone())).json().error.code).toBe('RATE_LIMITED');
    expect((await request('/v1/admin/auth/otp/request', nextPhone(), adminCsrf)).json().error.code).toBe('RATE_LIMITED');
  });
});
