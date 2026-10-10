import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminClient, createTestAdmin } from './admin-helpers.js';
import { clearCooldown, type IntegrationEnv, jobCount, latestCode, query, setupIntegrationEnv, startApp } from './integration-env.js';
import { client, createUser, nextIp, nextPhone } from './messaging-helpers.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

/**
 * D-47: anyone with a WhatsApp number can create an account by signing in (the default), or, when a Super Admin
 * chooses so in the Admin Dashboard, only numbers on the academy phone list (D-06). Never the number of an account
 * an admin deleted (D-14, D-24).
 */
describe.runIf(enabled)('who can create an account (D-47, real Postgres)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;

  async function requestCode(phone: string) {
    await clearCooldown(ctx, phone);
    const response = await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone }, remoteAddress: nextIp() });
    expect(response.statusCode).toBe(200);
    await ctx.settle();
  }

  beforeAll(async () => {
    ctx = await setupIntegrationEnv({}, { signupMode: 'open' });
    app = await startApp(ctx.env);
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  it('lets a number that is not on the academy list sign in and creates its account', async () => {
    const phone = nextPhone();
    expect((await query(ctx.ownerUrl, 'select count(*)::int as n from app.academy_phone_list where phone = $1', [phone])).rows[0]!.n).toBe(0);
    await requestCode(phone);
    const code = await latestCode(ctx.waabek, phone);
    expect(code).toMatch(/^\d{6}$/);
    const verified = await app.inject({ method: 'POST', url: '/v1/auth/otp/verify', payload: { phone, code }, remoteAddress: nextIp() });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json()).toMatchObject({ accessToken: expect.any(String), user: { phone } });
    const events = await query(ctx.ownerUrl, `select event from audit.security_events where phone = $1 and event like 'otp_requested%'`, [phone]);
    expect(events.rows).toEqual([{ event: 'otp_requested' }]);
  });

  it('lets an account move to a number that is not on the list', async () => {
    const user = await createUser(ctx, app, 'Mover');
    const newPhone = nextPhone();
    await clearCooldown(ctx, newPhone, 'otp');
    expect((await client(app, user).post('/v1/me/phone/request', { newPhone })).status).toBe(200);
    await ctx.settle();
    expect(await jobCount(ctx.waabek, newPhone)).toBe(1);
  });

  it('never lets the number of an account an admin deleted sign up again', async () => {
    const user = await createUser(ctx, app, 'Deleted Student');
    const superAdmin = await adminClient(app, await createTestAdmin(ctx, app, 'super_admin'));
    expect((await superAdmin.post(`/v1/admin/users/${user.id}/action`, { action: 'delete', reason: 'Asked to leave the academy' })).status).toBe(200);
    const before = await jobCount(ctx.waabek, user.phone);
    await requestCode(user.phone);
    expect(await jobCount(ctx.waabek, user.phone)).toBe(before);
    const last = await query(ctx.ownerUrl, `select event from audit.security_events where phone = $1 and event like 'otp_requested%' order by id desc limit 1`, [user.phone]);
    expect(last.rows).toEqual([{ event: 'otp_requested_not_eligible' }]);
  });

  it('is a Super Admin setting: academy list only, recorded, and back to open', async () => {
    const superAdmin = await adminClient(app, await createTestAdmin(ctx, app, 'super_admin'));
    const moderator = await adminClient(app, await createTestAdmin(ctx, app, 'moderator'));
    expect((await moderator.get('/v1/admin/settings/access')).body).toMatchObject({ signupMode: 'open', updatedBy: null });
    expect((await moderator.put('/v1/admin/settings/access', { signupMode: 'academy_list' })).status).toBe(403);
    expect((await superAdmin.put('/v1/admin/settings/access', { signupMode: 'everyone' })).status).toBe(400);
    const changed = await superAdmin.put('/v1/admin/settings/access', { signupMode: 'academy_list' });
    expect(changed.body).toMatchObject({ signupMode: 'academy_list', updatedBy: 'super_admin tester', updatedAt: expect.any(String) });
    const log = await query(ctx.ownerUrl, `select metadata from app.audit_log where action = 'settings.signup_mode'`);
    expect(log.rows).toEqual([{ metadata: { from: 'open', to: 'academy_list' } }]);

    // An unlisted number now gets no code, the same neutral answer; a listed one does.
    const unlisted = nextPhone();
    await requestCode(unlisted);
    expect(await jobCount(ctx.waabek, unlisted)).toBe(0);
    const listed = nextPhone();
    await query(ctx.ownerUrl, 'insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())', [listed]);
    await requestCode(listed);
    expect(await jobCount(ctx.waabek, listed)).toBe(1);

    expect((await superAdmin.put('/v1/admin/settings/access', { signupMode: 'open' })).body.signupMode).toBe('open');
    await requestCode(unlisted);
    expect(await jobCount(ctx.waabek, unlisted)).toBe(1);
  });
});
