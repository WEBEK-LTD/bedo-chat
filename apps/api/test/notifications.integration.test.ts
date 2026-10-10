import { randomUUID } from 'node:crypto';
import { badgeCount } from '@bedo/contracts';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type IntegrationEnv, query, setupIntegrationEnv, startApp } from './integration-env.js';
import { client, createUser, resetMessageLimit, type TestUser } from './messaging-helpers.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

interface Pushed {
  endpoint: string;
  payload: { title: string; body: string; tag: string; url?: string; badge?: number };
}

describe.runIf(enabled)('Phase 7 notifications (real Postgres, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  const users: TestUser[] = [];
  let ana: TestUser;
  let ben: TestUser;
  let cleo: TestUser;
  let api: (user: TestUser) => ReturnType<typeof client>;
  const endpointOf = (user: TestUser, device = 'web') => `https://fcm.googleapis.com/fcm/send/${device}-${user.id}`;

  async function newUser(name: string, username: string): Promise<TestUser> {
    const user = await createUser(ctx, app, name);
    await client(app, user).patch('/v1/me', { username });
    users.push(user);
    expect((await client(app, user).put('/v1/me/push-subscription', { endpoint: endpointOf(user), keys: { p256dh: 'p', auth: 'a' } })).status).toBe(200);
    return user;
  }

  /** Pushes sent since the last call, for one user's devices. */
  async function pushesFor(user: TestUser): Promise<Pushed['payload'][]> {
    const all = (await ctx.push.all()) as Pushed[];
    return all.filter((push) => push.endpoint.endsWith(user.id)).map((push) => push.payload);
  }

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    app = await startApp(ctx.env);
    api = (user) => client(app, user);
    ana = await newUser('Ana Lopez', 'ana_lopez');
    ben = await newUser('Ben Carter', 'ben_carter');
    cleo = await newUser('Cleo Park', 'cleo_park');
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.push.all();
    ctx.push.clear();
    for (const user of users) {
      await resetMessageLimit(ctx, user.id);
      await query(ctx.ownerUrl, 'delete from app.rate_counters where key like $1', [`rl:%:${user.id}`]);
    }
  });

  it('pushes a private message with the sender, the text, a link to the chat and the badge (never to the sender)', async () => {
    const chat = await api(ana).openChat(ben);
    await api(ana).send(chat.id, 'Are you coming to class?');
    const [push] = await pushesFor(ben);
    expect(push).toEqual({ title: 'Ana Lopez', body: 'Are you coming to class?', tag: `chat-${chat.id}`, url: `/?chat=${chat.id}`, badge: 1 });
    expect(await pushesFor(ana)).toEqual([]);
    // The badge is the same number every device computes from the chat list, and the API answers it too.
    const chats = (await api(ben).get('/v1/chats')).body.chats;
    expect(badgeCount(chats)).toBe(1);
    expect((await api(ben).get('/v1/me/badge')).body).toEqual({ count: 1 });
    ctx.push.clear();
    await api(ana).send(chat.id, 'Second one');
    expect((await pushesFor(ben))[0]!.badge).toBe(2);
    // Reading clears it everywhere.
    await api(ben).post(`/v1/chats/${chat.id}/read`, { seq: 2 });
    expect((await api(ben).get('/v1/me/badge')).body.count).toBe(0);
    expect(badgeCount((await api(ben).get('/v1/chats')).body.chats)).toBe(0);
  });

  it('does not push a device that is showing the chat, and pushes it again once it shows something else', async () => {
    const chat = await api(cleo).openChat(ben);
    expect((await api(ben).post('/v1/realtime/viewing', { chatId: chat.id })).status).toBe(200);
    await api(cleo).send(chat.id, 'You are looking at this');
    expect(await pushesFor(ben)).toEqual([]);
    await api(ben).post('/v1/realtime/viewing', { chatId: null });
    await api(cleo).send(chat.id, 'Now you are not');
    expect((await pushesFor(ben)).map((push) => push.body)).toEqual(['Now you are not']);
    // Only chats the device's user is in.
    const other = await api(ana).openChat(cleo);
    expect((await api(ben).post('/v1/realtime/viewing', { chatId: other.id })).status).toBe(404);
  });

  it('respects mute and categories, except for mentions and replies (O-19), and previews off', async () => {
    const group = (await api(ana).post('/v1/groups', { title: 'Study group', memberIds: [ben.id, cleo.id] })).body;
    // Being added is a notification.
    expect((await pushesFor(ben)).map((push) => push.body)).toEqual(['Ana Lopez added you to the group']);
    ctx.push.clear();
    await api(ana).send(group.id, 'Meeting at five');
    expect((await pushesFor(ben)).map((push) => [push.title, push.body])).toEqual([['Study group', 'Ana Lopez: Meeting at five']]);

    // Ben mutes the group: plain messages stay silent, a mention and a reply to him still notify.
    await api(ben).patch(`/v1/chats/${group.id}/state`, { mutedUntil: '2099-12-31T00:00:00.000Z' });
    ctx.push.clear();
    await api(ana).send(group.id, 'Nobody is told');
    expect(await pushesFor(ben)).toEqual([]);
    await api(ana).send(group.id, 'Hey @ben_carter, bring the notes');
    const mine = await api(ben).send(group.id, 'I will');
    await api(cleo).send(group.id, 'Thanks Ben', { replyToId: mine.body.id });
    expect((await pushesFor(ben)).map((push) => push.body)).toEqual(['Ana Lopez mentioned you: Hey @ben_carter, bring the notes', 'Cleo Park: Thanks Ben']);
    // A muted chat does not count in the badge.
    expect((await api(ben).get('/v1/me/badge')).body.count).toBe(badgeCount((await api(ben).get('/v1/chats')).body.chats));

    // Cleo turns groups off and previews off.
    expect((await api(cleo).patch('/v1/me/notification-settings', { groups: false })).body).toEqual({ privateChats: true, groups: false, channels: true, previews: true });
    ctx.push.clear();
    await api(ana).send(group.id, 'Groups are off for Cleo');
    expect(await pushesFor(cleo)).toEqual([]);
    await api(cleo).patch('/v1/me/notification-settings', { previews: false });
    const dm = await api(ana).openChat(cleo);
    await api(ana).send(dm.id, 'A secret');
    const [generic] = await pushesFor(cleo);
    expect(generic).toMatchObject({ title: 'Bedo Chat', body: 'New message', tag: `chat-${dm.id}` });
    expect(JSON.stringify(generic)).not.toContain('secret');
    expect((await api(cleo).get('/v1/me/notification-settings')).body).toEqual({ privateChats: true, groups: false, channels: true, previews: false });
    expect((await api(cleo).patch('/v1/me/notification-settings', {})).status).toBe(400);
  });

  it('shows channel posts as from the channel, never from someone blocked, and media by name', async () => {
    await query(ctx.ownerUrl, 'insert into app.user_permissions (user_id, create_channels) values ($1, true) on conflict (user_id) do update set create_channels = true', [ana.id]);
    const channel = (await api(ana).post('/v1/channels', { title: 'Ana news', isPublic: true })).body;
    await api(ben).post(`/v1/channels/${channel.id}/join`);
    ctx.push.clear();
    await api(ana).send(channel.id, 'First post');
    expect((await pushesFor(ben)).map((push) => [push.title, push.body])).toEqual([['Ana news', 'First post']]);
    // A poll is named by its question.
    ctx.push.clear();
    await api(ana).post(`/v1/chats/${channel.id}/messages`, { clientId: randomUUID(), poll: { question: 'Exam day?', options: ['Mon', 'Tue'] } });
    expect((await pushesFor(ben)).map((push) => push.body)).toEqual(['📊 Exam day?']);
    // Ben blocks Cleo: her messages in a shared group do not reach him as pushes.
    const group = (await api(cleo).post('/v1/groups', { title: 'Blocks', memberIds: [ben.id, ana.id] })).body;
    await api(ben).post(`/v1/users/${cleo.id}/block`);
    ctx.push.clear();
    await api(cleo).send(group.id, 'Hello Ben');
    expect(await pushesFor(ben)).toEqual([]);
    expect((await pushesFor(ana)).length).toBe(1);
    // Forwarding several messages is one notification per chat.
    const dm = await api(ana).openChat(ben);
    const one = await api(ana).send(dm.id, 'one');
    const two = await api(ana).send(dm.id, 'two');
    const target = await api(ana).openChat(cleo);
    ctx.push.clear();
    await api(ana).post('/v1/messages/forward', { fromChatId: dm.id, messageIds: [one.body.id, two.body.id], targets: [{ chatId: target.id, clientId: randomUUID() }] });
    expect((await pushesFor(cleo)).map((push) => push.body)).toEqual(['New message']);
    await api(cleo).patch('/v1/me/notification-settings', { previews: true });
    ctx.push.clear();
    await api(ana).post('/v1/messages/forward', { fromChatId: dm.id, messageIds: [one.body.id, two.body.id], targets: [{ chatId: target.id, clientId: randomUUID() }] });
    expect((await pushesFor(cleo)).map((push) => push.body)).toEqual(['2 forwarded messages']);
  });
});
