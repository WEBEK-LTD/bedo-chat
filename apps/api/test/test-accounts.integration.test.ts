import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, createTestAdmin } from './admin-helpers.js';
import { clearCooldown, type IntegrationEnv, jobCount, query, setupIntegrationEnv, startApp } from './integration-env.js';
import { nextIp, nextPhone } from './messaging-helpers.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

/**
 * D-59: test accounts. Off by default; a Super Admin sets one fixed code and ranges of numbers; every number in a
 * range then signs in with the code (its own account each), without WhatsApp, also in academy-list mode. Never a
 * number on the academy list or an existing student's account; the store review account keeps its own number and
 * code; test numbers have their own per-address allowance; turning off or removing a range ends their sessions.
 */
describe.runIf(enabled)('test accounts (D-59, real Postgres)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  let superAdmin: Awaited<ReturnType<typeof adminClient>>;
  const FIRST = '+61400100000';
  const LAST = '+61400100099';
  const CODE = '135790';
  const REVIEW = '+61400100050';
  const REVIEW_CODE = '864200';
  const ip = '198.51.100.77';

  async function request(phone: string, from = nextIp()) {
    await clearCooldown(ctx, phone);
    await query(ctx.ownerUrl, 'delete from app.rate_events where bucket like $1', [`%${phone}%`]);
    const response = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone }, remoteAddress: from });
    await ctx.settle();
    return response;
  }
  const verify = (phone: string, code: string) => app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code }, remoteAddress: nextIp() });
  const signIn = async (phone: string, code = CODE) => {
    expect((await request(phone)).statusCode).toBe(200);
    return verify(phone, code);
  };
  const liveSessions = async (phone: string) =>
    (await query<{ n: number }>(ctx.ownerUrl, 'select count(*)::int as n from app.sessions s join app.users u on u.id = s.user_id where u.phone = $1 and s.revoked_at is null', [phone])).rows[0]!.n;

  beforeAll(async () => {
    ctx = await setupIntegrationEnv({}, { signupMode: 'academy_list' });
    app = await startApp(ctx.env);
    superAdmin = await adminClient(app, await createTestAdmin(ctx, app, 'super_admin'));
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  it('is off by default and a Super Admin setting; the code is stored encrypted', async () => {
    expect((await signIn('+61400100001')).statusCode).toBe(400);
    const moderator = await adminClient(app, await createTestAdmin(ctx, app, 'moderator'));
    expect((await moderator.get('/v1/admin/settings/test-accounts')).status).toBe(403);
    expect((await moderator.post('/v1/admin/settings/test-accounts/ranges', { firstPhone: FIRST, lastPhone: LAST })).status).toBe(403);
    expect((await superAdmin.get('/v1/admin/settings/test-accounts')).body).toEqual({ enabled: false, code: null, ranges: [], updatedBy: null, updatedAt: null });
    expect((await superAdmin.put('/v1/admin/settings/test-accounts', { enabled: true, code: '1234' })).status).toBe(400);
    const saved = await superAdmin.put('/v1/admin/settings/test-accounts', { enabled: true, code: CODE });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, code: CODE, ranges: [] });
    const stored = await query<{ code_enc: string }>(ctx.ownerUrl, 'select code_enc from app.test_account_settings');
    expect(stored.rows[0]!.code_enc).not.toContain(CODE);
  });

  it('checks ranges: same length, in order, at most 1000 numbers, no overlap', async () => {
    const add = (firstPhone: string, lastPhone: string) => superAdmin.post('/v1/admin/settings/test-accounts/ranges', { firstPhone, lastPhone });
    expect((await add('+61400100099', '+61400100000')).status).toBe(400);
    expect((await add('+61400100000', '+614001000990')).status).toBe(400);
    expect((await add('+61400100000', '+61400101000')).status).toBe(400);
    const added = await add('+61 400 100 000', LAST);
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(added.body.ranges).toEqual([expect.objectContaining({ firstPhone: FIRST, lastPhone: LAST, size: 100, accounts: 0, addedBy: 'super_admin tester' })]);
    expect((await add('+61400100090', '+61400100120')).body).toMatchObject({ error: { code: 'CONFLICT' } });
    const log = await query(ctx.ownerUrl, `select metadata from app.audit_log where action like 'settings.test_accounts%'`);
    expect(JSON.stringify(log.rows)).not.toContain(CODE);
  });

  it('signs in every number of the range with the code, each its own account, without WhatsApp', async () => {
    const one = await signIn('+61400100001');
    expect(one.statusCode, one.body).toBe(200);
    const two = await signIn('+61400100099');
    expect(two.statusCode, two.body).toBe(200);
    expect(one.json().user.id).not.toBe(two.json().user.id);
    expect(await jobCount(ctx.waabek, '+61400100001')).toBe(0);
    // Again later: still a test account.
    expect((await signIn('+61400100001')).statusCode).toBe(200);
    const requested = await query(ctx.ownerUrl, `select details from audit.security_events where phone = $1 and event = 'otp_requested' order by id desc limit 1`, ['+61400100001']);
    expect(requested.rows[0]).toEqual({ details: { purpose: 'sign_in', testAccount: true } });
    expect((await superAdmin.get('/v1/admin/settings/test-accounts')).body.ranges[0]).toMatchObject({ accounts: 2 });
    // Outside the range: nothing changes.
    expect((await signIn('+61400100100')).statusCode).toBe(400);
  });

  it('keeps the limits: wrong codes lock the challenge', async () => {
    await request('+61400100002');
    for (let attempt = 1; attempt <= 5; attempt += 1) expect((await verify('+61400100002', '000000')).statusCode).toBe(400);
    expect((await verify('+61400100002', CODE)).json()).toMatchObject({ error: { code: 'OTP_LOCKED' } });
  });

  it('never applies to a number on the academy list or an existing student in the range', async () => {
    const listed = '+61400100010';
    await query(ctx.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [listed]);
    expect((await request(listed)).statusCode).toBe(200);
    expect(await jobCount(ctx.waabek, listed)).toBe(1);
    expect((await verify(listed, CODE)).statusCode).toBe(400);
    // A student account (not a test account) whose number is in the range.
    const student = '+61400100011';
    await query(ctx.ownerUrl, 'insert into app.users (phone) values ($1)', [student]);
    expect((await request(student)).statusCode).toBe(200);
    expect(await jobCount(ctx.waabek, student)).toBe(1);
    expect((await verify(student, CODE)).statusCode).toBe(400);
  });

  it('leaves the store review account exactly as it is, even when its number is in a range', async () => {
    expect((await superAdmin.put('/v1/admin/settings/review-account', { enabled: true, phone: REVIEW, code: REVIEW_CODE })).status).toBe(200);
    expect((await signIn(REVIEW, CODE)).statusCode).toBe(400);
    const review = await signIn(REVIEW, REVIEW_CODE);
    expect(review.statusCode, review.body).toBe(200);
    const requested = await query(ctx.ownerUrl, `select details from audit.security_events where phone = $1 and event = 'otp_requested' order by id desc limit 1`, [REVIEW]);
    expect(requested.rows[0]).toEqual({ details: { purpose: 'sign_in', reviewAccount: true } });
    expect((await query(ctx.ownerUrl, 'select count(*)::int as n from app.test_accounts t join app.users u on u.id = t.user_id where u.phone = $1', [REVIEW])).rows[0]).toEqual({ n: 0 });
  });

  it('uses its own per-address allowance: testing from one address never blocks real students there', async () => {
    // Real students' allowance at this address is nearly used up …
    const student = nextPhone();
    await query(ctx.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [student]);
    await query(ctx.ownerUrl, `insert into app.rate_events (bucket, at) select 'otp-ip:' || $1, now() from generate_series(1, 19)`, [ip]);
    // … many test numbers sign in from it …
    for (let index = 20; index < 45; index += 1) {
      expect((await request(`+614001000${index}`, ip)).statusCode).toBe(200);
    }
    // … and a real student there still gets a code.
    expect((await request(student, ip)).statusCode).toBe(200);
    expect(await jobCount(ctx.waabek, student)).toBe(1);
  });

  it('turned off, or a range removed: the code stops working and the test accounts are signed out', async () => {
    expect((await signIn('+61400100003')).statusCode).toBe(200);
    expect(await liveSessions('+61400100003')).toBeGreaterThan(0);
    const off = await superAdmin.put('/v1/admin/settings/test-accounts', { enabled: false, code: CODE });
    expect(off.body).toMatchObject({ enabled: false, code: CODE });
    expect(await liveSessions('+61400100003')).toBe(0);
    expect(await liveSessions(REVIEW)).toBeGreaterThan(0);
    expect((await signIn('+61400100003')).statusCode).toBe(400);
    // On again; then the range removed.
    await superAdmin.put('/v1/admin/settings/test-accounts', { enabled: true, code: CODE });
    expect((await signIn('+61400100003')).statusCode).toBe(200);
    const range = (await superAdmin.get('/v1/admin/settings/test-accounts')).body.ranges[0];
    const removed = await superAdmin.del(`/v1/admin/settings/test-accounts/ranges/${range.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.ranges).toEqual([]);
    expect(await liveSessions('+61400100003')).toBe(0);
    expect((await signIn('+61400100003')).statusCode).toBe(400);
  });
});
