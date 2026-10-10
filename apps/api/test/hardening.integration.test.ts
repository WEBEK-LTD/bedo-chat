import { randomUUID } from 'node:crypto';
import { buildOpenApiDocument } from '@bedo/contracts/openapi';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationEnv, query, setupIntegrationEnv, startApp } from './integration-env.js';
import { client, createUser, resetMessageLimit, type TestUser } from './messaging-helpers.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Phase 9 (D-43): each finding of the security review (docs/SECURITY-REVIEW-PHASE-9.md) as a test that failed before
 * its fix.
 */
describe.runIf(enabled)('Phase 9 security review findings (real Postgres, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  const users: TestUser[] = [];
  let owner: TestUser;
  let member: TestUser;
  let mallory: TestUser;
  let outsider: TestUser;
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
    owner = await newUser('Owen Owner');
    member = await newUser('Mina Member');
    mallory = await newUser('Mallory Curious');
    outsider = await newUser('Otis Outside');
    await query(ctx.ownerUrl, 'insert into app.user_permissions (user_id, create_channels) values ($1, true)', [owner.id]);
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

  it('1. a forwarded poll is a copy: its voters, votes and closing never reach the original; open quizzes stay put', async () => {
    const group = (await api(owner).post('/v1/groups', { title: 'Private class', memberIds: [member.id, mallory.id] })).body;
    await api(owner).patch(`/v1/groups/${group.id}/settings`, { hideMemberList: true });
    const mine = (await api(mallory).post('/v1/groups', { title: 'Mine', memberIds: [] })).body;
    // An open quiz cannot be forwarded (a copy would show its answer); once closed (answer public) it can.
    const quiz = await api(owner).post(`/v1/chats/${group.id}/messages`, {
      clientId: randomUUID(),
      poll: { question: 'Quiz: 2 + 2?', options: ['3', '4'], kind: 'quiz', correctOption: 1, anonymous: false, explanation: 'Arithmetic' },
    });
    const forwardQuiz = () => api(mallory).post('/v1/messages/forward', { fromChatId: group.id, messageIds: [quiz.body.id], targets: [{ chatId: mine.id, clientId: randomUUID() }] });
    expect((await forwardQuiz()).status).toBe(400);
    await api(owner).post(`/v1/messages/${quiz.body.id}/poll/close`);
    expect((await forwardQuiz()).status).toBe(200);

    const poll = await api(owner).post(`/v1/chats/${group.id}/messages`, {
      clientId: randomUUID(),
      poll: { question: 'Trip on Friday?', options: ['No', 'Yes'], anonymous: false },
    });
    await api(member).post(`/v1/messages/${poll.body.id}/poll/vote`, { options: [1] });
    expect((await api(mallory).get(`/v1/messages/${poll.body.id}/poll/voters`)).body.error.code).toBe('NOT_ALLOWED');
    // Mallory forwards it to a group of her own, where she is the owner.
    const forwarded = await api(mallory).post('/v1/messages/forward', { fromChatId: group.id, messageIds: [poll.body.id], targets: [{ chatId: mine.id, clientId: randomUUID() }] });
    const copy = forwarded.body.messages[0];
    expect(copy.poll).toMatchObject({ question: 'Trip on Friday?', totalVoters: null, myVotes: null, closed: false });
    expect(copy.poll.id).not.toBe(poll.body.poll.id);
    // The copy's voters are only the copy's own (none); closing the copy leaves the original open and secret.
    expect((await api(mallory).get(`/v1/messages/${copy.id}/poll/voters`)).body.options).toEqual([{ voters: [] }, { voters: [] }]);
    expect((await api(mallory).post(`/v1/messages/${copy.id}/poll/close`)).status).toBe(200);
    const original = (await api(mallory).get(`/v1/chats/${group.id}/messages`)).body.messages.find((message: { id: string }) => message.id === poll.body.id);
    expect(original.poll).toMatchObject({ closed: false, totalVoters: null });
    // Votes on the copy do not count on the original.
    const fresh = await api(mallory).post('/v1/messages/forward', { fromChatId: group.id, messageIds: [poll.body.id], targets: [{ chatId: mine.id, clientId: randomUUID() }] });
    await api(mallory).post(`/v1/messages/${fresh.body.messages[0].id}/poll/vote`, { options: [0] });
    expect((await query(ctx.ownerUrl, 'select count(*)::int as n from app.poll_votes where poll_id = $1', [poll.body.poll.id])).rows[0]!.n).toBe(1);
  });

  it('2. changing a member answers the same whether or not the person is in the group, for someone without the right', async () => {
    const group = (await api(owner).post('/v1/groups', { title: 'Hidden list', memberIds: [member.id, mallory.id] })).body;
    await api(owner).patch(`/v1/groups/${group.id}/settings`, { hideMemberList: true });
    const inGroup = await api(mallory).patch(`/v1/groups/${group.id}/members/${member.id}`, { role: 'admin' });
    const notInGroup = await api(mallory).patch(`/v1/groups/${group.id}/members/${outsider.id}`, { role: 'admin' });
    const restrictIn = await api(mallory).patch(`/v1/groups/${group.id}/members/${member.id}`, { deniedPermissions: ['send_messages'] });
    const restrictOut = await api(mallory).patch(`/v1/groups/${group.id}/members/${outsider.id}`, { deniedPermissions: ['send_messages'] });
    for (const answer of [inGroup, notInGroup, restrictIn, restrictOut]) {
      expect(answer.status).toBe(403);
      expect(answer.body.error.code).toBe('NOT_ALLOWED');
    }
    // A channel subscriber the same.
    const channel = (await api(owner).post('/v1/channels', { title: 'Probe channel', isPublic: true })).body;
    for (const user of [member, mallory]) await api(user).post(`/v1/channels/${channel.id}/join`);
    const subscribed = await api(mallory).patch(`/v1/groups/${channel.id}/members/${member.id}`, { role: 'admin' });
    const notSubscribed = await api(mallory).patch(`/v1/groups/${channel.id}/members/${outsider.id}`, { role: 'admin' });
    expect([subscribed.status, notSubscribed.status]).toEqual([403, 403]);
    // Adding people does not tell a member who was already in a group with a hidden list.
    const already = await api(mallory).post(`/v1/groups/${group.id}/members`, { userIds: [member.id, outsider.id] });
    expect(already.body).toEqual({ added: [member.id, outsider.id], notAdded: [] });
  });

  it('3. reports cannot find out who posted in a channel, and every attempt counts', async () => {
    const channel = (await api(owner).post('/v1/channels', { title: 'Anonymous posts', isPublic: true })).body;
    await api(mallory).post(`/v1/channels/${channel.id}/join`);
    const post = await api(owner).send(channel.id, 'Who wrote this?');
    const right = await api(mallory).post('/v1/reports', { userId: owner.id, messageId: post.body.id, reason: 'other' });
    const wrong = await api(mallory).post('/v1/reports', { userId: outsider.id, messageId: post.body.id, reason: 'other' });
    const asChannel = await api(mallory).post('/v1/reports', { userId: channel.id, messageId: post.body.id, reason: 'other' });
    expect([right.status, wrong.status, asChannel.status]).toEqual([200, 200, 200]);
    // Every report names the real author for the admins who review them.
    const stored = await query(ctx.ownerUrl, 'select reported_user_id from app.reports where message_id = $1', [post.body.id]);
    expect(new Set(stored.rows.map((row) => row.reported_user_id))).toEqual(new Set([owner.id]));
    // Wrong guesses elsewhere still cost: the daily limit is taken first.
    await query(ctx.ownerUrl, `delete from app.rate_counters where key like 'rl:reports:%'`);
    const dm = await api(member).openChat(mallory);
    const message = await api(member).send(dm.id, 'hello');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await api(mallory).post('/v1/reports', { userId: outsider.id, messageId: message.body.id, reason: 'spam' })).status).toBe(404);
    }
    expect((await api(mallory).post('/v1/reports', { userId: member.id, messageId: message.body.id, reason: 'spam' })).status).toBe(429);
  });

  it('4. blocking a channel admin does not silence only their posts (which would reveal them)', async () => {
    const endpoint = `https://fcm.googleapis.com/fcm/send/hardening-${mallory.id}`;
    await api(mallory).put('/v1/me/push-subscription', { endpoint, keys: { p256dh: 'p', auth: 'a' } });
    const channel = (await api(owner).post('/v1/channels', { title: 'Block test', isPublic: true })).body;
    await api(mallory).post(`/v1/channels/${channel.id}/join`);
    await api(mallory).post(`/v1/users/${owner.id}/block`);
    await ctx.push.all();
    ctx.push.clear();
    await api(owner).send(channel.id, 'Still delivered');
    const pushes = (await ctx.push.all()).filter((push) => push.endpoint === endpoint);
    expect(pushes.map((push) => push.payload.body)).toEqual(['Still delivered']);
    await api(mallory).del(`/v1/users/${owner.id}/block`);
  });

  it('5. someone removed cannot come back on their own, until an admin adds them again', async () => {
    const group = (await api(owner).post('/v1/groups', { title: 'Removal', memberIds: [mallory.id] })).body;
    const link = (await api(owner).post(`/v1/groups/${group.id}/invites`, {})).body;
    expect((await api(owner).del(`/v1/groups/${group.id}/members/${mallory.id}`)).status).toBe(200);
    expect((await api(mallory).post(`/v1/invites/${link.code}/join`)).body.error.code).toBe('NOT_ALLOWED');
    const approvalLink = (await api(owner).post(`/v1/groups/${group.id}/invites`, { requiresApproval: true })).body;
    expect((await api(mallory).post(`/v1/invites/${approvalLink.code}/join`)).body.error.code).toBe('NOT_ALLOWED');
    const channel = (await api(owner).post('/v1/channels', { title: 'Removal channel', isPublic: true })).body;
    await api(mallory).post(`/v1/channels/${channel.id}/join`);
    await api(owner).del(`/v1/groups/${channel.id}/members/${mallory.id}`);
    expect((await api(mallory).post(`/v1/channels/${channel.id}/join`)).body.error.code).toBe('NOT_ALLOWED');
    // A member who may add people cannot undo the removal; a pending request of hers was declined.
    const helper = (await api(owner).post(`/v1/groups/${group.id}/members`, { userIds: [member.id] })).body;
    expect(helper.added).toEqual([member.id]);
    // (The group shows its list to members, so Mina is told the truth: not added.)
    expect((await api(member).post(`/v1/groups/${group.id}/members`, { userIds: [mallory.id] })).body).toEqual({ added: [], notAdded: [mallory.id] });
    await api(owner).patch(`/v1/groups/${group.id}/settings`, { hideMemberList: true });
    // With the list hidden she is not told who was removed either.
    expect((await api(member).post(`/v1/groups/${group.id}/members`, { userIds: [mallory.id] })).body).toEqual({ added: [mallory.id], notAdded: [] });
    expect((await query(ctx.ownerUrl, 'select count(*)::int as n from app.chat_bans where conversation_id = $1', [group.id])).rows[0]!.n).toBe(1);
    const late = (await api(owner).post('/v1/groups', { title: 'Late request', memberIds: [mallory.id] })).body;
    const lateLink = (await api(owner).post(`/v1/groups/${late.id}/invites`, { requiresApproval: true })).body;
    await api(outsider).post(`/v1/invites/${lateLink.code}/join`);
    await api(owner).post(`/v1/groups/${late.id}/members`, { userIds: [outsider.id] });
    await api(owner).del(`/v1/groups/${late.id}/members/${outsider.id}`);
    expect((await query(ctx.ownerUrl, `select status from app.join_requests where conversation_id = $1 and user_id = $2`, [late.id, outsider.id])).rows.map((row) => row.status)).not.toContain('pending');
    // The owner adds her back: the ban is lifted.
    expect((await api(owner).post(`/v1/groups/${group.id}/members`, { userIds: [mallory.id] })).body.added).toEqual([mallory.id]);
    expect((await query(ctx.ownerUrl, 'select count(*)::int as n from app.chat_bans where conversation_id = $1', [group.id])).rows[0]!.n).toBe(0);
  });

  it('6. retrying a send after being removed shows nothing', async () => {
    const group = (await api(owner).post('/v1/groups', { title: 'Retry', memberIds: [member.id] })).body;
    const clientId = randomUUID();
    expect((await api(member).post(`/v1/chats/${group.id}/messages`, { clientId, text: 'mine' })).status).toBe(200);
    await api(owner).del(`/v1/groups/${group.id}/members/${member.id}`);
    expect((await api(member).post(`/v1/chats/${group.id}/messages`, { clientId, text: 'mine' })).status).toBe(404);
    // A forward retry the same.
    const other = (await api(owner).post('/v1/groups', { title: 'Retry forward', memberIds: [mallory.id] })).body;
    const dm = await api(mallory).openChat(owner);
    const note = await api(mallory).send(dm.id, 'note');
    const target = { chatId: other.id, clientId: randomUUID() };
    expect((await api(mallory).post('/v1/messages/forward', { fromChatId: dm.id, messageIds: [note.body.id], targets: [target] })).status).toBe(200);
    await api(owner).del(`/v1/groups/${other.id}/members/${mallory.id}`);
    expect((await api(mallory).post('/v1/messages/forward', { fromChatId: dm.id, messageIds: [note.body.id], targets: [target] })).status).toBe(404);
  });

  it('7. a reaction in a channel reaches the reactor and the staff, not every subscriber', async () => {
    const channel = (await api(owner).post('/v1/channels', { title: 'Fan-out', isPublic: true })).body;
    for (const user of [member, mallory, outsider]) await api(user).post(`/v1/channels/${channel.id}/join`);
    const post = await api(owner).send(channel.id, 'React to me');
    await api(member).put(`/v1/messages/${post.body.id}/reaction`, { emoji: '👍' });
    const entries = await query(ctx.ownerUrl, `select user_id from app.update_log where kind = 'message.reactions' and message_id = $1`, [post.body.id]);
    expect(new Set(entries.rows.map((row) => row.user_id))).toEqual(new Set([member.id, owner.id]));
    // A poll vote the same.
    const poll = await api(owner).post(`/v1/chats/${channel.id}/messages`, { clientId: randomUUID(), poll: { question: 'Vote?', options: ['A', 'B'] } });
    await api(mallory).post(`/v1/messages/${poll.body.id}/poll/vote`, { options: [0] });
    const votes = await query(ctx.ownerUrl, `select user_id from app.update_log where kind = 'message.poll' and message_id = $1`, [poll.body.id]);
    expect(new Set(votes.rows.map((row) => row.user_id))).toEqual(new Set([mallory.id, owner.id]));
    // Everyone still sees the counts when they load the post.
    const seen = (await api(outsider).get(`/v1/chats/${channel.id}/messages`)).body.messages.find((message: { id: string }) => message.id === post.body.id);
    expect(seen.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
  });

  it('8. limits on actions that had none', async () => {
    let status = 0;
    for (let attempt = 0; attempt < 121 && status !== 429; attempt += 1) {
      status = (await api(member).post('/v1/realtime/viewing', { chatId: null })).status;
    }
    expect(status).toBe(429);
    status = 0;
    for (let attempt = 0; attempt < 121 && status !== 429; attempt += 1) {
      status = (await api(member).get(`/v1/users/${owner.id}`)).status;
    }
    expect(status).toBe(429);
  });

  it('9. every route that needs a signed-in user refuses requests without a valid token, and admin routes refuse user tokens', async () => {
    const document = buildOpenApiDocument({ version: 'test' });
    const fill = (path: string) => path.replace(/\{code\}/g, 'A'.repeat(22)).replace(/\{[a-zA-Z]+\}/g, randomUUID());
    const tampered = `${member.token.slice(0, -2)}${member.token.endsWith('A') ? 'BB' : 'AA'}`;
    const [header, payload] = member.token.split('.');
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${payload}.`;
    const failures: string[] = [];
    let checked = 0;
    for (const [path, operations] of Object.entries(document.paths ?? {})) {
      for (const [method, operation] of Object.entries(operations as Record<string, { security?: Array<Record<string, string[]>> }>)) {
        const security = operation.security ?? [];
        const url = fill(path);
        const call = (headers: Record<string, string>) =>
          app.inject({ method: method.toUpperCase() as 'GET', url, headers, ...(method === 'get' || method === 'delete' ? {} : { payload: {} }) });
        if (security.some((entry) => 'bearerAuth' in entry)) {
          checked += 1;
          for (const [label, headers] of [
            ['no token', {}],
            ['tampered token', { authorization: `Bearer ${tampered}` }],
            ['unsigned token', { authorization: `Bearer ${unsigned}` }],
            ['wrong scheme', { authorization: `Basic ${member.token}` }],
          ] as const) {
            const status = (await call(headers)).statusCode;
            if (status !== 401) failures.push(`${method.toUpperCase()} ${path} with ${label}: ${status}`);
          }
        }
        if (security.some((entry) => 'adminSession' in entry)) {
          checked += 1;
          const status = (await call({ authorization: `Bearer ${member.token}`, origin: 'http://localhost', 'x-bedo-csrf': '1' })).statusCode;
          if (status !== 401 && status !== 403) failures.push(`${method.toUpperCase()} ${path} with a user token: ${status}`);
        }
        if (security.some((entry) => 'dispatchHeader' in entry)) {
          checked += 1;
          const status = (await call({ authorization: `Bearer ${member.token}` })).statusCode;
          if (status !== 404) failures.push(`${method.toUpperCase()} ${path} without the dispatch token: ${status}`);
        }
      }
    }
    expect(header).toBeTruthy();
    expect(checked).toBeGreaterThan(100);
    expect(failures).toEqual([]);
  });
});
