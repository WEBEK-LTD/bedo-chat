import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeMediaStorage, type IntegrationEnv, query, setupIntegrationEnv, startApp } from './integration-env.js';
import { client, createUser, resetMessageLimit, type TestUser } from './messaging-helpers.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
/** Every suite can be run against a database without the comment tables; this one then tests only that case. */
const tablesDropped = process.env.BEDO_TEST_WITHOUT_CHANNEL_COMMENTS === '1';

type Api = ReturnType<typeof client>;

interface Harness {
  ctx: IntegrationEnv;
  app: NestFastifyApplication;
  api: (user: TestUser) => Api;
  users: TestUser[];
  newUser: (name: string) => Promise<TestUser>;
  newChannel: (owner: TestUser, title: string) => Promise<{ id: string; group: Record<string, unknown> }>;
  resetLimits: () => Promise<void>;
}

async function harness(options: { withoutChannelComments?: boolean } = {}): Promise<Harness> {
  const ctx = await setupIntegrationEnv({}, options);
  const app = await startApp(ctx.env, undefined, { storage: new FakeMediaStorage() });
  const users: TestUser[] = [];
  const api = (user: TestUser) => client(app, user);
  return {
    ctx,
    app,
    api,
    users,
    async newUser(name) {
      const user = await createUser(ctx, app, name);
      users.push(user);
      return user;
    },
    async newChannel(owner, title) {
      await query(
        ctx.ownerUrl,
        `insert into app.user_permissions (user_id, create_channels) values ($1, true) on conflict (user_id) do update set create_channels = true`,
        [owner.id],
      );
      const created = await api(owner).post('/v1/channels', { title, isPublic: true });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      return created.body as { id: string; group: Record<string, unknown> };
    },
    async resetLimits() {
      for (const user of users) {
        await resetMessageLimit(ctx, user.id);
        await query(ctx.ownerUrl, 'delete from app.rate_counters where key like $1', [`rl:%:${user.id}`]);
      }
    },
  };
}

const count = async (url: string, sql: string, params: unknown[] = []) => Number((await query<{ n: number }>(url, sql, params)).rows[0]!.n);

describe.runIf(enabled && !tablesDropped)('comments on channel posts (real Postgres, runtime role)', () => {
  let h: Harness;
  let owner: TestUser;
  let editor: TestUser;
  let moderator: TestUser;
  let reader: TestUser;
  let other: TestUser;
  let outsider: TestUser;
  let api: (user: TestUser) => Api;

  beforeAll(async () => {
    h = await harness();
    api = h.api;
    owner = await h.newUser('Olga Owner');
    editor = await h.newUser('Eddie Editor');
    moderator = await h.newUser('Mona Moderator');
    reader = await h.newUser('Rita Reader');
    other = await h.newUser('Omar Other');
    outsider = await h.newUser('Otto Outsider');
  });

  afterAll(async () => {
    await h?.app.close();
    await h?.ctx.teardown();
  });

  beforeEach(async () => {
    await h.resetLimits();
  });

  /** A channel everyone but the outsider joined: the editor may change info, the moderator may delete messages. */
  async function setup(title: string) {
    const channel = await h.newChannel(owner, title);
    for (const user of [editor, moderator, reader, other]) {
      expect((await api(user).post(`/v1/channels/${channel.id}/join`)).status).toBe(200);
    }
    expect((await api(owner).patch(`/v1/groups/${channel.id}/members/${editor.id}`, { role: 'admin', adminRights: ['change_info'] })).status).toBe(200);
    expect((await api(owner).patch(`/v1/groups/${channel.id}/members/${moderator.id}`, { role: 'admin', adminRights: ['delete_messages', 'pin_messages'] })).status).toBe(200);
    const post = await api(owner).send(channel.id, 'Exams start on Monday');
    expect(post.status).toBe(200);
    return { channelId: channel.id, postId: post.body.id as string };
  }

  const comment = (user: TestUser, postId: string, text: string, extra: Record<string, unknown> = {}) =>
    api(user).post(`/v1/messages/${postId}/comments`, { clientId: randomUUID(), text, ...extra });
  const turn = (user: TestUser, channelId: string, on: boolean) => api(user).put(`/v1/channels/${channelId}/comments`, { enabled: on });
  const postView = async (user: TestUser, channelId: string, postId: string) =>
    ((await api(user).get(`/v1/chats/${channelId}/messages`)).body.messages as Array<{ id: string; commentCount: number | null }>).find((message) => message.id === postId)!;

  it('is off in every channel by default: no count, no comments', async () => {
    const { channelId, postId } = await setup('Off by default');
    expect((await api(reader).get(`/v1/chats/${channelId}`)).body.group.commentsEnabled).toBe(false);
    expect((await api(owner).get(`/v1/chats/${channelId}`)).body.group.commentsEnabled).toBe(false);
    expect((await postView(reader, channelId, postId)).commentCount).toBeNull();
    expect((await api(reader).get(`/v1/messages/${postId}/comments`)).body.error.code).toBe('NOT_ALLOWED');
    expect((await comment(reader, postId, 'first!')).body.error.code).toBe('NOT_ALLOWED');
    expect(await count(h.ctx.ownerUrl, 'select count(*)::int as n from app.channel_comment_settings where conversation_id = $1', [channelId])).toBe(0);
    // Groups and private chats never have comments.
    const group = await api(owner).post('/v1/groups', { title: 'A group', memberIds: [reader.id] });
    expect(group.body.group.commentsEnabled).toBeNull();
    const sent = await api(owner).send(group.body.id, 'hello group');
    expect(sent.body.commentCount).toBeNull();
    expect((await turn(owner, group.body.id, true)).status).toBe(400);
    expect((await api(reader).get(`/v1/messages/${sent.body.id}/comments`)).status).toBe(404);
    const dm = await api(owner).openChat(reader);
    expect(dm.group).toBeNull();
  });

  it('lets only the owner and admins who may change the info turn comments on or off', async () => {
    const { channelId } = await setup('Who may switch');
    expect((await turn(reader, channelId, true)).body.error.code).toBe('NOT_ALLOWED');
    expect((await turn(moderator, channelId, true)).body.error.code).toBe('NOT_ALLOWED');
    expect((await turn(outsider, channelId, true)).status).toBe(404);
    const before = await count(h.ctx.ownerUrl, `select count(*)::int as n from app.update_log where user_id = $1 and kind = 'chat.info' and conversation_id = $2`, [reader.id, channelId]);
    const on = await turn(editor, channelId, true);
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.group.commentsEnabled).toBe(true);
    expect((await api(reader).get(`/v1/chats/${channelId}`)).body.group.commentsEnabled).toBe(true);
    // Members' devices hear that the channel changed (once per real change).
    expect((await turn(owner, channelId, true)).status).toBe(200);
    expect(await count(h.ctx.ownerUrl, `select count(*)::int as n from app.update_log where user_id = $1 and kind = 'chat.info' and conversation_id = $2`, [reader.id, channelId])).toBe(before + 1);
    const row = (await query(h.ctx.ownerUrl, 'select enabled, updated_by from app.channel_comment_settings where conversation_id = $1', [channelId])).rows[0];
    expect(row).toEqual({ enabled: true, updated_by: editor.id });
    expect((await turn(owner, channelId, false)).body.group.commentsEnabled).toBe(false);
    // The chat list shows it as well.
    const listed = (await api(reader).get('/v1/chats')).body.chats.find((chat: { id: string }) => chat.id === channelId);
    expect(listed.group.commentsEnabled).toBe(false);
  });

  it('lets subscribers comment and reply while comments are on, counts them on the post, and stores nothing twice', async () => {
    const { channelId, postId } = await setup('Comments on');
    const second = await api(owner).send(channelId, 'Second post');
    expect((await turn(owner, channelId, true)).status).toBe(200);
    expect((await postView(reader, channelId, postId)).commentCount).toBe(0);

    const updatesBefore = await count(h.ctx.ownerUrl, 'select count(*)::int as n from app.update_log');
    const clientId = randomUUID();
    const first = await api(reader).post(`/v1/messages/${postId}/comments`, { clientId, text: '  Good luck everyone  ' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      chatId: channelId,
      postId,
      clientId,
      text: 'Good luck everyone',
      author: { id: reader.id, displayName: 'Rita Reader', deleted: false },
      replyTo: null,
      editedAt: null,
      mine: true,
      canDelete: true,
    });
    // A retry with the same client id returns the same comment; the same id for another post is a mistake.
    expect((await api(reader).post(`/v1/messages/${postId}/comments`, { clientId, text: 'Good luck everyone' })).body.id).toBe(first.body.id);
    expect((await api(reader).post(`/v1/messages/${second.body.id}/comments`, { clientId, text: 'other' })).status).toBe(409);
    const reply = await comment(other, postId, 'Thanks!', { replyToId: first.body.id });
    expect(reply.status).toBe(200);
    expect(reply.body.replyTo).toEqual({ id: first.body.id, authorName: 'Rita Reader', text: 'Good luck everyone' });
    // A reply must be to a comment of the same post.
    expect((await comment(other, second.body.id, 'wrong post', { replyToId: first.body.id })).status).toBe(404);
    // Staff comment too; text follows the message rules.
    expect((await comment(owner, postId, 'From the owner')).status).toBe(200);
    expect((await comment(reader, postId, '   ')).status).toBe(400);
    expect((await comment(reader, postId, 'x'.repeat(4097))).status).toBe(400);
    expect((await comment(reader, postId, '😀'.repeat(4096))).status).toBe(200);
    // Not for people outside the channel, nor on posts that do not exist.
    expect((await comment(outsider, postId, 'let me in')).status).toBe(404);
    expect((await api(outsider).get(`/v1/messages/${postId}/comments`)).status).toBe(404);
    expect((await comment(reader, randomUUID(), 'nowhere')).status).toBe(404);

    // No update log entries and no notifications for comments.
    expect(await count(h.ctx.ownerUrl, 'select count(*)::int as n from app.update_log')).toBe(updatesBefore);

    const listed = await api(moderator).get(`/v1/messages/${postId}/comments`);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ count: 4, nextAfter: null, canComment: true });
    expect(listed.body.comments.map((item: { text: string }) => Array.from(item.text).slice(0, 10).join(''))).toEqual(['Good luck ', 'Thanks!', 'From the o', '😀😀😀😀😀😀😀😀😀😀']);
    // The moderator may delete anyone's comment, but edits only their own.
    expect(listed.body.comments.map((item: { mine: boolean; canDelete: boolean }) => [item.mine, item.canDelete])).toEqual([
      [false, true],
      [false, true],
      [false, true],
      [false, true],
    ]);
    const asOther = await api(other).get(`/v1/messages/${postId}/comments`);
    expect(asOther.body.comments.map((item: { mine: boolean; canDelete: boolean }) => [item.mine, item.canDelete])).toEqual([
      [false, false],
      [true, true],
      [false, false],
      [false, false],
    ]);

    // One grouped count per page of messages: the post shows 4, the other post 0; a group message no count.
    expect((await postView(reader, channelId, postId)).commentCount).toBe(4);
    expect((await postView(owner, channelId, second.body.id)).commentCount).toBe(0);
    const synced = await api(reader).get('/v1/sync?since=0');
    expect(synced.status).toBe(200);
  });

  it('lets only the author edit, and the author or admins who may delete messages delete; the history keeps every text', async () => {
    const { channelId, postId } = await setup('Edit and delete');
    expect((await turn(owner, channelId, true)).status).toBe(200);
    const mine = await comment(reader, postId, 'Original text');
    const reply = await comment(other, postId, 'A reply', { replyToId: mine.body.id });
    expect((await api(other).patch(`/v1/comments/${mine.body.id}`, { text: 'hijacked' })).status).toBe(404);
    expect((await api(owner).patch(`/v1/comments/${mine.body.id}`, { text: 'hijacked' })).status).toBe(404);
    const edited = await api(reader).patch(`/v1/comments/${mine.body.id}`, { text: 'Edited text' });
    expect(edited.status).toBe(200);
    expect(edited.body.text).toBe('Edited text');
    expect(edited.body.editedAt).not.toBeNull();
    // The same text again changes nothing.
    expect((await api(reader).patch(`/v1/comments/${mine.body.id}`, { text: 'Edited text' })).status).toBe(200);

    expect((await api(other).del(`/v1/comments/${mine.body.id}`)).body.error.code).toBe('NOT_ALLOWED');
    expect((await api(editor).del(`/v1/comments/${mine.body.id}`)).body.error.code).toBe('NOT_ALLOWED');
    expect((await api(moderator).del(`/v1/comments/${mine.body.id}`)).status).toBe(200);
    expect((await api(moderator).del(`/v1/comments/${mine.body.id}`)).status).toBe(404);
    expect((await api(reader).patch(`/v1/comments/${mine.body.id}`, { text: 'again' })).status).toBe(404);
    expect((await api(other).del(`/v1/comments/${reply.body.id}`)).status).toBe(200);

    const third = await comment(reader, postId, 'Still here', { replyToId: undefined });
    const listed = await api(reader).get(`/v1/messages/${postId}/comments`);
    expect(listed.body.count).toBe(1);
    expect(listed.body.comments.map((item: { id: string }) => item.id)).toEqual([third.body.id]);
    expect((await postView(reader, channelId, postId)).commentCount).toBe(1);

    // The row stays, without its text; the history has the text before every change, who did it and from which session.
    const row = (await query(h.ctx.ownerUrl, 'select text, deleted_at, deleted_by from app.channel_comments where id = $1', [mine.body.id])).rows[0];
    expect(row).toMatchObject({ text: null, deleted_by: moderator.id });
    const history = await query(h.ctx.ownerUrl, 'select action, previous_text, new_text, actor_id, session_id from audit.channel_comment_revisions where comment_id = $1 order by id', [mine.body.id]);
    expect(history.rows).toEqual([
      { action: 'edited', previous_text: 'Original text', new_text: 'Edited text', actor_id: reader.id, session_id: reader.sessionId },
      { action: 'deleted', previous_text: 'Edited text', new_text: null, actor_id: moderator.id, session_id: moderator.sessionId },
    ]);

    // The history is append-only, for the API's role and for the table owner alike; comments are never removed, and
    // their text never changes without a history record.
    await expect(query(h.ctx.runtimeUrl, 'update audit.channel_comment_revisions set previous_text = $1', ['x'])).rejects.toThrow(/permission denied/);
    await expect(query(h.ctx.runtimeUrl, 'delete from audit.channel_comment_revisions')).rejects.toThrow(/permission denied/);
    await expect(query(h.ctx.runtimeUrl, 'delete from app.channel_comments where id = $1', [third.body.id])).rejects.toThrow(/permission denied/);
    await expect(query(h.ctx.runtimeUrl, 'update app.channel_comments set author_id = $1 where id = $2', [other.id, third.body.id])).rejects.toThrow(/permission denied/);
    await expect(query(h.ctx.ownerUrl, 'update audit.channel_comment_revisions set previous_text = $1', ['x'])).rejects.toThrow();
    await expect(query(h.ctx.ownerUrl, 'delete from audit.channel_comment_revisions')).rejects.toThrow();
    await expect(query(h.ctx.ownerUrl, 'truncate audit.channel_comment_revisions')).rejects.toThrow();
    await expect(query(h.ctx.ownerUrl, 'delete from app.channel_comments where id = $1', [third.body.id])).rejects.toThrow();
    await expect(query(h.ctx.runtimeUrl, 'update app.channel_comments set text = $1 where id = $2', ['silently changed', third.body.id])).rejects.toThrow(/audit record/);
    await expect(query(h.ctx.ownerUrl, `update app.channel_comments set text = 'x' where id = $1`, [mine.body.id])).rejects.toThrow(/deleted/);
    expect(await count(h.ctx.ownerUrl, 'select count(*)::int as n from audit.channel_comment_revisions where comment_id = $1', [mine.body.id])).toBe(2);
  });

  it('refuses comments while they are off, and hides the count; authors may still delete theirs', async () => {
    const { channelId, postId } = await setup('Turned off');
    expect((await turn(owner, channelId, true)).status).toBe(200);
    const mine = await comment(reader, postId, 'Before');
    expect((await turn(owner, channelId, false)).status).toBe(200);
    expect((await comment(reader, postId, 'After')).body.error.code).toBe('NOT_ALLOWED');
    expect((await api(reader).get(`/v1/messages/${postId}/comments`)).body.error.code).toBe('NOT_ALLOWED');
    expect((await api(reader).patch(`/v1/comments/${mine.body.id}`, { text: 'changed' })).body.error.code).toBe('NOT_ALLOWED');
    expect((await postView(reader, channelId, postId)).commentCount).toBeNull();
    expect((await api(reader).del(`/v1/comments/${mine.body.id}`)).status).toBe(200);
    // A deleted post has no comments.
    expect((await turn(owner, channelId, true)).status).toBe(200);
    expect((await api(owner).post('/v1/messages/delete', { chatId: channelId, messageIds: [postId], scope: 'both' })).status).toBe(200);
    expect((await comment(reader, postId, 'on a deleted post')).status).toBe(404);
    expect((await api(reader).get(`/v1/messages/${postId}/comments`)).status).toBe(404);
    // Someone who left (or was removed) no longer reads or writes comments.
    const fresh = await api(owner).send(channelId, 'Fresh post');
    expect((await api(other).post(`/v1/groups/${channelId}/leave`)).status).toBe(200);
    expect((await comment(other, fresh.body.id, 'bye')).status).toBe(404);
    expect((await api(owner).del(`/v1/groups/${channelId}/members/${reader.id}`)).status).toBe(200);
    expect((await api(reader).get(`/v1/messages/${fresh.body.id}/comments`)).status).toBe(404);
  });

  it('pages comments oldest first, 50 at a time', async () => {
    const { channelId, postId } = await setup('Paging');
    expect((await turn(owner, channelId, true)).status).toBe(200);
    await query(
      h.ctx.ownerUrl,
      // Version-7 ids one millisecond apart, as comments written one after another get.
      `insert into app.channel_comments (id, conversation_id, post_message_id, author_id, client_id, text)
       select (lpad(to_hex(floor(extract(epoch from clock_timestamp()) * 1000)::bigint + i), 12, '0') || '7000800000000000' || lpad(to_hex(i), 4, '0'))::uuid,
         $1, $2, $3, gen_random_uuid(), 'comment ' || lpad(i::text, 3, '0') from generate_series(1, 120) as i`,
      [channelId, postId, reader.id],
    );
    const first = await api(other).get(`/v1/messages/${postId}/comments`);
    expect(first.body.comments).toHaveLength(50);
    expect(first.body.count).toBe(120);
    expect(first.body.comments[0].text).toBe('comment 001');
    expect(first.body.nextAfter).toBe(first.body.comments[49].id);
    const second = await api(other).get(`/v1/messages/${postId}/comments?after=${first.body.nextAfter}`);
    expect(second.body.comments).toHaveLength(50);
    expect(second.body.comments[0].text).toBe('comment 051');
    const third = await api(other).get(`/v1/messages/${postId}/comments?after=${second.body.nextAfter}`);
    expect(third.body.comments.map((item: { text: string }) => item.text)).toEqual(Array.from({ length: 20 }, (_, i) => `comment ${String(101 + i).padStart(3, '0')}`));
    expect(third.body.nextAfter).toBeNull();
    expect((await api(other).get(`/v1/messages/${postId}/comments?after=nonsense`)).status).toBe(400);
    expect((await postView(other, channelId, postId)).commentCount).toBe(120);
  });

  it('counts comments as messages for the rate limit', async () => {
    const { channelId, postId } = await setup('Rate limit');
    expect((await turn(owner, channelId, true)).status).toBe(200);
    for (let i = 0; i < 30; i += 1) {
      expect((await comment(reader, postId, `c${i}`)).status).toBe(200);
    }
    const limited = await comment(reader, postId, 'one too many');
    expect(limited.status).toBe(429);
    expect((await api(reader).send(channelId, 'x')).status).toBe(429);
  });
});

describe.runIf(enabled)('comments on channel posts before the database update (tables missing)', () => {
  let h: Harness;
  let owner: TestUser;
  let reader: TestUser;
  let api: (user: TestUser) => Api;

  beforeAll(async () => {
    h = await harness({ withoutChannelComments: true });
    api = h.api;
    owner = await h.newUser('Nora Owner');
    reader = await h.newUser('Nils Reader');
  });

  afterAll(async () => {
    await h?.app.close();
    await h?.ctx.teardown();
  });

  beforeEach(async () => {
    await h.resetLimits();
  });

  it('reports the feature unavailable and every other endpoint works as before', async () => {
    expect((await query(h.ctx.ownerUrl, `select to_regclass('app.channel_comments') as t`)).rows[0]!.t).toBeNull();
    const channel = await h.newChannel(owner, 'Before the update');
    expect(channel.group.commentsEnabled).toBeNull();
    expect((await api(reader).post(`/v1/channels/${channel.id}/join`)).status).toBe(200);
    const post = await api(owner).send(channel.id, 'A post');
    expect(post.status).toBe(200);
    expect(post.body.commentCount).toBeNull();

    // The comment routes say "not available"; nothing else changes.
    expect((await api(owner).put(`/v1/channels/${channel.id}/comments`, { enabled: true })).body.error.code).toBe('FEATURE_UNAVAILABLE');
    expect((await api(reader).get(`/v1/messages/${post.body.id}/comments`)).body.error.code).toBe('FEATURE_UNAVAILABLE');
    expect((await api(reader).post(`/v1/messages/${post.body.id}/comments`, { clientId: randomUUID(), text: 'hi' })).body.error.code).toBe('FEATURE_UNAVAILABLE');
    expect((await api(reader).patch(`/v1/comments/${randomUUID()}`, { text: 'hi' })).body.error.code).toBe('FEATURE_UNAVAILABLE');
    expect((await api(reader).del(`/v1/comments/${randomUUID()}`)).body.error.code).toBe('FEATURE_UNAVAILABLE');

    // Chats, messages, sync, search and the rest, in a channel, a group and a private chat.
    const chat = await api(reader).get(`/v1/chats/${channel.id}`);
    expect(chat.status).toBe(200);
    expect(chat.body.group.commentsEnabled).toBeNull();
    const list = await api(reader).get('/v1/chats');
    expect(list.status).toBe(200);
    expect(list.body.chats.find((item: { id: string }) => item.id === channel.id).lastMessage.commentCount).toBeNull();
    const history = await api(reader).get(`/v1/chats/${channel.id}/messages`);
    expect(history.status).toBe(200);
    expect(history.body.messages.map((message: { commentCount: number | null }) => message.commentCount)).toEqual([null]);
    expect((await api(reader).put(`/v1/messages/${post.body.id}/reaction`, { emoji: '👍' })).status).toBe(200);
    expect((await api(owner).patch(`/v1/messages/${post.body.id}`, { text: 'A post, edited' })).status).toBe(200);
    expect((await api(owner).put(`/v1/messages/${post.body.id}/pin`)).status).toBe(200);
    expect((await api(reader).get(`/v1/chats/${channel.id}/pins`)).body.messages).toHaveLength(1);
    expect((await api(reader).get(`/v1/chats/${channel.id}/search?q=edited`)).body.messages).toHaveLength(1);
    expect((await api(reader).get('/v1/search?q=edited')).status).toBe(200);
    const synced = await api(reader).get('/v1/sync?since=0');
    expect(synced.status).toBe(200);
    expect(synced.body.messages.every((message: { commentCount: number | null }) => message.commentCount === null)).toBe(true);
    expect((await api(owner).patch(`/v1/groups/${channel.id}`, { title: 'Renamed channel' })).body.group.commentsEnabled).toBeNull();
    expect((await api(owner).patch(`/v1/groups/${channel.id}/settings`, { isPublic: false })).status).toBe(200);

    const group = await api(owner).post('/v1/groups', { title: 'Plain group', memberIds: [reader.id] });
    expect(group.status).toBe(200);
    expect(group.body.group.commentsEnabled).toBeNull();
    const groupMessage = await api(reader).send(group.body.id, 'hello group');
    expect(groupMessage.status).toBe(200);
    expect(groupMessage.body.commentCount).toBeNull();
    const dm = await api(owner).openChat(reader);
    const direct = await api(owner).send(dm.id, 'hello you');
    expect(direct.status).toBe(200);
    const forwarded = await api(reader).post('/v1/messages/forward', { fromChatId: channel.id, messageIds: [post.body.id], targets: [{ chatId: dm.id, clientId: randomUUID() }] });
    expect(forwarded.status).toBe(200);
    expect((await api(owner).post('/v1/messages/delete', { chatId: dm.id, messageIds: [direct.body.id], scope: 'both' })).status).toBe(200);
    expect((await api(owner).post('/v1/messages/delete', { chatId: channel.id, messageIds: [post.body.id], scope: 'both' })).status).toBe(200);
    expect((await api(reader).get(`/v1/chats/${dm.id}/messages`)).status).toBe(200);
  });
});
