import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminClient, createTestAdmin } from './admin-helpers.js';
import { type IntegrationEnv, query, setupIntegrationEnv, startApp } from './integration-env.js';
import { client, createUser, resetMessageLimit, type TestUser } from './messaging-helpers.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const reason = 'Checked in the academy office';

type Dashboard = Awaited<ReturnType<typeof adminClient>>;

describe.runIf(enabled)('Phase 10 Admin Dashboard (real Postgres, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  const users: TestUser[] = [];
  let ana: TestUser;
  let ben: TestUser;
  let cleo: TestUser;
  let superAdmin: Dashboard;
  let moderator: Dashboard;
  let api: (user: TestUser) => ReturnType<typeof client>;

  async function newUser(name: string): Promise<TestUser> {
    const user = await createUser(ctx, app, name);
    users.push(user);
    return user;
  }

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    app = await startApp(ctx.env);
    api = (user) => client(app, user);
    ana = await newUser('Ana Console');
    ben = await newUser('Ben Console');
    cleo = await newUser('Cleo Console');
    superAdmin = await adminClient(app, await createTestAdmin(ctx, app, 'super_admin'));
    moderator = await adminClient(app, await createTestAdmin(ctx, app, 'moderator'));
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  beforeEach(async () => {
    for (const user of users) {
      await resetMessageLimit(ctx, user.id);
    }
  });

  it('finds users and shows their account; moderators suspend and reactivate, only Super Admins ban and delete', async () => {
    const dana = await newUser('Dana Console');
    const found = await moderator.get(`/v1/admin/users?q=${encodeURIComponent('Dana Con')}`);
    expect(found.status).toBe(200);
    expect(found.body.users.map((user: { id: string }) => user.id)).toEqual([dana.id]);
    expect((await moderator.get(`/v1/admin/users?q=${dana.phone.slice(-6)}`)).body.users[0].id).toBe(dana.id);
    const detail = await moderator.get(`/v1/admin/users/${dana.id}`);
    expect(detail.body).toMatchObject({ user: { id: dana.id, status: 'active' }, twoStepEnabled: false, counts: { groups: 0 } });
    expect(detail.body.sessions.length).toBeGreaterThan(0);

    // Suspension ends the sessions at once and stops sign-in; reactivation lets the person sign in again.
    const suspended = await moderator.post(`/v1/admin/users/${dana.id}/action`, { action: 'suspend', reason });
    expect(suspended.body).toMatchObject({ user: { status: 'suspended' }, sessions: [] });
    const blocked = await api(dana).get('/v1/me');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('ACCOUNT_BLOCKED');
    expect((await moderator.post(`/v1/admin/users/${dana.id}/action`, { action: 'ban', reason })).status).toBe(403);
    expect((await moderator.post(`/v1/admin/users/${dana.id}/action`, { action: 'delete', reason })).status).toBe(403);
    expect((await moderator.post(`/v1/admin/users/${dana.id}/action`, { action: 'reactivate', reason })).body.user.status).toBe('active');
    // The ended sessions stay ended (the person signs in again).
    expect((await api(dana).get('/v1/me')).status).toBe(403);
    expect((await moderator.post(`/v1/admin/users/${dana.id}/action`, { action: 'suspend', reason: 'no' })).status).toBe(400);
    const events = await query(ctx.ownerUrl, `select event, actor_type, reason from audit.account_events where user_id = $1 and event in ('suspended', 'reactivated') order by id`, [dana.id]);
    expect(events.rows).toEqual([
      { event: 'suspended', actor_type: 'admin', reason },
      { event: 'reactivated', actor_type: 'admin', reason },
    ]);
    const log = await query(ctx.ownerUrl, `select action from app.audit_log where target_id = $1 and action like 'user.%' order by id`, [dana.id]);
    expect(log.rows.map((row) => row.action)).toEqual(['user.suspend', 'user.reactivate']);
    // Ending every session of an active account.
    const again = await newUser('Eli Console');
    expect((await moderator.post(`/v1/admin/users/${again.id}/action`, { action: 'end_sessions', reason })).body.sessions).toEqual([]);
    expect((await api(again).get('/v1/me')).status).toBe(401);
    // A Super Admin bans; only a Super Admin lifts a ban.
    expect((await superAdmin.post(`/v1/admin/users/${again.id}/action`, { action: 'ban', reason })).body.user.status).toBe('banned');
    expect((await moderator.post(`/v1/admin/users/${again.id}/action`, { action: 'reactivate', reason })).status).toBe(403);
    expect((await superAdmin.post(`/v1/admin/users/${again.id}/action`, { action: 'reactivate', reason })).body.user.status).toBe('active');

    // A Super Admin deletes an account directly: the identity goes to the history, the number off the list.
    const extra = await newUser('Extra Removed');
    const deleted = await superAdmin.post(`/v1/admin/users/${extra.id}/action`, { action: 'delete', reason });
    expect(deleted.body.user).toMatchObject({ status: 'deleted', phone: null, name: null });
    expect((await query(ctx.ownerUrl, 'select count(*)::int as n from app.academy_phone_list where phone = $1', [extra.phone])).rows[0]!.n).toBe(0);
    expect((await query(ctx.ownerUrl, `select old_value from audit.identity_history where user_id = $1 and field = 'name' order by id`, [extra.id])).rows.at(-1)).toEqual({ old_value: 'Extra Removed' });
  });

  it('manages groups and channels as their owner could, without reading their messages', async () => {
    const created = await superAdmin.post('/v1/admin/chats', { type: 'group', title: 'Office group', ownerUserId: ana.id, memberIds: [ben.id], reason });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({ type: 'group', title: 'Office group', memberCount: 2, owner: { id: ana.id }, admins: [expect.objectContaining({ role: 'owner' })] });
    const groupId = created.body.id;
    expect((await api(ana).get(`/v1/chats/${groupId}`)).body.group.role).toBe('owner');
    await api(ana).send(groupId, 'A private conversation');
    // Moderators read; only Super Admins change.
    expect((await moderator.get(`/v1/admin/chats?type=group&q=office`)).body.chats.map((chat: { id: string }) => chat.id)).toEqual([groupId]);
    expect((await moderator.patch(`/v1/admin/chats/${groupId}`, { title: 'x', reason })).status).toBe(403);
    // Member privacy and permissions, then admins and restrictions.
    const updated = await superAdmin.patch(`/v1/admin/chats/${groupId}`, { hideMemberList: true, defaultPermissions: ['send_messages'], reason });
    expect(updated.body.settings).toEqual({ defaultPermissions: ['send_messages'], hideMemberCount: false, hideMemberList: true });
    expect((await api(ben).get(`/v1/chats/${groupId}`)).body.group.canViewMembers).toBe(false);
    expect((await superAdmin.post(`/v1/admin/chats/${groupId}/members`, { userIds: [cleo.id], reason })).body.added).toEqual([cleo.id]);
    const promoted = await superAdmin.patch(`/v1/admin/chats/${groupId}/members/${cleo.id}`, { role: 'admin', adminRights: ['pin_messages'], reason });
    expect(promoted.body).toMatchObject({ role: 'admin', adminRights: ['pin_messages'] });
    expect((await superAdmin.patch(`/v1/admin/chats/${groupId}/members/${ben.id}`, { deniedPermissions: ['send_messages'], restrictedUntil: null, reason })).body.deniedPermissions).toEqual(['send_messages']);
    expect((await api(ben).send(groupId, 'blocked')).body.error.code).toBe('NOT_ALLOWED');
    expect((await superAdmin.patch(`/v1/admin/chats/${groupId}/members/${ben.id}`, { role: 'owner', reason })).body.role).toBe('owner');
    expect((await api(ana).get(`/v1/chats/${groupId}`)).body.group.role).toBe('admin');
    // The admin never sees messages here (O-18).
    const members = await superAdmin.get(`/v1/admin/chats/${groupId}/members`);
    expect(members.body.members).toHaveLength(3);
    expect(JSON.stringify(await superAdmin.get(`/v1/admin/chats/${groupId}`))).not.toContain('A private conversation');
    // Removal bans; deleting keeps the history and drops the chat from every device.
    expect((await superAdmin.post(`/v1/admin/chats/${groupId}/members/${cleo.id}/remove`, { reason })).status).toBe(200);
    expect((await query(ctx.ownerUrl, 'select banned_by_admin is not null as by_admin from app.chat_bans where conversation_id = $1 and user_id = $2', [groupId, cleo.id])).rows).toEqual([{ by_admin: true }]);
    expect((await superAdmin.post(`/v1/admin/chats/${groupId}/delete`, { reason })).body.deleted).toBe(true);
    expect((await api(ana).get(`/v1/chats/${groupId}`)).status).toBe(404);
    const history = await query(ctx.ownerUrl, `select action, actor_type from audit.membership_events where conversation_id = $1 order by id`, [groupId]);
    expect(history.rows.every((row) => row.actor_type === 'admin')).toBe(true);
    // A channel made public, with subscribers.
    const channel = await superAdmin.post('/v1/admin/chats', { type: 'channel', title: 'Office news', ownerUserId: ana.id, isPublic: true, memberIds: [ben.id, cleo.id], reason });
    expect(channel.body).toMatchObject({ type: 'channel', public: true, memberCount: 3 });
    expect((await superAdmin.patch(`/v1/admin/chats/${channel.body.id}`, { hideMemberList: true, reason })).status).toBe(400);
    expect((await api(cleo).get(`/v1/chats/${channel.body.id}`)).body.group.role).toBe('subscriber');
  });

  it('reviews reports with the reported message only, removes it for everyone, and records the decision', async () => {
    const chat = await api(ana).openChat(cleo);
    await api(cleo).send(chat.id, 'An ordinary message nobody reported');
    const bad = await api(cleo).send(chat.id, 'Something inappropriate');
    expect((await api(ana).post('/v1/reports', { userId: cleo.id, messageId: bad.body.id, reason: 'inappropriate_content', details: 'Rude' })).status).toBe(200);
    const open = await moderator.get('/v1/admin/reports');
    const report = open.body.reports.find((item: { message: { id: string } | null }) => item.message?.id === bad.body.id);
    expect(report).toMatchObject({ reason: 'inappropriate_content', reporter: { id: ana.id }, reportedUser: { id: cleo.id }, message: { reportedText: 'Something inappropriate', currentText: 'Something inappropriate', deleted: false }, decision: null });
    expect(JSON.stringify(open.body)).not.toContain('An ordinary message nobody reported');
    // A moderator removes the message for everyone; only Super Admins ban.
    expect((await moderator.post(`/v1/admin/reports/${report.id}/decision`, { decision: 'user_banned' })).status).toBe(403);
    const decided = await moderator.post(`/v1/admin/reports/${report.id}/decision`, { decision: 'message_removed', note: 'Removed after review' });
    expect(decided.body).toMatchObject({ message: { deleted: true, removedByAdmin: true, currentText: null }, decision: { decision: 'message_removed', note: 'Removed after review' } });
    expect((await moderator.post(`/v1/admin/reports/${report.id}/decision`, { decision: 'dismissed' })).status).toBe(409);
    const seen = (await api(ana).get(`/v1/chats/${chat.id}/messages`)).body.messages.find((message: { id: string }) => message.id === bad.body.id);
    expect(seen).toMatchObject({ deleted: true, text: null });
    const revision = await query(ctx.ownerUrl, `select action, actor_type, previous_text from audit.message_revisions where message_id = $1`, [bad.body.id]);
    expect(revision.rows).toEqual([{ action: 'deleted_for_both', actor_type: 'admin', previous_text: 'Something inappropriate' }]);
    expect((await moderator.get('/v1/admin/reports?status=decided')).body.reports.some((item: { id: string }) => item.id === report.id)).toBe(true);
  });

  it('opens the audit history only for Super Admins, with a reason, recording every view', async () => {
    expect((await moderator.get(`/v1/admin/audit?kind=identity&userId=${ana.id}&reason=${encodeURIComponent(reason)}`)).status).toBe(403);
    expect((await superAdmin.get(`/v1/admin/audit?kind=identity&userId=${ana.id}`)).status).toBe(400);
    expect((await superAdmin.get(`/v1/admin/audit?kind=messages&reason=${encodeURIComponent(reason)}`)).status).toBe(400);
    const identity = await superAdmin.get(`/v1/admin/audit?kind=identity&userId=${ana.id}&reason=${encodeURIComponent(reason)}`);
    expect(identity.body.entries.some((entry: { event: string; detail: string }) => entry.event === 'name changed' && entry.detail.includes('Ana Console'))).toBe(true);
    const messages = await superAdmin.get(`/v1/admin/audit?kind=messages&userId=${cleo.id}&reason=${encodeURIComponent(reason)}`);
    expect(messages.body.entries[0]).toMatchObject({ event: 'message deleted for both', actor: expect.stringMatching(/^admin /) });
    for (const kind of ['membership', 'account', 'security', 'screenshots', 'admin']) {
      expect((await superAdmin.get(`/v1/admin/audit?kind=${kind}&userId=${ana.id}&reason=${encodeURIComponent(reason)}`)).status).toBe(200);
    }
    const views = await query(ctx.ownerUrl, `select metadata->>'kind' as kind, metadata->>'reason' as reason from app.audit_log where action = 'audit.viewed' order by id`);
    expect(views.rows.map((row) => row.kind)).toEqual(['identity', 'messages', 'membership', 'account', 'security', 'screenshots', 'admin']);
    expect(new Set(views.rows.map((row) => row.reason))).toEqual(new Set([reason]));
  });

  it('broadcasts a notification to everyone or one channel (O-20), in batches, and shows statistics', async () => {
    for (const user of [ana, ben, cleo]) {
      await api(user).put('/v1/me/push-subscription', { endpoint: `https://fcm.googleapis.com/fcm/send/console-${user.id}`, keys: { p256dh: 'p', auth: 'a' } });
    }
    await ctx.push.all();
    ctx.push.clear();
    expect((await moderator.post('/v1/admin/broadcasts', { title: 'Hi', body: 'All', audience: 'all' })).status).toBe(403);
    const everyone = await superAdmin.post('/v1/admin/broadcasts', { title: 'Academy closed', body: 'The academy is closed on Friday.', audience: 'all' });
    expect(everyone.status, JSON.stringify(everyone.body)).toBe(200);
    const all = await ctx.push.all();
    expect(new Set(all.filter((push) => push.payload.title === 'Academy closed').map((push) => push.endpoint))).toEqual(
      new Set([ana, ben, cleo].map((user) => `https://fcm.googleapis.com/fcm/send/console-${user.id}`)),
    );
    const listed = (await superAdmin.get('/v1/admin/broadcasts')).body.broadcasts[0];
    expect(listed).toMatchObject({ title: 'Academy closed', status: 'sent', devices: 3 });

    const channel = (await superAdmin.post('/v1/admin/chats', { type: 'channel', title: 'Broadcast channel', ownerUserId: ana.id, memberIds: [ben.id], reason })).body;
    await ctx.push.all();
    ctx.push.clear();
    await superAdmin.post('/v1/admin/broadcasts', { title: 'Channel notice', body: 'For this channel', audience: 'chat', chatId: channel.id });
    const toChannel = (await ctx.push.all()).filter((push) => push.payload.title === 'Channel notice').map((push) => push.endpoint);
    expect(new Set(toChannel)).toEqual(new Set([ana, ben].map((user) => `https://fcm.googleapis.com/fcm/send/console-${user.id}`)));
    expect((await superAdmin.post('/v1/admin/broadcasts', { title: 'x', body: 'y', audience: 'chat' })).status).toBe(400);
    expect((await superAdmin.post('/v1/admin/broadcasts', { title: 'x', body: 'y', audience: 'chat', chatId: randomUUID() })).status).toBe(404);

    // Many devices: delivered in batches of 200, each device once.
    const many = await newUser('Many Devices');
    await query(
      ctx.ownerUrl,
      `with s as (
         insert into app.sessions (user_id, refresh_hash, platform, expires_at)
         select $1::uuid, 'batch-' || g || '-' || $1::text, 'web', now() + interval '1 day' from generate_series(1, 450) g
         returning id
       )
       insert into app.push_subscriptions (user_id, session_id, endpoint, p256dh, auth)
       select $1::uuid, s.id, 'https://fcm.googleapis.com/fcm/send/batch-' || s.id, 'p', 'a' from s`,
      [many.id],
    );
    ctx.push.clear();
    await superAdmin.post('/v1/admin/broadcasts', { title: 'Batched', body: 'To every device', audience: 'all' });
    const batched = (await ctx.push.all()).filter((push) => push.payload.title === 'Batched').map((push) => push.endpoint);
    expect(batched.filter((endpoint) => endpoint.includes('/batch-'))).toHaveLength(450);
    expect(new Set(batched).size).toBe(batched.length);
    const finished = (await superAdmin.get('/v1/admin/broadcasts')).body.broadcasts[0];
    expect(finished).toMatchObject({ title: 'Batched', status: 'sent' });
    expect(finished.devices).toBe(batched.length);

    const stats = await moderator.get('/v1/admin/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.users.total).toBeGreaterThanOrEqual(4);
    expect(stats.body.channels).toBeGreaterThanOrEqual(1);
    expect(stats.body.pushDevices).toBeGreaterThanOrEqual(3);
  });
});
