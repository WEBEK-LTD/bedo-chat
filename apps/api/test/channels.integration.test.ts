import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchToken } from '../src/messaging/scheduled.service.js';
import { FakeMediaStorage, type IntegrationEnv, query, setupIntegrationEnv, startApp } from './integration-env.js';
import { client, createUser, resetMessageLimit, type TestUser } from './messaging-helpers.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const JPEG = (size: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), Buffer.alloc(size - 10, 7)]);

type Api = ReturnType<typeof client>;

describe.runIf(enabled)('Phase 6 channels and scheduled messages (real Postgres, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  let storage: FakeMediaStorage;
  const users: TestUser[] = [];
  let owner: TestUser;
  let editor: TestUser;
  let reader: TestUser;
  let outsider: TestUser;
  let api: (user: TestUser) => Api;

  async function newUser(name: string): Promise<TestUser> {
    const user = await createUser(ctx, app, name);
    users.push(user);
    return user;
  }

  const allow = (user: TestUser, permissions: { channels?: boolean; schedule?: boolean }) =>
    query(
      ctx.ownerUrl,
      `insert into app.user_permissions (user_id, create_channels, schedule_messages) values ($1, $2, $3)
       on conflict (user_id) do update set create_channels = excluded.create_channels, schedule_messages = excluded.schedule_messages`,
      [user.id, permissions.channels ?? false, permissions.schedule ?? false],
    );

  /** What the scheduled Netlify function sends. */
  const dispatch = async (token = dispatchToken(ctx.env.ACCESS_TOKEN_SECRET!)) => {
    const response = await app.inject({ method: 'POST', url: '/v1/internal/dispatch', headers: { 'x-bedo-dispatch': token } });
    return { status: response.statusCode, body: response.json() };
  };
  const makeDue = (id: string) => query(ctx.ownerUrl, `update app.scheduled_messages set send_at = now() - interval '1 second' where id = $1`, [id]);
  const soon = () => new Date(Date.now() + 60_000).toISOString();

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    storage = new FakeMediaStorage();
    app = await startApp(ctx.env, undefined, { storage });
    api = (user) => client(app, user);
    owner = await newUser('Olga Owner');
    editor = await newUser('Eddie Editor');
    reader = await newUser('Rita Reader');
    outsider = await newUser('Otto Outsider');
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

  async function newChannel(title: string, isPublic = true) {
    await allow(owner, { channels: true });
    const created = await api(owner).post('/v1/channels', { title, isPublic });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return created.body as { id: string; type: string; group: Record<string, unknown> };
  }

  it('creates channels only with the system permission, with the creator as owner who may post', async () => {
    expect((await api(outsider).post('/v1/channels', { title: 'Nope' })).body.error.code).toBe('NOT_ALLOWED');
    const channel = await newChannel('School news');
    expect(channel).toMatchObject({ type: 'channel', peer: null, group: { title: 'School news', role: 'owner', public: true, memberCount: 1, canViewMembers: true } });
    expect(channel.group.permissions).toEqual(['send_messages', 'send_media', 'send_stickers', 'send_polls']);
    expect(channel.group.adminRights).not.toContain('change_privacy');
    expect(channel.group.adminRights).toContain('post_messages');
    // Groups never hold the posting right; the owner's rights there are unchanged.
    const group = await api(owner).post('/v1/groups', { title: 'A group', memberIds: [] });
    expect(group.body.group.adminRights).not.toContain('post_messages');
    expect(group.body.group.public).toBe(false);
  });

  it('lets anyone find and join a public channel, never a private one, and keeps subscribers read-only', async () => {
    const channel = await newChannel('Announcements board');
    const hidden = await newChannel('Announcements staff', false);
    const found = await api(reader).get('/v1/channels/search?q=announcements');
    expect(found.status).toBe(200);
    expect(found.body.channels).toEqual([expect.objectContaining({ id: channel.id, title: 'Announcements board', subscriberCount: 1, subscribed: false })]);
    expect((await api(reader).post(`/v1/channels/${hidden.id}/join`)).status).toBe(404);
    const joined = await api(reader).post(`/v1/channels/${channel.id}/join`);
    expect(joined.body).toMatchObject({ type: 'channel', group: { role: 'subscriber', permissions: [], adminRights: [], canViewMembers: false, memberCount: 2, settings: null } });
    expect((await api(reader).get('/v1/channels/search?q=board')).body.channels[0].subscribed).toBe(true);
    // Joining twice changes nothing.
    expect((await api(reader).post(`/v1/channels/${channel.id}/join`)).status).toBe(200);
    expect((await query(ctx.ownerUrl, 'select count(*)::int as n from app.conversation_members where conversation_id = $1', [channel.id])).rows[0]!.n).toBe(2);

    // Subscribers read and react, but cannot post, upload, see who subscribed, or be told who is typing.
    expect((await api(reader).send(channel.id, 'hello?')).body.error.code).toBe('NOT_ALLOWED');
    expect((await api(reader).post('/v1/files/uploads', { chatId: channel.id, kind: 'photo', mimeType: 'image/jpeg', size: 1000 })).body.error.code).toBe('NOT_ALLOWED');
    expect((await api(reader).get(`/v1/groups/${channel.id}/members`)).body.error.code).toBe('NOT_ALLOWED');
    const canList = await query(ctx.ownerUrl, `select app.can_view_members($1, $2, 'list') as list, app.can_view_members($1, $2, 'count') as count`, [reader.id, channel.id]);
    expect(canList.rows[0]).toEqual({ list: false, count: true });
    expect((await api(reader).patch(`/v1/groups/${channel.id}/settings`, { isPublic: false })).body.error.code).toBe('NOT_ALLOWED');
    // Group-only settings do not apply to channels; channels are the only public chats.
    expect((await api(owner).patch(`/v1/groups/${channel.id}/settings`, { hideMemberList: true })).status).toBe(400);
    expect((await api(owner).post('/v1/groups', { title: 'g', memberIds: [] }).then((g) => api(owner).patch(`/v1/groups/${g.body.id}/settings`, { isPublic: true }))).status).toBe(400);

    // Posts are shown to subscribers as sent by the channel; the owner sees who posted.
    const post = await api(owner).send(channel.id, 'Exams start on Monday');
    expect(post.status).toBe(200);
    const readerView = (await api(reader).get(`/v1/chats/${channel.id}/messages`)).body.messages.at(-1);
    expect(readerView).toMatchObject({ id: post.body.id, senderId: channel.id, sender: null, text: 'Exams start on Monday' });
    expect(JSON.stringify(readerView)).not.toContain(owner.id);
    expect((await api(owner).get(`/v1/chats/${channel.id}/messages`)).body.messages.at(-1)).toMatchObject({ senderId: owner.id });
    expect((await api(reader).put(`/v1/messages/${post.body.id}/reaction`, { emoji: '👍' })).status).toBe(200);
    // A subscriber forwarding the post shows the channel as its origin, never the admin.
    const dm = await api(reader).openChat(outsider);
    const forwarded = await api(reader).post('/v1/messages/forward', { fromChatId: channel.id, messageIds: [post.body.id], targets: [{ chatId: dm.id, clientId: randomUUID() }] });
    expect(forwarded.status, JSON.stringify(forwarded.body)).toBe(200);
    expect(forwarded.body.messages[0].forwardedFrom).toEqual({ kind: 'channel', id: channel.id, displayName: 'Announcements board', deleted: false });
    // Turning the channel private hides it from search; subscribers stay.
    expect((await api(owner).patch(`/v1/groups/${channel.id}/settings`, { isPublic: false })).body.group.public).toBe(false);
    expect((await api(outsider).get('/v1/channels/search?q=board')).body.channels).toEqual([]);
    expect((await api(outsider).post(`/v1/channels/${channel.id}/join`)).status).toBe(404);
  });

  it('lets only admins with the right to post publish, and only staff see subscribers', async () => {
    const channel = await newChannel('Editors');
    for (const user of [editor, reader]) await api(user).post(`/v1/channels/${channel.id}/join`);
    // An admin without the posting right manages but does not post.
    expect((await api(owner).patch(`/v1/groups/${channel.id}/members/${editor.id}`, { role: 'admin', adminRights: ['pin_messages'] })).status).toBe(200);
    expect((await api(editor).send(channel.id, 'draft')).body.error.code).toBe('NOT_ALLOWED');
    expect((await api(editor).get(`/v1/groups/${channel.id}/members`)).body.members).toHaveLength(3);
    expect((await api(owner).patch(`/v1/groups/${channel.id}/members/${editor.id}`, { role: 'admin', adminRights: ['pin_messages', 'post_messages'] })).status).toBe(200);
    const post = await api(editor).send(channel.id, 'Published by an editor');
    expect(post.status).toBe(200);
    expect((await api(editor).put(`/v1/messages/${post.body.id}/pin`)).status).toBe(200);
    // Group-only rights and restrictions are refused in channels.
    expect((await api(owner).patch(`/v1/groups/${channel.id}/members/${editor.id}`, { role: 'admin', adminRights: ['change_privacy'] })).status).toBe(400);
    expect((await api(owner).patch(`/v1/groups/${channel.id}/members/${reader.id}`, { deniedPermissions: ['send_messages'] })).status).toBe(400);
    // Demoted: a subscriber again.
    expect((await api(owner).patch(`/v1/groups/${channel.id}/members/${editor.id}`, { role: 'member' })).status).toBe(200);
    expect((await api(editor).get(`/v1/chats/${channel.id}`)).body.group).toMatchObject({ role: 'subscriber', permissions: [] });
    // Subscribers removed by an admin who may remove; the history records it.
    expect((await api(owner).del(`/v1/groups/${channel.id}/members/${reader.id}`)).status).toBe(200);
    const history = await query(ctx.ownerUrl, 'select action from audit.membership_events where conversation_id = $1 order by id', [channel.id]);
    expect(history.rows.map((row) => row.action)).toEqual(['created', 'joined', 'joined', 'promoted', 'rights_changed', 'demoted', 'removed']);
  });

  it('sends a scheduled channel post when it is due, once, through the internal dispatch', async () => {
    const channel = await newChannel('Scheduled news');
    await api(reader).post(`/v1/channels/${channel.id}/join`);
    const clientId = randomUUID();
    const scheduled = await api(owner).post(`/v1/chats/${channel.id}/scheduled`, { sendAt: soon(), message: { clientId, text: 'Good morning, school!' } });
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(200);
    expect(scheduled.body).toMatchObject({ chatId: channel.id, clientId, status: 'pending', text: 'Good morning, school!', media: null });
    // A retry of the same request returns the same scheduled message.
    expect((await api(owner).post(`/v1/chats/${channel.id}/scheduled`, { sendAt: soon(), message: { clientId, text: 'Good morning, school!' } })).body.id).toBe(scheduled.body.id);
    expect((await api(owner).get(`/v1/chats/${channel.id}`)).body.scheduledCount).toBe(1);
    // Only the author sees it; nothing is sent before its time.
    expect((await api(reader).get(`/v1/chats/${channel.id}/scheduled`)).body.scheduled).toEqual([]);
    expect((await api(reader).post(`/v1/chats/${channel.id}/scheduled`, { sendAt: soon(), message: { clientId: randomUUID(), text: 'x' } })).body.error.code).toBe('NOT_ALLOWED');
    expect((await dispatch()).body).toEqual({ sent: 0, failed: 0 });
    // A wrong or missing token gets the same answer as a route that does not exist.
    expect((await dispatch('0'.repeat(64))).status).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/v1/internal/dispatch' })).statusCode).toBe(404);

    await makeDue(scheduled.body.id);
    // Two runs at once (the scheduled function and a request) still send it once.
    const [first, second] = await Promise.all([dispatch(), dispatch()]);
    expect(first.body.sent + second.body.sent).toBe(1);
    const latest = (await api(reader).get(`/v1/chats/${channel.id}/messages`)).body.messages.at(-1);
    expect(latest).toMatchObject({ text: 'Good morning, school!', senderId: channel.id, clientId });
    expect((await query(ctx.ownerUrl, 'select count(*)::int as n from app.messages where conversation_id = $1', [channel.id])).rows[0]!.n).toBe(1);
    const row = (await query(ctx.ownerUrl, 'select status, message_id, sent_at from app.scheduled_messages where id = $1', [scheduled.body.id])).rows[0]!;
    expect(row).toMatchObject({ status: 'sent', message_id: latest.id });
    expect((await api(owner).get(`/v1/chats/${channel.id}`)).body.scheduledCount).toBe(0);
    // The author's devices hear that the list changed; the subscriber's that a post arrived.
    const sync = await api(owner).get('/v1/sync?since=0');
    expect(sync.body.updates.some((update: { kind: string; chatId: string }) => update.kind === 'scheduled' && update.chatId === channel.id)).toBe(true);
    expect((await dispatch()).body).toEqual({ sent: 0, failed: 0 });
    // The client id is now used: it cannot be scheduled again.
    expect((await api(owner).post(`/v1/chats/${channel.id}/scheduled`, { sendAt: soon(), message: { clientId, text: 'again' } })).status).toBe(409);
  });

  it('needs the system permission to schedule outside one’s channels, and checks the author again when due', async () => {
    const dm = await api(editor).openChat(outsider);
    expect((await api(editor).post(`/v1/chats/${dm.id}/scheduled`, { sendAt: soon(), message: { clientId: randomUUID(), text: 'see you' } })).body.error.code).toBe('NOT_ALLOWED');
    await allow(editor, { schedule: true });
    // Not too soon, not too far ahead.
    expect((await api(editor).post(`/v1/chats/${dm.id}/scheduled`, { sendAt: new Date().toISOString(), message: { clientId: randomUUID(), text: 'now' } })).status).toBe(400);
    expect((await api(editor).post(`/v1/chats/${dm.id}/scheduled`, { sendAt: new Date(Date.now() + 400 * 86_400_000).toISOString(), message: { clientId: randomUUID(), text: 'next year' } })).status).toBe(400);
    const later = await api(editor).post(`/v1/chats/${dm.id}/scheduled`, { sendAt: soon(), message: { clientId: randomUUID(), text: 'see you' } });
    expect(later.status).toBe(200);
    // Change the time and text, send one now, remove another.
    const moved = await api(editor).patch(`/v1/scheduled/${later.body.id}`, { sendAt: new Date(Date.now() + 2 * 3600_000).toISOString(), text: 'see you tomorrow' });
    expect(moved.body).toMatchObject({ text: 'see you tomorrow', status: 'pending' });
    expect((await api(outsider).patch(`/v1/scheduled/${later.body.id}`, { text: 'hijack' })).status).toBe(404);
    const now = await api(editor).post(`/v1/scheduled/${later.body.id}/send`);
    expect(now.body).toMatchObject({ text: 'see you tomorrow', senderId: editor.id });
    expect((await api(outsider).get(`/v1/chats/${dm.id}/messages`)).body.messages.at(-1).text).toBe('see you tomorrow');
    const gone = await api(editor).post(`/v1/chats/${dm.id}/scheduled`, { sendAt: soon(), message: { clientId: randomUUID(), text: 'never' } });
    expect((await api(editor).del(`/v1/scheduled/${gone.body.id}`)).status).toBe(200);
    expect((await api(editor).get(`/v1/chats/${dm.id}/scheduled`)).body.scheduled).toEqual([]);

    // The author lost the right before it was due (Otto blocked Eddie): it fails with the reason, nothing is sent.
    const blockedLater = await api(editor).post(`/v1/chats/${dm.id}/scheduled`, { sendAt: soon(), message: { clientId: randomUUID(), text: 'after the block' } });
    await api(outsider).post(`/v1/users/${editor.id}/block`);
    await makeDue(blockedLater.body.id);
    expect((await dispatch()).body).toEqual({ sent: 0, failed: 1 });
    expect((await api(editor).get(`/v1/chats/${dm.id}/scheduled`)).body.scheduled).toEqual([
      expect.objectContaining({ id: blockedLater.body.id, status: 'failed', error: 'CANNOT_MESSAGE' }),
    ]);
    expect((await api(outsider).get(`/v1/chats/${dm.id}/messages`)).body.messages.some((message: { text: string }) => message.text === 'after the block')).toBe(false);
  });

  it('checks and keeps a scheduled file at scheduling time and sends it when due', async () => {
    const channel = await newChannel('Photo of the day');
    const slot = await api(owner).post('/v1/files/uploads', { chatId: channel.id, kind: 'photo', mimeType: 'image/jpeg', size: 4000 });
    expect(slot.status).toBe(200);
    expect(storage.upload(slot.body.upload.url, JPEG(4000))).toBe(true);
    const scheduled = await api(owner).post(`/v1/chats/${channel.id}/scheduled`, { sendAt: soon(), message: { clientId: randomUUID(), fileId: slot.body.fileId, text: 'Our garden' } });
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(200);
    expect(scheduled.body).toMatchObject({ media: 'photo', text: 'Our garden' });
    // Ready now (kept by housekeeping), and it cannot be sent elsewhere in the meantime.
    expect((await query(ctx.ownerUrl, 'select status from app.files where id = $1', [slot.body.fileId])).rows[0]!.status).toBe('ready');
    expect((await api(owner).post(`/v1/chats/${channel.id}/messages`, { clientId: randomUUID(), fileId: slot.body.fileId })).status).toBe(409);
    await makeDue(scheduled.body.id);
    expect((await dispatch()).body).toEqual({ sent: 1, failed: 0 });
    const post = (await api(owner).get(`/v1/chats/${channel.id}/messages`)).body.messages.at(-1);
    expect(post).toMatchObject({ kind: 'media', text: 'Our garden', attachment: { kind: 'photo' } });
  });
});
