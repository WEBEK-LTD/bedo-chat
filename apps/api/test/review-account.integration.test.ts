import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, createTestAdmin } from './admin-helpers.js';
import { clearCooldown, type IntegrationEnv, jobCount, query, setupIntegrationEnv, startApp } from './integration-env.js';
import { nextIp, nextPhone } from './messaging-helpers.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

/**
 * D-56: the store review account. Off by default; a Super Admin sets one number and a fixed 6-digit code and turns it
 * on; that number then signs in to the student app with the code and no WhatsApp message (also in academy-list mode),
 * with the usual limits and locks; every other number is unchanged; turning it off ends its sessions.
 */
describe.runIf(enabled)('store review account (D-56, real Postgres)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  const REVIEW = '+61400000123';
  const CODE = '246810';

  async function request(phone: string) {
    await clearCooldown(ctx, phone);
    // The hourly limit of codes per number applies to the review number too; the tests ask for more than five.
    await query(ctx.ownerUrl, 'delete from app.rate_events where bucket like $1', [`%${phone}%`]);
    const response = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone }, remoteAddress: nextIp() });
    expect(response.statusCode, response.body).toBe(200);
    await ctx.settle();
    return response;
  }
  const verify = (phone: string, code: string) => app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code }, remoteAddress: nextIp() });

  beforeAll(async () => {
    // Academy-list mode: the review number is not on the list and still signs in.
    ctx = await setupIntegrationEnv({}, { signupMode: 'academy_list' });
    app = await startApp(ctx.env);
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  it('is off by default: the number gets nothing and the fixed code does not work', async () => {
    await request(REVIEW);
    expect(await jobCount(ctx.waabek, REVIEW)).toBe(0);
    expect((await verify(REVIEW, CODE)).statusCode).toBe(400);
  });

  it('is a Super Admin setting, and the code is stored encrypted', async () => {
    const superAdmin = await adminClient(app, await createTestAdmin(ctx, app, 'super_admin'));
    const moderator = await adminClient(app, await createTestAdmin(ctx, app, 'moderator'));
    expect((await moderator.get('/v1/admin/settings/review-account')).status).toBe(403);
    expect((await moderator.put('/v1/admin/settings/review-account', { enabled: true, phone: REVIEW, code: CODE })).status).toBe(403);
    expect((await superAdmin.get('/v1/admin/settings/review-account')).body).toEqual({ enabled: false, phone: null, code: null, updatedBy: null, updatedAt: null });
    expect((await superAdmin.put('/v1/admin/settings/review-account', { enabled: true, phone: REVIEW, code: '12345' })).status).toBe(400);
    expect((await superAdmin.put('/v1/admin/settings/review-account', { enabled: true, phone: 'not a phone', code: CODE })).status).toBe(400);
    const saved = await superAdmin.put('/v1/admin/settings/review-account', { enabled: true, phone: '+61 400 000 123', code: CODE });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, phone: REVIEW, code: CODE, updatedBy: 'super_admin tester' });
    const stored = await query<{ code_enc: string }>(ctx.ownerUrl, 'select code_enc from app.review_account_settings');
    expect(stored.rows[0]!.code_enc).not.toContain(CODE);
    const log = await query<{ metadata: Record<string, unknown> }>(ctx.ownerUrl, `select metadata from app.audit_log where action = 'settings.review_account'`);
    expect(log.rows).toHaveLength(1);
    expect(JSON.stringify(log.rows[0]!.metadata)).not.toContain(CODE);
  });

  it('signs the number in with the fixed code, without WhatsApp, as often as needed', async () => {
    for (let round = 0; round < 2; round += 1) {
      await request(REVIEW);
      expect(await jobCount(ctx.waabek, REVIEW)).toBe(0);
      const signedIn = await verify(REVIEW, CODE);
      expect(signedIn.statusCode, signedIn.body).toBe(200);
      expect(signedIn.json()).toMatchObject({ accessToken: expect.any(String), user: { phone: REVIEW } });
    }
    const requested = await query(ctx.ownerUrl, `select details from audit.security_events where phone = $1 and event = 'otp_requested' order by id desc limit 1`, [REVIEW]);
    expect(requested.rows[0]).toEqual({ details: { purpose: 'sign_in', reviewAccount: true } });
  });

  it('keeps the limits: wrong codes lock the challenge like any other', async () => {
    await request(REVIEW);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await verify(REVIEW, '000000')).statusCode).toBe(400);
    }
    const locked = await verify(REVIEW, CODE);
    expect(locked.json()).toMatchObject({ error: { code: 'OTP_LOCKED' } });
  });

  it('changes nothing for any other number', async () => {
    const other = nextPhone();
    await query(ctx.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [other]);
    await request(other);
    expect(await jobCount(ctx.waabek, other)).toBe(1);
    expect((await verify(other, CODE)).statusCode).toBe(400);
  });

  it('turned off: the fixed code stops working and the account is signed out everywhere', async () => {
    await request(REVIEW);
    expect((await verify(REVIEW, CODE)).statusCode).toBe(200);
    const live = async () =>
      (await query<{ n: number }>(ctx.ownerUrl, 'select count(*)::int as n from app.sessions s join app.users u on u.id = s.user_id where u.phone = $1 and s.revoked_at is null', [REVIEW])).rows[0]!.n;
    expect(await live()).toBeGreaterThan(0);
    const superAdmin = await adminClient(app, await createTestAdmin(ctx, app, 'super_admin'));
    const off = await superAdmin.put('/v1/admin/settings/review-account', { enabled: false, phone: REVIEW, code: CODE });
    expect(off.body).toMatchObject({ enabled: false, phone: REVIEW, code: CODE });
    expect(await live()).toBe(0);
    await request(REVIEW);
    expect((await verify(REVIEW, CODE)).statusCode).toBe(400);
  });
});
