import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { defaultMigrationsDir } from '@bedo/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TopicsSchemaService } from '../src/messaging/topics-schema.service.js';
import { FakeMediaStorage, type IntegrationEnv, query, setupIntegrationEnv, startApp } from './integration-env.js';
import { client, createUser, resetMessageLimit, type TestUser } from './messaging-helpers.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

type Api = ReturnType<typeof client>;
interface Msg {
  id: string;
  seq: number;
  topicId: string | null;
  text: string | null;
}

/** The last migration before topics (the live database until the owner runs update 20261115130000). */
const BEFORE_TOPICS = '20261115125959';
const TOPICS_MIGRATION = '20261115130000_group_topics.sql';

function usersSetup() {
  const state = {} as { ctx: IntegrationEnv; app: NestFastifyApplication; api: (user: TestUser) => Api; users: TestUser[] };
  const newUser = async (name: string) => {
    const user = await createUser(state.ctx, state.app, name);
    state.users.push(user);
    return user;
  };
  const resetLimits = async () => {
    for (const user of state.users) {
      await resetMessageLimit(state.ctx, user.id);
      await query(state.ctx.ownerUrl, 'delete from app.rate_counters where key like $1', [`rl:%:${user.id}`]);
    }
  };
  return { state, newUser, resetLimits };
}

describe.runIf(enabled)('D-63 topics in groups (real Postgres, runtime role)', () => {
  const { state, newUser, resetLimits } = usersSetup();
  let owner: TestUser;
  let admin: TestUser;
  let plainAdmin: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  const api = (user: TestUser) => state.api(user);

  beforeAll(async () => {
    state.users = [];
    state.ctx = await setupIntegrationEnv();
    state.app = await startApp(state.ctx.env, undefined, { storage: new FakeMediaStorage() });
    state.api = (user) => client(state.app, user);
    owner = await newUser('Tina Owner');
    admin = await newUser('Theo Admin');
    plainAdmin = await newUser('Pia Admin');
    member = await newUser('Max Member');
    outsider = await newUser('Ola Outsider');
  });

  afterAll(async () => {
    await state.app?.close();
    await state.ctx?.teardown();
  });

  beforeEach(resetLimits);

  /** A group with Theo as admin with change_info, Pia as admin without it, and Max as member. */
  async function newGroup(title: string): Promise<string> {
    const created = await api(owner).post('/v1/groups', { title, memberIds: [admin.id, plainAdmin.id, member.id] });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = created.body.id as string;
    expect((await api(owner).patch(`/v1/groups/${id}/members/${admin.id}`, { role: 'admin', adminRights: ['change_info', 'pin_messages'] })).status).toBe(200);
    expect((await api(owner).patch(`/v1/groups/${id}/members/${plainAdmin.id}`, { role: 'admin', adminRights: ['delete_messages'] })).status).toBe(200);
    return id;
  }

  async function groupWithTopics(title: string): Promise<{ id: string; a: string; b: string }> {
    const id = await newGroup(title);
    expect((await api(owner).patch(`/v1/groups/${id}/topics`, { enabled: true })).status).toBe(200);
    const a = await api(owner).post(`/v1/groups/${id}/topics`, { title: 'Homework', color: 2 });
    const b = await api(owner).post(`/v1/groups/${id}/topics`, { title: 'Exams' });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    return { id, a: a.body.id as string, b: b.body.id as string };
  }

  it('is off by default: no topics, nothing changes for members, and topicId is refused', async () => {
    const id = await newGroup('Default off');
    const chat = await api(member).get(`/v1/chats/${id}`);
    expect(chat.body.group.topicsEnabled).toBe(false);
    expect((await api(member).get(`/v1/groups/${id}/topics`)).body).toEqual({ available: true, enabled: false, canManage: false, topics: [] });
    expect((await api(owner).get(`/v1/groups/${id}/topics`)).body).toEqual({ available: true, enabled: false, canManage: true, topics: [] });
    // Creating a topic needs topics on; naming a topic in a message too.
    expect((await api(owner).post(`/v1/groups/${id}/topics`, { title: 'Too early' })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await api(member).send(id, 'hello', { topicId: randomUUID() })).body.error.code).toBe('VALIDATION_FAILED');
    const sent = await api(member).send(id, 'hello');
    expect(sent.status).toBe(200);
    expect(sent.body.topicId).toBeNull();
    // No row is written for a group that never turned topics on.
    expect((await query(state.ctx.ownerUrl, 'select count(*)::int as n from app.group_topic_settings where conversation_id = $1', [id])).rows[0]!.n).toBe(0);
  });

  it('lets only the owner and admins with change_info turn topics on and manage them', async () => {
    const id = await newGroup('Who manages');
    // A member, an admin without change_info, and even a member holding the change_info permission may not.
    await api(owner).patch(`/v1/groups/${id}/settings`, { defaultPermissions: ['send_messages', 'change_info'] });
    expect((await api(member).patch(`/v1/groups/${id}/topics`, { enabled: true })).body.error.code).toBe('NOT_ALLOWED');
    expect((await api(plainAdmin).patch(`/v1/groups/${id}/topics`, { enabled: true })).body.error.code).toBe('NOT_ALLOWED');
    expect((await api(outsider).patch(`/v1/groups/${id}/topics`, { enabled: true })).status).toBe(404);
    const since = (await api(member).post('/v1/realtime/heartbeat')).body.seq as number;
    const on = await api(admin).patch(`/v1/groups/${id}/topics`, { enabled: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ available: true, enabled: true, canManage: true });
    // Every member's devices hear of it and see topicsEnabled.
    const sync = await api(member).get(`/v1/sync?since=${since}`);
    expect(sync.body.updates.some((update: { kind: string; chatId: string }) => update.kind === 'chat.info' && update.chatId === id)).toBe(true);
    expect(sync.body.chats.find((chat: { id: string }) => chat.id === id).group.topicsEnabled).toBe(true);
    expect((await api(member).get('/v1/chats')).body.chats.find((chat: { id: string }) => chat.id === id).group.topicsEnabled).toBe(true);

    const created = await api(admin).post(`/v1/groups/${id}/topics`, { title: '  Lab reports  ', color: 4 });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({ chatId: id, title: 'Lab reports', color: 4, closed: false, lastMessageAt: null, messageCount: 0 });
    const topicId = created.body.id as string;
    for (const user of [member, plainAdmin]) {
      expect((await api(user).post(`/v1/groups/${id}/topics`, { title: 'Mine' })).body.error.code).toBe('NOT_ALLOWED');
      expect((await api(user).patch(`/v1/groups/${id}/topics/${topicId}`, { title: 'Renamed' })).body.error.code).toBe('NOT_ALLOWED');
      expect((await api(user).post(`/v1/groups/${id}/topics/${topicId}/close`)).body.error.code).toBe('NOT_ALLOWED');
    }
    expect((await api(owner).post(`/v1/groups/${id}/topics`, { title: '' })).status).toBe(400);
    expect((await api(owner).post(`/v1/groups/${id}/topics`, { title: 'x'.repeat(129) })).status).toBe(400);
    expect((await api(owner).post(`/v1/groups/${id}/topics`, { title: 'Colour', color: 7 })).status).toBe(400);
    expect((await api(owner).patch(`/v1/groups/${id}/topics/${topicId}`, { title: 'Lab work', color: 1 })).body).toMatchObject({ title: 'Lab work', color: 1 });
    expect((await api(owner).post(`/v1/groups/${id}/topics/${topicId}/close`)).body.closed).toBe(true);
    expect((await api(admin).post(`/v1/groups/${id}/topics/${topicId}/reopen`)).body.closed).toBe(false);
    expect((await api(owner).patch(`/v1/groups/${id}/topics/${randomUUID()}`, { title: 'Nope' })).status).toBe(404);
    // Members see the topics too.
    const list = await api(member).get(`/v1/groups/${id}/topics`);
    expect(list.body).toMatchObject({ enabled: true, canManage: false, topics: [{ id: topicId, title: 'Lab work', closed: false }] });

    // Off again: the topics stay (data kept), the group shows no topics.
    expect((await api(owner).patch(`/v1/groups/${id}/topics`, { enabled: false })).body).toMatchObject({ enabled: false, topics: [{ id: topicId }] });
    expect((await api(member).get(`/v1/chats/${id}`)).body.group.topicsEnabled).toBe(false);
    const settings = await query(state.ctx.ownerUrl, 'select enabled, updated_by from app.group_topic_settings where conversation_id = $1', [id]);
    expect(settings.rows).toEqual([{ enabled: false, updated_by: owner.id }]);
  });

  it('posts into topics, filters the history by topic or General, and pages it with the seq cursor', async () => {
    const { id, a, b } = await groupWithTopics('Posting');
    const general = await api(member).send(id, 'general one');
    expect(general.body.topicId).toBeNull();
    const inA: Msg[] = [];
    for (let index = 0; index < 55; index += 1) {
      if (index % 25 === 0) await resetLimits();
      const sent = await api(index % 2 ? owner : member).send(id, `homework ${index}`, { topicId: a });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      expect(sent.body.topicId).toBe(a);
      inA.push(sent.body as Msg);
      if (index === 10) await api(member).send(id, 'exam question', { topicId: b });
      if (index === 20) await api(member).send(id, 'general two');
    }
    // Newest page of topic A, oldest first, then the rest with before=.
    const first = await api(member).get(`/v1/chats/${id}/messages?topicId=${a}&limit=50`);
    expect(first.status).toBe(200);
    const firstPage = first.body.messages as Msg[];
    expect(firstPage.map((message) => message.id)).toEqual(inA.slice(5).map((message) => message.id));
    expect(firstPage.every((message) => message.topicId === a)).toBe(true);
    const older = await api(member).get(`/v1/chats/${id}/messages?topicId=${a}&limit=50&before=${firstPage[0]!.seq}`);
    expect((older.body.messages as Msg[]).map((message) => message.id)).toEqual(inA.slice(0, 5).map((message) => message.id));
    expect((await api(member).get(`/v1/chats/${id}/messages?topicId=${a}&before=${inA[0]!.seq}`)).body.messages).toEqual([]);
    const newer = await api(member).get(`/v1/chats/${id}/messages?topicId=${a}&after=${inA[52]!.seq}`);
    expect((newer.body.messages as Msg[]).map((message) => message.id)).toEqual(inA.slice(53).map((message) => message.id));
    // General: only messages without a topic; B: only B's.
    const generalPage = (await api(member).get(`/v1/chats/${id}/messages?topicId=general`)).body.messages as Msg[];
    expect(generalPage.map((message) => message.text)).toEqual(expect.arrayContaining(['general one', 'general two']));
    expect(generalPage.every((message) => message.topicId === null)).toBe(true);
    expect(((await api(member).get(`/v1/chats/${id}/messages?topicId=${b}`)).body.messages as Msg[]).map((message) => message.text)).toEqual(['exam question']);
    // Without a filter: everything, each with its topic.
    const all = (await api(member).get(`/v1/chats/${id}/messages?limit=50`)).body.messages as Msg[];
    expect(new Set(all.map((message) => message.topicId))).toEqual(new Set([a, b, null]));
    // A topic of another group, or not a topic at all.
    const other = await groupWithTopics('Other');
    expect((await api(member).get(`/v1/chats/${id}/messages?topicId=${other.a}`)).status).toBe(404);
    expect((await api(member).get(`/v1/chats/${id}/messages?topicId=nonsense`)).status).toBe(400);
    // The topic list: last message time and count.
    const topics = (await api(member).get(`/v1/groups/${id}/topics`)).body.topics as Array<{ id: string; messageCount: number; lastMessageAt: string }>;
    expect(topics.find((topic) => topic.id === a)).toMatchObject({ messageCount: 55, lastMessageAt: (inA[54] as unknown as { createdAt: string }).createdAt });
    expect(topics.find((topic) => topic.id === b)).toMatchObject({ messageCount: 1 });
    // Unread counts stay per group: the topic messages count for the member who has not read them.
    const forAdmin = (await api(plainAdmin).get(`/v1/chats/${id}`)).body;
    expect(forAdmin.unreadCount).toBe(58);
    // Search and pins carry the topic.
    expect(((await api(member).get(`/v1/chats/${id}/search?q=exam`)).body.messages as Msg[])[0]!.topicId).toBe(b);
    expect((await api(admin).put(`/v1/messages/${inA[3]!.id}/pin`)).body.topicId).toBe(a);
    expect(((await api(member).get(`/v1/chats/${id}/pins`)).body.messages as Msg[])[0]!.topicId).toBe(a);
    expect((await api(member).get(`/v1/chats/${id}`)).body.lastMessage.topicId).toBe(a);
  });

  it('lets only the owner and admins post in a closed topic', async () => {
    const { id, a } = await groupWithTopics('Closed');
    expect((await api(admin).post(`/v1/groups/${id}/topics/${a}/close`)).body.closed).toBe(true);
    expect((await api(member).send(id, 'still open?', { topicId: a })).body.error.code).toBe('NOT_ALLOWED');
    expect((await api(plainAdmin).send(id, 'admin note', { topicId: a })).status).toBe(200);
    const fromOwner = await api(owner).send(id, 'owner note', { topicId: a });
    expect(fromOwner.status).toBe(200);
    // A member's reply to a message in the closed topic would go into it: refused as well.
    expect((await api(member).send(id, 'reply', { replyToId: fromOwner.body.id })).body.error.code).toBe('NOT_ALLOWED');
    // General stays open.
    expect((await api(member).send(id, 'in general')).status).toBe(200);
    await api(admin).post(`/v1/groups/${id}/topics/${a}/reopen`);
    expect((await api(member).send(id, 'open again', { topicId: a })).status).toBe(200);
  });

  it('refuses topicId for another group’s topic, in channels and private chats, and while topics are off', async () => {
    const { id, a } = await groupWithTopics('Refusals');
    const other = await groupWithTopics('Elsewhere');
    expect((await api(member).send(id, 'wrong group', { topicId: other.a })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await api(member).send(id, 'unknown', { topicId: randomUUID() })).body.error.code).toBe('VALIDATION_FAILED');
    // Private chat.
    const chat = await api(member).openChat(owner);
    expect((await api(member).send(chat.id, 'private', { topicId: a })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await api(member).get(`/v1/chats/${chat.id}/messages?topicId=general`)).status).toBe(400);
    expect((await api(member).get(`/v1/groups/${chat.id}/topics`)).status).toBe(404);
    // Channel (the owner may create channels here).
    await query(state.ctx.ownerUrl, 'insert into app.user_permissions (user_id, create_channels) values ($1, true) on conflict (user_id) do update set create_channels = true', [owner.id]);
    const channel = await api(owner).post('/v1/channels', { title: 'Announcements', isPublic: false });
    expect(channel.status, JSON.stringify(channel.body)).toBe(200);
    expect(channel.body.group.topicsEnabled).toBe(false);
    expect((await api(owner).send(channel.body.id, 'post', { topicId: a })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await api(owner).patch(`/v1/groups/${channel.body.id}/topics`, { enabled: true })).status).toBe(404);
    expect((await api(owner).get(`/v1/chats/${channel.body.id}/messages?topicId=general`)).status).toBe(400);
    expect((await api(owner).send(channel.body.id, 'plain post')).status).toBe(200);
    // Off: naming a topic is refused; old messages keep theirs and the filter still reads them.
    const kept = await api(member).send(id, 'before off', { topicId: a });
    await api(owner).patch(`/v1/groups/${id}/topics`, { enabled: false });
    expect((await api(member).send(id, 'after off', { topicId: a })).body.error.code).toBe('VALIDATION_FAILED');
    const afterOff = await api(member).send(id, 'after off, in general');
    expect(afterOff.body.topicId).toBeNull();
    // A reply to a topic message while topics are off goes to General.
    expect((await api(member).send(id, 'reply while off', { replyToId: kept.body.id })).body.topicId).toBeNull();
    expect(((await api(member).get(`/v1/chats/${id}/messages?topicId=${a}`)).body.messages as Msg[]).map((message) => message.id)).toEqual([kept.body.id]);
  });

  it('keeps replies in the topic of the message they answer, and forwards to General', async () => {
    const { id, a, b } = await groupWithTopics('Replies');
    const question = await api(owner).send(id, 'question in A', { topicId: a });
    const generalMessage = await api(owner).send(id, 'question in General');
    const inherited = await api(member).send(id, 'answer', { replyToId: question.body.id });
    expect(inherited.status).toBe(200);
    expect(inherited.body).toMatchObject({ topicId: a, replyTo: { id: question.body.id } });
    expect((await api(member).send(id, 'same topic', { replyToId: question.body.id, topicId: a })).body.topicId).toBe(a);
    expect((await api(member).send(id, 'other topic', { replyToId: question.body.id, topicId: b })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await api(member).send(id, 'general reply', { replyToId: generalMessage.body.id })).body.topicId).toBeNull();
    expect((await api(member).send(id, 'into A', { replyToId: generalMessage.body.id, topicId: a })).body.error.code).toBe('VALIDATION_FAILED');
    // Forwarded copies go to General.
    const forwarded = await api(member).post('/v1/messages/forward', { fromChatId: id, messageIds: [question.body.id], targets: [{ chatId: id, clientId: randomUUID() }] });
    expect(forwarded.status, JSON.stringify(forwarded.body)).toBe(200);
    expect(forwarded.body.messages[0].topicId).toBeNull();
  });

  it('carries the topic in scheduled messages and checks it when scheduling and when sending', async () => {
    const { id, a } = await groupWithTopics('Scheduled');
    await query(state.ctx.ownerUrl, 'insert into app.user_permissions (user_id, schedule_messages) values ($1, true) on conflict (user_id) do update set schedule_messages = true', [member.id]);
    const sendAt = new Date(Date.now() + 120_000).toISOString();
    const scheduled = await api(member).post(`/v1/chats/${id}/scheduled`, { sendAt, message: { clientId: randomUUID(), text: 'later in A', topicId: a } });
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(200);
    expect(scheduled.body.topicId).toBe(a);
    expect((await api(member).get(`/v1/chats/${id}/scheduled`)).body.scheduled[0].topicId).toBe(a);
    const now = await api(member).post(`/v1/scheduled/${scheduled.body.id}/send`);
    expect(now.status, JSON.stringify(now.body)).toBe(200);
    expect(now.body).toMatchObject({ text: 'later in A', topicId: a });
    // A topic of another group is refused when scheduling; a closed topic makes the send fail.
    const other = await groupWithTopics('Scheduled elsewhere');
    expect((await api(member).post(`/v1/chats/${id}/scheduled`, { sendAt, message: { clientId: randomUUID(), text: 'x', topicId: other.a } })).body.error.code).toBe('VALIDATION_FAILED');
    const second = await api(member).post(`/v1/chats/${id}/scheduled`, { sendAt, message: { clientId: randomUUID(), text: 'later still', topicId: a } });
    await api(owner).post(`/v1/groups/${id}/topics/${a}/close`);
    expect((await api(member).post(`/v1/scheduled/${second.body.id}/send`)).body.error.code).toBe('NOT_ALLOWED');
  });
});

describe.runIf(enabled)('D-63 before the topics update is run (database without the topic tables and column)', () => {
  const { state, newUser, resetLimits } = usersSetup();
  let owner: TestUser;
  let member: TestUser;
  const api = (user: TestUser) => state.api(user);

  beforeAll(async () => {
    state.users = [];
    state.ctx = await setupIntegrationEnv({}, { migrateThrough: BEFORE_TOPICS });
    state.app = await startApp(state.ctx.env, undefined, { storage: new FakeMediaStorage() });
    state.api = (user) => client(state.app, user);
    owner = await newUser('Una Owner');
    member = await newUser('Vic Member');
  });

  afterAll(async () => {
    await state.app?.close();
    await state.ctx?.teardown();
  });

  beforeEach(resetLimits);

  it('has neither the topic tables nor messages.topic_id', async () => {
    const found = await query(
      state.ctx.ownerUrl,
      `select to_regclass('app.group_topics') as topics, to_regclass('app.group_topic_settings') as settings,
              (select count(*)::int from information_schema.columns where table_schema = 'app' and table_name = 'messages' and column_name = 'topic_id') as columns`,
    );
    expect(found.rows[0]).toEqual({ topics: null, settings: null, columns: 0 });
  });

  it('keeps every message endpoint working, and topics report unavailable', async () => {
    const group = await api(owner).post('/v1/groups', { title: 'Old database', memberIds: [member.id] });
    expect(group.status, JSON.stringify(group.body)).toBe(200);
    const id = group.body.id as string;
    expect(group.body.group.topicsEnabled).toBe(false);
    // Sending: text, a reply, a poll; editing, reacting, pinning, deleting, forwarding.
    const first = await api(member).send(id, 'hello old database');
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.topicId).toBeNull();
    const reply = await api(owner).send(id, 'a reply', { replyToId: first.body.id });
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body.replyTo.id).toBe(first.body.id);
    const poll = await api(owner).post(`/v1/chats/${id}/messages`, { clientId: randomUUID(), poll: { question: 'Works?', options: ['Yes', 'No'] } });
    expect(poll.status, JSON.stringify(poll.body)).toBe(200);
    expect((await api(member).post(`/v1/messages/${poll.body.id}/poll/vote`, { options: [0] })).status).toBe(200);
    expect((await api(member).patch(`/v1/messages/${first.body.id}`, { text: 'edited' })).body.text).toBe('edited');
    expect((await api(owner).put(`/v1/messages/${first.body.id}/reaction`, { emoji: '👍' })).status).toBe(200);
    expect((await api(owner).put(`/v1/messages/${first.body.id}/pin`)).status).toBe(200);
    expect((await api(member).get(`/v1/chats/${id}/pins`)).body.messages[0].id).toBe(first.body.id);
    const forwarded = await api(member).post('/v1/messages/forward', { fromChatId: id, messageIds: [first.body.id], targets: [{ chatId: id, clientId: randomUUID() }] });
    expect(forwarded.status, JSON.stringify(forwarded.body)).toBe(200);
    expect((await api(owner).post('/v1/messages/delete', { chatId: id, messageIds: [reply.body.id], scope: 'both' })).status).toBe(200);
    // Reading: history and its paging, the chat and the list, search in the chat and everywhere, media, sync.
    const history = await api(member).get(`/v1/chats/${id}/messages`);
    expect(history.status).toBe(200);
    expect((history.body.messages as Msg[]).length).toBe(4);
    expect((history.body.messages as Msg[]).every((message) => message.topicId === null)).toBe(true);
    expect((await api(member).get(`/v1/chats/${id}/messages?before=3&limit=1`)).body.messages).toHaveLength(1);
    expect((await api(member).get(`/v1/chats/${id}`)).body).toMatchObject({ group: { topicsEnabled: false }, lastMessage: { topicId: null } });
    expect((await api(member).get('/v1/chats')).status).toBe(200);
    expect((await api(member).get(`/v1/chats/${id}/search?q=edited`)).body.messages).toHaveLength(2);
    expect((await api(member).get('/v1/search?q=edited')).status).toBe(200);
    expect((await api(member).get(`/v1/chats/${id}/media?kind=media`)).status).toBe(200);
    const sync = await api(member).get('/v1/sync?since=0');
    expect(sync.status).toBe(200);
    expect(sync.body.messages.length).toBeGreaterThan(0);
    expect((await api(member).post(`/v1/chats/${id}/read`, { seq: 5 })).status).toBe(200);
    // Private chats as well.
    const chat = await api(member).openChat(owner);
    expect((await api(member).send(chat.id, 'private hello')).status).toBe(200);
    expect((await api(owner).get(`/v1/chats/${chat.id}/messages`)).body.messages).toHaveLength(1);
    // Scheduled messages.
    await query(state.ctx.ownerUrl, 'insert into app.user_permissions (user_id, schedule_messages) values ($1, true)', [member.id]);
    const scheduled = await api(member).post(`/v1/chats/${id}/scheduled`, { sendAt: new Date(Date.now() + 120_000).toISOString(), message: { clientId: randomUUID(), text: 'later' } });
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(200);
    expect(scheduled.body.topicId).toBeNull();
    expect((await api(member).post(`/v1/scheduled/${scheduled.body.id}/send`)).body.text).toBe('later');

    // Topics: unavailable, and nothing about them can be used.
    expect((await api(owner).get(`/v1/groups/${id}/topics`)).body).toEqual({ available: false, enabled: false, canManage: false, topics: [] });
    expect((await api(owner).patch(`/v1/groups/${id}/topics`, { enabled: true })).body.error.code).toBe('FEATURE_UNAVAILABLE');
    expect((await api(owner).post(`/v1/groups/${id}/topics`, { title: 'Nope' })).body.error.code).toBe('FEATURE_UNAVAILABLE');
    expect((await api(owner).post(`/v1/groups/${id}/topics/${randomUUID()}/close`)).body.error.code).toBe('FEATURE_UNAVAILABLE');
    expect((await api(member).send(id, 'into a topic', { topicId: randomUUID() })).body.error.code).toBe('VALIDATION_FAILED');
    expect((await api(member).get(`/v1/chats/${id}/messages?topicId=general`)).body.error.code).toBe('FEATURE_UNAVAILABLE');
  });

  it('turns topics on within a minute of the owner running the update, without a new deploy', async () => {
    const group = await api(owner).post('/v1/groups', { title: 'Updated later', memberIds: [member.id] });
    const id = group.body.id as string;
    await api(member).send(id, 'before the update');
    // The owner runs the update (the migration itself, as the update script embeds it).
    await query(state.ctx.ownerUrl, readFileSync(path.join(defaultMigrationsDir(), TOPICS_MIGRATION), 'utf8'));
    // Until this instance looks again (every minute while missing), topics stay unavailable and chats work.
    expect((await api(owner).get(`/v1/groups/${id}/topics`)).body.available).toBe(false);
    expect((await api(member).get(`/v1/chats/${id}/messages`)).status).toBe(200);
    // The next look (simulated: the cached answer expires).
    state.app.get(TopicsSchemaService).forget();
    expect((await api(owner).get(`/v1/groups/${id}/topics`)).body).toEqual({ available: true, enabled: false, canManage: true, topics: [] });
    expect((await api(owner).patch(`/v1/groups/${id}/topics`, { enabled: true })).status).toBe(200);
    const topic = await api(owner).post(`/v1/groups/${id}/topics`, { title: 'New topic' });
    const sent = await api(member).send(id, 'in the new topic', { topicId: topic.body.id });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.topicId).toBe(topic.body.id);
    const history = (await api(member).get(`/v1/chats/${id}/messages`)).body.messages as Msg[];
    expect(history.map((message) => message.topicId)).toEqual([null, topic.body.id]);
  });
});
