import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminClient, createTestAdmin } from './admin-helpers.js';
import { FakeMediaStorage, type IntegrationEnv, query, setupIntegrationEnv, startApp } from './integration-env.js';
import { client, createUser, resetMessageLimit, type TestUser } from './messaging-helpers.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

type Api = ReturnType<typeof client>;

describe.runIf(enabled)('Phase 5 groups (real Postgres, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  const users: TestUser[] = [];
  let owner: TestUser;
  let admin: TestUser;
  let member: TestUser;
  let quiet: TestUser;
  let outsider: TestUser;
  let api: (user: TestUser) => Api;

  async function newUser(name: string, username?: string): Promise<TestUser> {
    const user = await createUser(ctx, app, name);
    if (username) await client(app, user).patch('/v1/me', { username });
    users.push(user);
    return user;
  }

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    app = await startApp(ctx.env, undefined, { storage: new FakeMediaStorage() });
    api = (user) => client(app, user);
    owner = await newUser('Olivia Owner', 'olivia_owner');
    admin = await newUser('Adam Admin', 'adam_admin');
    member = await newUser('Mia Member', 'mia_member');
    quiet = await newUser('Quentin Quiet', 'quentin_quiet');
    outsider = await newUser('Otto Outsider', 'otto_outsider');
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  beforeEach(async () => {
    for (const user of users) {
      await resetMessageLimit(ctx, user.id);
      await query(ctx.ownerUrl, 'delete from app.rate_counters where key like $1', [`rl:%:${user.id}`]);
    }
  });

  async function newGroup(title: string, memberIds: string[]) {
    const created = await api(owner).post('/v1/groups', { title, memberIds });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return created.body as { id: string; type: string; group: Record<string, unknown> };
  }

  it('creates a group with its members, the creator as owner, and shows it in everyone’s chat list', async () => {
    const group = await newGroup('Physics 101', [admin.id, member.id, quiet.id]);
    expect(group).toMatchObject({ type: 'group', peer: null, group: { title: 'Physics 101', role: 'owner', memberCount: 4, canViewMembers: true } });
    expect((group.group.adminRights as string[]).length).toBe(8);
    const list = await api(member).get('/v1/chats');
    const seen = list.body.chats.find((chat: { id: string }) => chat.id === group.id);
    expect(seen.group).toMatchObject({ title: 'Physics 101', role: 'member', adminRights: [], settings: null, pendingRequests: null });
    expect(seen.group.permissions).toEqual(['send_messages', 'send_media', 'send_stickers', 'send_polls', 'add_members', 'pin_messages']);
    expect((await api(outsider).get(`/v1/chats/${group.id}`)).status).toBe(404);
    const history = await query(ctx.ownerUrl, 'select user_id, action, actor_id from audit.membership_events where conversation_id = $1 order by id', [group.id]);
    expect(history.rows.map((row) => row.action)).toEqual(['created', 'added', 'added', 'added']);
  });

  it('delivers group messages to every member with the sender’s name, and records @mentions of members', async () => {
    const group = await newGroup('Mentions', [admin.id, member.id]);
    const sent = await api(member).send(group.id, 'Hi @adam_admin and @otto_outsider, see #homework');
    expect(sent.status).toBe(200);
    expect(sent.body.sender).toMatchObject({ id: member.id, displayName: 'Mia Member' });
    const adminView = (await api(admin).get(`/v1/chats/${group.id}/messages`)).body.messages.at(-1);
    expect(adminView).toMatchObject({ text: sent.body.text, mentionsMe: true, sender: { id: member.id } });
    const ownerView = (await api(owner).get(`/v1/chats/${group.id}/messages`)).body.messages.at(-1);
    expect(ownerView.mentionsMe).toBe(false);
    // A non-member named in a message is not recorded.
    expect((await query(ctx.ownerUrl, 'select user_id from app.message_mentions where message_id = $1', [sent.body.id])).rows).toEqual([{ user_id: admin.id }]);
    // Every member's devices hear of it.
    const sync = await api(owner).get('/v1/sync?since=0');
    expect(sync.body.updates.some((update: { kind: string; messageId: string }) => update.kind === 'message.new' && update.messageId === sent.body.id)).toBe(true);
    // Hashtags are found by in-chat search.
    expect((await api(owner).get(`/v1/chats/${group.id}/search?q=%23homework`)).body.messages[0].id).toBe(sent.body.id);
  });

  it('applies member permissions, restrictions and admin rights to every action', async () => {
    const group = await newGroup('Rules', [admin.id, member.id]);
    // Promote Adam with some rights; an admin cannot give rights they lack.
    expect((await api(owner).patch(`/v1/groups/${group.id}/members/${admin.id}`, { role: 'admin', adminRights: ['delete_messages', 'restrict_members', 'pin_messages'] })).status).toBe(200);
    expect((await api(admin).patch(`/v1/groups/${group.id}/members/${member.id}`, { role: 'admin', adminRights: ['manage_admins'] })).body.error.code).toBe('NOT_ALLOWED');
    // Members may not send media once the owner turns it off; text still works.
    await api(owner).patch(`/v1/groups/${group.id}/settings`, { defaultPermissions: ['send_messages', 'send_polls'] });
    expect((await api(member).post('/v1/files/uploads', { chatId: group.id, kind: 'photo', mimeType: 'image/jpeg', size: 1000 })).body.error.code).toBe('NOT_ALLOWED');
    expect((await api(admin).post('/v1/files/uploads', { chatId: group.id, kind: 'photo', mimeType: 'image/jpeg', size: 1000 })).status).toBe(200);
    const text = await api(member).send(group.id, 'still allowed');
    expect(text.status).toBe(200);
    // Pinning is no longer a member permission here; the admin with the right may.
    expect((await api(member).put(`/v1/messages/${text.body.id}/pin`)).body.error.code).toBe('NOT_ALLOWED');
    expect((await api(admin).put(`/v1/messages/${text.body.id}/pin`)).status).toBe(200);
    // A member may not change another's settings or remove anyone.
    expect((await api(member).patch(`/v1/groups/${group.id}/settings`, { hideMemberList: true })).body.error.code).toBe('NOT_ALLOWED');
    expect((await api(member).del(`/v1/groups/${group.id}/members/${admin.id}`)).body.error.code).toBe('NOT_ALLOWED');
    // Restricting: Mia loses sending until the time given; the restriction shows in her group view.
    const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect((await api(admin).patch(`/v1/groups/${group.id}/members/${member.id}`, { deniedPermissions: ['send_messages'], restrictedUntil: until })).status).toBe(200);
    expect((await api(member).send(group.id, 'muted?')).body.error.code).toBe('NOT_ALLOWED');
    const view = (await api(member).get(`/v1/chats/${group.id}`)).body.group;
    expect(view).toMatchObject({ restricted: true, permissions: ['send_polls'] });
    // An expired restriction no longer applies.
    await query(ctx.ownerUrl, `update app.conversation_members set restricted_until = now() - interval '1 minute' where conversation_id = $1 and user_id = $2`, [group.id, member.id]);
    expect((await api(member).send(group.id, 'free again')).status).toBe(200);
    // Admin deletes someone else's message for everyone (right: delete_messages); a member cannot.
    const other = await api(owner).send(group.id, 'from the owner');
    expect((await api(member).post('/v1/messages/delete', { chatId: group.id, messageIds: [other.body.id], scope: 'both' })).status).toBe(403);
    expect((await api(admin).post('/v1/messages/delete', { chatId: group.id, messageIds: [text.body.id], scope: 'both' })).status).toBe(200);
    const revisions = await query(ctx.ownerUrl, 'select action, actor_id from audit.message_revisions where message_id = $1', [text.body.id]);
    expect(revisions.rows).toEqual([{ action: 'deleted_for_both', actor_id: admin.id }]);
    const history = await query(ctx.ownerUrl, `select action from audit.membership_events where conversation_id = $1 and action not in ('created', 'added') order by id`, [group.id]);
    expect(history.rows.map((row) => row.action)).toEqual(['promoted', 'restricted']);
  });

  it('keeps hidden members hidden from normal members everywhere (§7 contract test)', async () => {
    const group = await newGroup('Private class', [admin.id, member.id, quiet.id]);
    // Privacy is turned on first; everything below happens while it is on (the creation itself was announced).
    await api(owner).patch(`/v1/groups/${group.id}/settings`, { hideMemberCount: true, hideMemberList: true });
    const since = (await api(member).post('/v1/realtime/heartbeat')).body.seq as number;
    await api(owner).patch(`/v1/groups/${group.id}/members/${admin.id}`, { role: 'admin', adminRights: ['restrict_members', 'invite_users'] });
    await api(owner).send(group.id, 'Welcome, the member list is private');
    const poll = await api(owner).post(`/v1/chats/${group.id}/messages`, {
      clientId: randomUUID(),
      poll: { question: 'Ready?', options: ['Yes', 'No'], anonymous: false },
    });
    expect(poll.status, JSON.stringify(poll.body)).toBe(200);
    await api(quiet).post(`/v1/messages/${poll.body.id}/poll/vote`, { options: [0] });
    // Quentin joins and leaves activity, Adam is promoted: membership changes happen while privacy is on.
    const link = await api(admin).post(`/v1/groups/${group.id}/invites`, {});
    const joiner = await newUser('Jill Joiner', 'jill_joiner');
    await api(joiner).post(`/v1/invites/${link.body.code}/join`);
    await api(joiner).post(`/v1/groups/${group.id}/leave`);

    // Everything Mia (a normal member) can ask for about this group.
    const ctxTopic = (await api(member).get('/v1/realtime/channel')).body.topic as string;
    ctx.realtime.clear();
    await api(quiet).post('/v1/realtime/typing', { chatId: group.id });
    const bodies = [
      (await api(member).get(`/v1/chats/${group.id}`)).body,
      (await api(member).get('/v1/chats')).body,
      (await api(member).get(`/v1/chats/${group.id}/messages`)).body,
      (await api(member).get(`/v1/sync?since=${since}`)).body,
      (await api(member).get(`/v1/chats/${group.id}/pins`)).body,
      (await api(member).get(`/v1/chats/${group.id}/media?kind=media`)).body,
      (await api(member).get(`/v1/invites/${link.body.code}`)).body,
      (await api(member).post(`/v1/messages/${poll.body.id}/poll/vote`, { options: [1] })).body,
      await ctx.realtime.on(ctxTopic),
    ];
    const refused = [
      await api(member).get(`/v1/groups/${group.id}/members`),
      await api(member).get(`/v1/messages/${poll.body.id}/poll/voters`),
      await api(member).get(`/v1/groups/${group.id}/invites`),
      await api(member).get(`/v1/groups/${group.id}/requests`),
    ];
    for (const response of refused) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('NOT_ALLOWED');
    }
    const text = JSON.stringify(bodies);
    // Quentin and Jill never sent a message: nothing about them may reach Mia (ids, names, usernames). Adam neither.
    for (const hidden of [quiet, joiner, admin]) {
      expect(text, hidden.name).not.toContain(hidden.id);
      expect(text, hidden.name).not.toContain(hidden.name);
    }
    expect(text).not.toContain('quentin_quiet');
    const chat = bodies[0] as { group: Record<string, unknown> };
    expect(chat.group).toMatchObject({ memberCount: null, canViewMembers: false, settings: null, pendingRequests: null });
    expect((bodies[6] as { memberCount: unknown }).memberCount).toBeNull();
    // Typing reaches Mia as "someone is typing"; membership changes never reached her devices.
    expect((bodies[8] as Array<{ type: string }>).filter((signal) => signal.type === 'typing')).toEqual([{ type: 'typing', chatId: group.id, userId: null }]);
    expect((bodies[3] as { updates: Array<{ kind: string }> }).updates.some((update) => update.kind === 'chat.members')).toBe(false);
    expect((bodies[3] as { updates: unknown[] }).updates.length).toBeGreaterThan(0);
    // The database itself refuses the list and count to her, whatever the API asked.
    await expect(query(ctx.runtimeUrl, 'select * from app.group_members($1, $2, null, 50)', [member.id, group.id])).rejects.toThrow(/hidden/);
    await expect(query(ctx.runtimeUrl, 'select app.group_member_count($1, $2)', [member.id, group.id])).rejects.toThrow(/hidden/);

    // The owner and admins see everything.
    const list = await api(admin).get(`/v1/groups/${group.id}/members`);
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(4);
    expect(list.body.members.map((entry: { user: { id: string } }) => entry.user.id).sort()).toEqual([owner.id, admin.id, member.id, quiet.id].sort());
    expect((await api(owner).get(`/v1/messages/${poll.body.id}/poll/voters`)).body.options[0].voters.map((user: { id: string }) => user.id)).toEqual([quiet.id]);
    const adminSync = await api(admin).get('/v1/sync?since=0');
    expect(adminSync.body.updates.some((update: { kind: string; chatId: string }) => update.kind === 'chat.members' && update.chatId === group.id)).toBe(true);

    // With privacy off again, members see the list and count.
    await api(owner).patch(`/v1/groups/${group.id}/settings`, { hideMemberCount: false, hideMemberList: false });
    expect((await api(member).get(`/v1/groups/${group.id}/members`)).body.count).toBe(4);
    expect((await api(member).get(`/v1/chats/${group.id}`)).body.group).toMatchObject({ memberCount: 4, canViewMembers: true });
  });

  it('joins with invite links, limits and approvals', async () => {
    const group = await newGroup('Invites', [admin.id]);
    expect((await api(member).post(`/v1/groups/${group.id}/invites`, {})).status).toBe(404);
    const limited = await api(owner).post(`/v1/groups/${group.id}/invites`, { name: 'Once', usageLimit: 1 });
    expect(limited.body).toMatchObject({ name: 'Once', usageLimit: 1, usageCount: 0, requiresApproval: false, revoked: false });
    expect(limited.body.code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const preview = await api(member).get(`/v1/invites/${limited.body.code}`);
    expect(preview.body).toMatchObject({ title: 'Invites', memberCount: 2, requiresApproval: false, chatId: null, requested: false });
    expect((await api(member).post(`/v1/invites/${limited.body.code}/join`)).body).toEqual({ status: 'joined', chatId: group.id });
    // Used up: the next person cannot join with it; an unknown code looks the same.
    expect((await api(quiet).post(`/v1/invites/${limited.body.code}/join`)).status).toBe(404);
    expect((await api(quiet).get(`/v1/invites/${'x'.repeat(22)}`)).status).toBe(404);

    const approval = await api(owner).post(`/v1/groups/${group.id}/invites`, { requiresApproval: true });
    expect((await api(quiet).post(`/v1/invites/${approval.body.code}/join`)).body).toEqual({ status: 'requested', chatId: null });
    expect((await api(quiet).get(`/v1/invites/${approval.body.code}`)).body.requested).toBe(true);
    expect((await api(quiet).get(`/v1/chats/${group.id}`)).status).toBe(404);
    expect((await api(owner).get(`/v1/chats/${group.id}`)).body.group.pendingRequests).toBe(1);
    const requests = await api(owner).get(`/v1/groups/${group.id}/requests`);
    expect(requests.body.requests.map((entry: { user: { id: string } }) => entry.user.id)).toEqual([quiet.id]);
    expect((await api(owner).post(`/v1/groups/${group.id}/requests/${requests.body.requests[0].id}/approve`)).body.requests).toEqual([]);
    expect((await api(quiet).get(`/v1/chats/${group.id}`)).body.group.role).toBe('member');
    // Revoked links stop working.
    await api(owner).del(`/v1/groups/${group.id}/invites/${approval.body.id}`);
    expect((await api(outsider).get(`/v1/invites/${approval.body.code}`)).status).toBe(404);
    const history = await query(ctx.ownerUrl, `select user_id, action from audit.membership_events where conversation_id = $1 and action in ('joined', 'request_approved') order by id`, [group.id]);
    expect(history.rows).toEqual([
      { user_id: member.id, action: 'joined' },
      { user_id: quiet.id, action: 'request_approved' },
      { user_id: quiet.id, action: 'joined' },
    ]);
  });

  it('runs polls and quizzes: results after voting, final quiz answers, closing', async () => {
    const group = await newGroup('Polls', [member.id, quiet.id]);
    expect((await api(owner).post(`/v1/chats/${group.id}/messages`, { clientId: randomUUID(), poll: { question: 'Q', options: ['A', 'A'] } })).status).toBe(400);
    const quiz = await api(owner).post(`/v1/chats/${group.id}/messages`, {
      clientId: randomUUID(),
      poll: { question: '2 + 2?', options: ['3', '4', '5'], kind: 'quiz', correctOption: 1, explanation: 'Basic sums' },
    });
    expect(quiz.body.poll).toMatchObject({ kind: 'quiz', closed: false, totalVoters: null, myVotes: null, correctOption: null, explanation: null });
    expect(quiz.body.poll.options).toEqual([
      { text: '3', votes: null },
      { text: '4', votes: null },
      { text: '5', votes: null },
    ]);
    const answered = await api(member).post(`/v1/messages/${quiz.body.id}/poll/vote`, { options: [0] });
    expect(answered.body.poll).toMatchObject({ myVotes: [0], correctOption: 1, explanation: 'Basic sums', totalVoters: 1 });
    // A quiz answer is final.
    expect((await api(member).del(`/v1/messages/${quiz.body.id}/poll/vote`)).status).toBe(409);
    expect((await api(member).post(`/v1/messages/${quiz.body.id}/poll/vote`, { options: [1] })).status).toBe(409);
    // Someone who has not answered still sees no results.
    expect((await api(quiet).get(`/v1/chats/${group.id}/messages`)).body.messages.at(-1).poll.totalVoters).toBeNull();

    const regular = await api(member).post(`/v1/chats/${group.id}/messages`, { clientId: randomUUID(), poll: { question: 'Lunch?', options: ['Pizza', 'Salad', 'Soup'], multiple: true } });
    expect((await api(quiet).post(`/v1/messages/${regular.body.id}/poll/vote`, { options: [0, 2] })).body.poll.options.map((option: { votes: number }) => option.votes)).toEqual([1, 0, 1]);
    expect((await api(quiet).del(`/v1/messages/${regular.body.id}/poll/vote`)).body.poll.myVotes).toBeNull();
    await api(quiet).post(`/v1/messages/${regular.body.id}/poll/vote`, { options: [1] });
    // Anonymous: nobody sees voters. Closing: the creator, results for everyone.
    expect((await api(owner).get(`/v1/messages/${regular.body.id}/poll/voters`)).status).toBe(403);
    expect((await api(quiet).post(`/v1/messages/${regular.body.id}/poll/close`)).status).toBe(403);
    const closed = await api(member).post(`/v1/messages/${regular.body.id}/poll/close`);
    expect(closed.body.poll).toMatchObject({ closed: true });
    expect((await api(owner).get(`/v1/chats/${group.id}/messages`)).body.messages.at(-1).poll).toMatchObject({ closed: true, totalVoters: 1, myVotes: null });
    expect((await api(quiet).post(`/v1/messages/${regular.body.id}/poll/vote`, { options: [0] })).status).toBe(409);
    // Polls are for groups.
    const privateChat = await api(member).openChat(quiet);
    expect((await api(member).post(`/v1/chats/${privateChat.id}/messages`, { clientId: randomUUID(), poll: { question: 'x', options: ['a', 'b'] } })).status).toBe(400);
    // Edits are not possible on polls; a poll in the voters' devices updates through sync.
    expect((await api(member).patch(`/v1/messages/${regular.body.id}`, { text: 'x' })).status).toBe(403);
    const sync = await api(owner).get('/v1/sync?since=0');
    expect(sync.body.updates.some((update: { kind: string; messageId: string }) => update.kind === 'message.poll' && update.messageId === regular.body.id)).toBe(true);
  });

  it('leaves, removes, transfers ownership and deletes, and removed members lose the chat', async () => {
    const group = await newGroup('Lifecycle', [admin.id, member.id, quiet.id]);
    await api(owner).patch(`/v1/groups/${group.id}/members/${admin.id}`, { role: 'admin', adminRights: ['restrict_members'] });
    // An admin without "manage admins" cannot remove another admin or the owner; removes a member.
    expect((await api(admin).del(`/v1/groups/${group.id}/members/${owner.id}`)).status).toBe(403);
    expect((await api(admin).del(`/v1/groups/${group.id}/members/${quiet.id}`)).status).toBe(200);
    expect((await api(quiet).get(`/v1/chats/${group.id}`)).status).toBe(404);
    expect((await api(quiet).get(`/v1/chats/${group.id}/messages`)).status).toBe(404);
    const quietSync = await api(quiet).get('/v1/sync?since=0');
    expect(quietSync.body.updates.some((update: { kind: string; chatId: string }) => update.kind === 'chat.removed' && update.chatId === group.id)).toBe(true);
    expect((await api(quiet).get('/v1/chats')).body.chats.some((chat: { id: string }) => chat.id === group.id)).toBe(false);
    // Mia leaves.
    expect((await api(member).post(`/v1/groups/${group.id}/leave`)).status).toBe(200);
    expect((await api(member).send(group.id, 'still here?')).status).toBe(404);
    // The owner cannot leave while others are in it; gives it to Adam first.
    expect((await api(owner).post(`/v1/groups/${group.id}/leave`)).status).toBe(409);
    const transferred = await api(owner).post(`/v1/groups/${group.id}/owner`, { userId: admin.id });
    expect(transferred.body.group.role).toBe('admin');
    expect((await api(admin).get(`/v1/chats/${group.id}`)).body.group.role).toBe('owner');
    expect((await api(owner).del(`/v1/groups/${group.id}`)).status).toBe(403);
    expect((await api(admin).del(`/v1/groups/${group.id}`)).status).toBe(200);
    expect((await api(owner).get(`/v1/chats/${group.id}`)).status).toBe(404);
    // The history stays.
    expect(Number((await query(ctx.ownerUrl, 'select count(*) from audit.membership_events where conversation_id = $1', [group.id])).rows[0]!.count)).toBeGreaterThan(5);
  });

  it('lets admins decide who may create groups (O-21), and mutes chats per member', async () => {
    expect((await api(outsider).get('/v1/me/permissions')).body).toEqual({ createGroups: true, createChannels: false, scheduleMessages: false });
    const dashboard = await adminClient(app, await createTestAdmin(ctx, app, 'super_admin'));
    const changed = await dashboard.put('/v1/admin/users/permissions', { phone: outsider.phone, createGroups: false, createChannels: true, scheduleMessages: true });
    expect(changed.body.permissions).toEqual({ createGroups: false, createChannels: true, scheduleMessages: true });
    expect((await api(outsider).post('/v1/groups', { title: 'Not allowed' })).body.error.code).toBe('NOT_ALLOWED');
    const audit = await query(ctx.ownerUrl, `select metadata from app.audit_log where action = 'users.permissions_changed'`);
    expect(audit.rows[0]!.metadata.after).toEqual({ createGroups: false, createChannels: true, scheduleMessages: true });

    const group = await newGroup('Mute me', [member.id]);
    const until = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
    expect((await api(member).patch(`/v1/chats/${group.id}/state`, { mutedUntil: until })).body.mutedUntil).toBe(until);
    expect((await api(member).patch(`/v1/chats/${group.id}/state`, { mutedUntil: null })).body.mutedUntil).toBeNull();
  });
});
