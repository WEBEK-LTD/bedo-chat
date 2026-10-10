import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchToken } from '../src/messaging/scheduled.service.js';
import { adminClient, createTestAdmin } from './admin-helpers.js';
import { type IntegrationEnv, query, setupIntegrationEnv, startApp } from './integration-env.js';
import { client, createUser, type TestUser } from './messaging-helpers.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const reason = 'Announcements for the whole academy';

/**
 * Phase 15.1 (D-52): a channel made in the Admin Dashboard reaches everyone in the academy: every account now, every
 * new account when it is created, and accounts active again on the next minute call. People who left or were removed
 * stay out; groups never do this; students' own channels never do this.
 */
describe.runIf(enabled)('Phase 15.1 channels for everyone (real Postgres, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  let superAdmin: Awaited<ReturnType<typeof adminClient>>;
  let owner: TestUser;
  let ana: TestUser;
  let ben: TestUser;

  const minuteCall = async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/internal/dispatch', headers: { 'x-bedo-dispatch': dispatchToken(ctx.env.ACCESS_TOKEN_SECRET!) } });
    expect(response.statusCode, response.body).toBe(200);
  };
  const chatIds = async (user: TestUser) => ((await client(app, user).get('/v1/chats')).body.chats as Array<{ id: string }>).map((chat) => chat.id);
  const role = async (chatId: string, userId: string) =>
    (await query<{ role: string }>(ctx.ownerUrl, 'select role from app.conversation_members where conversation_id = $1 and user_id = $2', [chatId, userId])).rows[0]?.role ?? null;

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    app = await startApp(ctx.env);
    owner = await createUser(ctx, app, 'Office Owner');
    ana = await createUser(ctx, app, 'Ana Everyone');
    ben = await createUser(ctx, app, 'Ben Everyone');
    superAdmin = await adminClient(app, await createTestAdmin(ctx, app, 'super_admin'));
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  let channelId: string;

  it('adds every account to a channel for everyone when it is made, and only admins post', async () => {
    const created = await superAdmin.post('/v1/admin/chats', { type: 'channel', title: 'Academy news', ownerUserId: owner.id, everyone: true, reason });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({ type: 'channel', everyone: true, memberCount: 3 });
    channelId = created.body.id;
    expect(await role(channelId, ana.id)).toBe('subscriber');
    expect(await role(channelId, ben.id)).toBe('subscriber');
    expect(await chatIds(ana)).toContain(channelId);
    // A subscriber cannot post in a channel.
    const post = await client(app, ana).post(`/v1/chats/${channelId}/messages`, { clientId: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', text: 'hi' });
    expect(post.status).toBe(403);
    const history = await query<{ n: number }>(ctx.ownerUrl, "select count(*)::int as n from audit.membership_events where conversation_id = $1 and action = 'added' and details->>'everyone' = 'true'", [channelId]);
    expect(history.rows[0]!.n).toBe(2);
    expect((await superAdmin.get(`/v1/admin/chats?type=channel`)).body.chats[0]).toMatchObject({ id: channelId, everyone: true });
  });

  it('puts a new account in it as soon as the account is created', async () => {
    const cleo = await createUser(ctx, app, 'Cleo New');
    expect(await role(channelId, cleo.id)).toBe('subscriber');
    expect(await chatIds(cleo)).toContain(channelId);
  });

  it('does not add back someone who left or was removed', async () => {
    const dana = await createUser(ctx, app, 'Dana Leaver');
    expect((await client(app, dana).post(`/v1/groups/${channelId}/leave`, {})).status).toBeLessThan(300);
    expect(await role(channelId, dana.id)).toBeNull();
    const eli = await createUser(ctx, app, 'Eli Removed');
    expect((await superAdmin.post(`/v1/admin/chats/${channelId}/members/${eli.id}/remove`, { reason })).status).toBeLessThan(300);
    await minuteCall();
    expect(await role(channelId, dana.id)).toBeNull();
    expect(await role(channelId, eli.id)).toBeNull();
  });

  it('adds an account that is active again on the next minute call', async () => {
    await query(ctx.ownerUrl, "update app.users set status = 'suspended' where id = $1", [ben.id]);
    await query(ctx.ownerUrl, 'delete from app.conversation_members where conversation_id = $1 and user_id = $2', [channelId, ben.id]);
    await minuteCall();
    expect(await role(channelId, ben.id)).toBeNull();
    await query(ctx.ownerUrl, "update app.users set status = 'active' where id = $1", [ben.id]);
    await minuteCall();
    expect(await role(channelId, ben.id)).toBe('subscriber');
  });

  it('can be turned off (nobody removed, new accounts no longer join) and on again', async () => {
    const off = await superAdmin.patch(`/v1/admin/chats/${channelId}`, { everyone: false, reason });
    expect(off.status).toBe(200);
    expect(off.body.everyone).toBe(false);
    expect(await role(channelId, ana.id)).toBe('subscriber');
    const fay = await createUser(ctx, app, 'Fay Later');
    expect(await role(channelId, fay.id)).toBeNull();
    await minuteCall();
    expect(await role(channelId, fay.id)).toBeNull();

    const on = await superAdmin.patch(`/v1/admin/chats/${channelId}`, { everyone: true, reason });
    expect(on.status).toBe(200);
    expect(on.body.everyone).toBe(true);
    expect(await role(channelId, fay.id)).toBe('subscriber');
  });

  it('shows a channel switched on by the database update as soon as a student loads the chat list', async () => {
    const created = await superAdmin.post('/v1/admin/chats', { type: 'channel', title: 'Before the update', ownerUserId: owner.id, everyone: false, reason });
    expect(created.status).toBe(200);
    // As the database update does for channels made in the Admin Dashboard: switched on, nobody added yet.
    await query(ctx.ownerUrl, 'update app.group_settings set academy_wide = true where conversation_id = $1', [created.body.id]);
    expect(await role(created.body.id, ana.id)).toBeNull();
    expect(await chatIds(ana)).toContain(created.body.id);
    expect(await role(created.body.id, ana.id)).toBe('subscriber');
    // Ben's other devices are told through the update log, without a minute call.
    await client(app, ben).get('/v1/chats');
    const told = await query<{ n: number }>(ctx.ownerUrl, "select count(*)::int as n from app.update_log where user_id = $1 and conversation_id = $2 and kind = 'chat.info'", [ben.id, created.body.id]);
    expect(told.rows[0]!.n).toBeGreaterThan(0);
  });

  it('leaves channels made without it, groups and students’ own channels alone', async () => {
    const plain = await superAdmin.post('/v1/admin/chats', { type: 'channel', title: 'Class 3B', ownerUserId: owner.id, everyone: false, memberIds: [ana.id], reason });
    expect(plain.status).toBe(200);
    expect(plain.body).toMatchObject({ everyone: false, memberCount: 2 });
    expect((await superAdmin.post('/v1/admin/chats', { type: 'group', title: 'Office group', ownerUserId: owner.id, everyone: true, reason })).status).toBe(400);
    const group = await superAdmin.post('/v1/admin/chats', { type: 'group', title: 'Office group', ownerUserId: owner.id, reason });
    expect(group.status).toBe(200);
    expect(group.body.everyone).toBe(false);
    expect((await superAdmin.patch(`/v1/admin/chats/${group.body.id}`, { everyone: true, reason })).status).toBe(400);
    const gus = await createUser(ctx, app, 'Gus Newest');
    await minuteCall();
    expect(await role(plain.body.id, gus.id)).toBeNull();
    expect(await role(group.body.id, gus.id)).toBeNull();
    expect(await role(channelId, gus.id)).toBe('subscriber');
  });
});
