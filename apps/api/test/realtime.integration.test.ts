import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { REALTIME_SIGNAL_EVENT } from '@bedo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TOKEN_GRACE_SECONDS, verifyRealtimeToken } from '../src/messaging/realtime-token.js';
import { CHANNEL_PERIOD_MS, RealtimeService } from '../src/messaging/realtime.service.js';
import { type IntegrationEnv, query, setupIntegrationEnv, startApp, TEST_REALTIME_JWT_SECRET } from './integration-env.js';
import { client, createUser, resetMessageLimit, type TestUser } from './messaging-helpers.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Realtime (D-36) against real Postgres, with the API as the least-privilege runtime role and Supabase Realtime
 * replaced by a recorder of what the API broadcasts: private per-device channels, content-free signals only to
 * valid sessions, heartbeat-based presence, typing and presence with blocks and privacy.
 */
describe.runIf(enabled)('Phase 3.3 realtime signals (real Postgres, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    app = await startApp(ctx.env);
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  const api = (user: TestUser) => client(app, user);
  const newUser = (name: string) => createUser(ctx, app, name);
  const topicOf = async (user: TestUser) => (await api(user).get('/v1/realtime/channel')).body.topic as string;
  const signals = (topic: string) => ctx.realtime.on(topic);

  it('gives each device its own unguessable channel, and only to a signed-in device', async () => {
    const ana = await newUser('Ana Channel');
    const channel = await api(ana).get('/v1/realtime/channel');
    expect(channel.status).toBe(200);
    expect(channel.body).toEqual({
      enabled: true,
      url: 'https://realtime.bedo.test',
      apiKey: 'public-anon-key-for-tests',
      accessToken: expect.any(String),
      topic: expect.stringMatching(/^bedo-[A-Za-z0-9_-]{43}$/),
      expiresAt: expect.any(String),
      expiresInSeconds: expect.any(Number),
      event: REALTIME_SIGNAL_EVENT,
      heartbeatSeconds: 25,
    });
    // Stable for the session, never derived from anything the device could know (session id, user id).
    expect(await topicOf(ana)).toBe(channel.body.topic);
    expect(channel.body.topic).not.toContain(ana.sessionId);
    expect(channel.body.topic).not.toContain(ana.id);
    const second = await createUser(ctx, app, 'Ana Second Device');
    expect(await topicOf(second)).not.toBe(channel.body.topic);
    // The name changes every hour, at the time given.
    const expiresAt = Date.parse(channel.body.expiresAt);
    expect(expiresAt % CHANNEL_PERIOD_MS).toBe(0);
    expect(expiresAt - Date.now()).toBeGreaterThan(0);
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(CHANNEL_PERIOD_MS);
    // The device schedules the change from the server's count, not its own clock.
    expect(Math.abs(channel.body.expiresInSeconds - (expiresAt - Date.now()) / 1000)).toBeLessThan(5);
    const realtime = app.get(RealtimeService);
    const next = realtime.channelFor(ana.sessionId, expiresAt);
    expect(next.topic).not.toBe(channel.body.topic);
    expect(realtime.channelFor(ana.sessionId, expiresAt - 1).topic).toBe(channel.body.topic);
    // Private channel (Realtime Authorization): the device's token names this one channel, as the role
    // `authenticated`, for this user, and ends a few minutes after the channel name changes.
    const claims = verifyRealtimeToken(TEST_REALTIME_JWT_SECRET, channel.body.accessToken);
    expect(claims).toMatchObject({ aud: 'authenticated', role: 'authenticated', sub: ana.id, bedo_topic: channel.body.topic });
    expect(claims!.exp).toBe(expiresAt / 1000 + TOKEN_GRACE_SECONDS);
    expect(verifyRealtimeToken('another-secret-that-is-long-enough-0123456', channel.body.accessToken)).toBeNull();
    // The other device's token names only its own channel.
    const secondToken = (await api(second).get('/v1/realtime/channel')).body.accessToken as string;
    expect(verifyRealtimeToken(TEST_REALTIME_JWT_SECRET, secondToken)?.bedo_topic).toBe(await topicOf(second));
    expect(verifyRealtimeToken(TEST_REALTIME_JWT_SECRET, secondToken)?.sub).toBe(second.id);
    for (const url of ['/v1/realtime/channel', '/v1/realtime/heartbeat', '/v1/realtime/typing', '/v1/realtime/offline']) {
      const method = url.endsWith('channel') ? 'GET' : 'POST';
      const anonymous = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      expect(anonymous.statusCode, url).toBe(401);
    }
  });

  it('signals every valid device of both users after a message, without any content; the device fetches over HTTP', async () => {
    const ana = await newUser('Ana Realtime');
    const ben = await newUser('Ben Realtime');
    const chat = await api(ana).openChat(ben);
    const [anaTopic, benTopic] = [await topicOf(ana), await topicOf(ben)];
    ctx.realtime.clear();
    const sent = (await api(ana).send(chat.id, 'hello, signalled')).body;
    expect(await signals(benTopic)).toEqual([{ type: 'updates' }]);
    // Ana's own device hears about her message too (multi-device sync).
    expect(await signals(anaTopic)).toEqual([{ type: 'updates' }]);
    // Nothing broadcast ever carries a message: only the signal.
    expect(JSON.stringify(ctx.realtime.sent)).not.toContain('hello, signalled');
    expect(ctx.realtime.sent.every((message) => message.event === REALTIME_SIGNAL_EVENT)).toBe(true);
    const synced = await api(ben).get('/v1/sync?since=0');
    expect(synced.body.messages.map((message: { id: string }) => message.id)).toContain(sent.id);
    // Delivered over HTTP: Ana's devices are signalled to fetch the new status.
    ctx.realtime.clear();
    expect((await api(ben).post(`/v1/chats/${chat.id}/delivered`, { seq: sent.seq })).status).toBe(200);
    expect(await signals(anaTopic)).toEqual([{ type: 'updates' }]);
  });

  it('stops signalling a device as soon as its session ends', async () => {
    const hal = await newUser('Hal Revoked');
    const ivy = await newUser('Ivy Sender');
    const chat = await api(ivy).openChat(hal);
    const halTopic = await topicOf(hal);
    await query(ctx.ownerUrl, "update app.sessions set revoked_at = now(), revoke_reason = 'terminated_by_user' where id = $1", [hal.sessionId]);
    ctx.realtime.clear();
    await api(ivy).send(chat.id, 'after revoke');
    expect(await signals(halTopic)).toEqual([]);
    expect((await api(hal).get('/v1/realtime/channel')).status).toBe(401);
  });

  it('keeps a device online with heartbeats, which also return the current update position', async () => {
    const cai = await newUser('Cai Heartbeat');
    const dee = await newUser('Dee Partner');
    const chat = await api(dee).openChat(cai);
    await api(dee).send(chat.id, 'hi');
    const first = await api(cai).post('/v1/realtime/heartbeat');
    expect(first.status).toBe(200);
    const sync = await api(cai).get('/v1/sync?since=0');
    expect(first.body).toEqual({ seq: sync.body.seq });
    const peer = (await api(dee).get(`/v1/users/${cai.id}`)).body;
    expect(peer.presence).toEqual({ online: true, lastSeenAt: null });
    await resetMessageLimit(ctx, dee.id);
    await api(dee).send(chat.id, 'again');
    expect((await api(cai).post('/v1/realtime/heartbeat')).body.seq).toBeGreaterThan(first.body.seq);
    // More than 10 a minute are answered but do nothing more.
    for (let index = 0; index < 12; index += 1) {
      expect((await api(cai).post('/v1/realtime/heartbeat')).status).toBe(200);
    }
  });

  it('announces coming online and going offline to chat partners only where privacy and blocks allow', async () => {
    const eve = await newUser('Eve Presence');
    const fin = await newUser('Fin Watching');
    const chat = await api(eve).openChat(fin);
    await api(eve).send(chat.id, 'hi');
    const finTopic = await topicOf(fin);
    ctx.realtime.clear();
    await api(eve).post('/v1/realtime/heartbeat');
    expect(await signals(finTopic)).toEqual([{ type: 'presence', userId: eve.id, presence: { online: true, lastSeenAt: null } }]);
    // A second heartbeat is not a change: nothing more is announced.
    ctx.realtime.clear();
    await api(eve).post('/v1/realtime/heartbeat');
    expect((await signals(finTopic)).filter((signal) => signal.type === 'presence')).toEqual([]);
    await api(eve).post('/v1/realtime/offline');
    const offline = (await signals(finTopic)).filter((signal) => signal.type === 'presence');
    expect(offline).toEqual([{ type: 'presence', userId: eve.id, presence: { online: false, lastSeenAt: expect.stringMatching(/:00\.000Z$/) } }]);
    // Last seen hidden (P-31): going online is not announced.
    await api(eve).patch('/v1/me/privacy', { lastSeenVisibility: 'nobody' });
    ctx.realtime.clear();
    await api(eve).post('/v1/realtime/heartbeat');
    expect((await signals(finTopic)).filter((signal) => signal.type === 'presence')).toEqual([]);
  });

  it('marks a device offline when its heartbeats stop, announced from any later heartbeat', async () => {
    const gil = await newUser('Gil Vanishing');
    const kim = await newUser('Kim Partner');
    const chat = await api(gil).openChat(kim);
    await api(gil).send(chat.id, 'hi');
    const kimTopic = await topicOf(kim);
    await api(gil).post('/v1/realtime/heartbeat');
    // The tab closed without saying so: 60 seconds later (simulated) the device has expired.
    await query(ctx.ownerUrl, "update app.presence_devices set expires_at = now() - interval '1 second' where user_id = $1", [gil.id]);
    ctx.realtime.clear();
    await api(kim).post('/v1/realtime/heartbeat');
    const announced = (await signals(kimTopic)).filter((signal) => signal.type === 'presence' && signal.userId === gil.id);
    expect(announced).toEqual([{ type: 'presence', userId: gil.id, presence: { online: false, lastSeenAt: expect.any(String) } }]);
    expect((await query(ctx.ownerUrl, 'select 1 from app.presence_devices where user_id = $1', [gil.id])).rowCount).toBe(0);
    expect((await api(kim).get(`/v1/users/${gil.id}`)).body.presence).toMatchObject({ online: false });
  });

  it('relays typing only where a message could be sent, at most every 2 seconds per chat', async () => {
    const lia = await newUser('Lia Typing');
    const max = await newUser('Max Reading');
    const chat = await api(lia).openChat(max);
    await api(lia).send(chat.id, 'hi');
    const maxTopic = await topicOf(max);
    ctx.realtime.clear();
    expect((await api(lia).post('/v1/realtime/typing', { chatId: chat.id })).status).toBe(200);
    await api(lia).post('/v1/realtime/typing', { chatId: chat.id });
    expect(await signals(maxTopic)).toEqual([{ type: 'typing', chatId: chat.id, userId: lia.id }]);
    // Not to someone outside the chat, and not to a chat the sender is not in.
    const outsider = await newUser('Ned Outsider');
    expect((await api(outsider).post('/v1/realtime/typing', { chatId: chat.id })).status).toBe(200);
    expect(await signals(maxTopic)).toHaveLength(1);
    // Max blocks Lia: her typing no longer reaches him.
    await api(max).post(`/v1/users/${lia.id}/block`);
    await new Promise((done) => setTimeout(done, 2_100));
    ctx.realtime.clear();
    await api(lia).post('/v1/realtime/typing', { chatId: chat.id });
    expect(await signals(maxTopic)).toEqual([]);
    expect((await api(lia).post('/v1/realtime/typing', { chatId: 'not-a-uuid' })).status).toBe(400);
  });
});
