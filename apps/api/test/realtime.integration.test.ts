import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { REALTIME_CLOSE, type RealtimeServerMessage } from '@bedo/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ADMIN_ORIGIN, type IntegrationEnv, query, setupIntegrationEnv, startApp, WEB_ORIGIN } from './integration-env.js';
import { client, createUser, resetMessageLimit, type TestUser } from './messaging-helpers.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.REDIS_URL);
/** Random per run, like the production Worker secret (never a fixed value in the repository). */
const EDGE_SECRET = randomBytes(32).toString('base64');

interface Device {
  ws: WebSocket;
  received: RealtimeServerMessage[];
  /** Resolves with the first message (already received or arriving) that matches. */
  next<T extends RealtimeServerMessage>(match: (message: RealtimeServerMessage) => message is T, timeoutMs?: number): Promise<T>;
  /** Resolves when nothing matching arrives within the time. */
  none(match: (message: RealtimeServerMessage) => boolean, waitMs?: number): Promise<void>;
  closed: Promise<number>;
  send(message: unknown): void;
}

const isType =
  <K extends RealtimeServerMessage['type']>(type: K, extra: (message: Extract<RealtimeServerMessage, { type: K }>) => boolean = () => true) =>
  (message: RealtimeServerMessage): message is Extract<RealtimeServerMessage, { type: K }> =>
    message.type === type && extra(message as Extract<RealtimeServerMessage, { type: K }>);

/**
 * Realtime gateway (step 3.5) over a real socket: handshake checks (path, origin, edge secret), token
 * authentication, multi-device delivery and catch-up after a disconnect, typing and presence with blocks
 * and privacy, and disconnection when the session ends.
 */
describe.runIf(enabled)('Phase 3 realtime gateway (real Postgres + Redis, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  let baseUrl: string;
  const devices: Device[] = [];

  beforeAll(async () => {
    ctx = await setupIntegrationEnv({ EDGE_SECRET });
    app = await startApp(ctx.env);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.getHttpServer().address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const device of devices) {
      device.ws.terminate();
    }
    await app?.close();
    await ctx?.teardown();
  });

  // The edge secret travels on HTTP requests through app.inject too (the edge guard checks every request).
  const edge = { 'x-bedo-edge-secret': EDGE_SECRET };

  function open(options: { origin?: string; secret?: string | null; path?: string } = {}): Promise<{ device?: Device; status?: number }> {
    const headers: Record<string, string> = {};
    const secret = options.secret === undefined ? EDGE_SECRET : options.secret;
    if (secret) {
      headers['x-bedo-edge-secret'] = secret;
    }
    const ws = new WebSocket(`${baseUrl}${options.path ?? '/v1/realtime'}`, { origin: options.origin ?? WEB_ORIGIN, headers });
    return new Promise((resolve) => {
      ws.once('unexpected-response', (_request, response) => {
        resolve({ status: response.statusCode });
        ws.terminate();
      });
      ws.once('error', () => undefined);
      ws.once('open', () => {
        const received: RealtimeServerMessage[] = [];
        const waiters: Array<() => void> = [];
        ws.on('message', (data) => {
          received.push(JSON.parse(String(data)) as RealtimeServerMessage);
          for (const waiter of [...waiters]) waiter();
        });
        const closed = new Promise<number>((done) => ws.once('close', (code) => done(code)));
        const device: Device = {
          ws,
          received,
          closed,
          send: (message) => ws.send(JSON.stringify(message)),
          next: (match, timeoutMs = 5_000) =>
            new Promise((done, fail) => {
              let index = 0;
              const check = () => {
                for (; index < received.length; index += 1) {
                  const message = received[index]!;
                  if (match(message)) {
                    index += 1;
                    cleanup();
                    done(message);
                    return;
                  }
                }
              };
              const timer = setTimeout(() => {
                cleanup();
                fail(new Error(`no matching realtime message; received: ${JSON.stringify(received.map((m) => m.type))}`));
              }, timeoutMs);
              const cleanup = () => {
                clearTimeout(timer);
                const at = waiters.indexOf(check);
                if (at >= 0) waiters.splice(at, 1);
              };
              waiters.push(check);
              check();
            }),
          none: async (match, waitMs = 1_000) => {
            const start = received.length;
            await new Promise((done) => setTimeout(done, waitMs));
            expect(received.slice(start).filter(match)).toEqual([]);
          },
        };
        devices.push(device);
        resolve({ device });
      });
    });
  }

  async function connect(user: TestUser, since?: number): Promise<Device> {
    const { device } = await open();
    if (!device) {
      throw new Error('handshake refused');
    }
    device.send({ type: 'auth', token: user.token });
    const ready = await device.next(isType('ready'));
    device.send({ type: 'sync', since: since ?? ready.seq });
    return device;
  }

  // Through the edge: requests carry the edge secret (EDGE_SECRET is set for this app).
  const api = (user: TestUser) => client(app, user, edge);
  const newUser = (name: string) => createUser(ctx, app, name, edge);

  it('accepts upgrades only on /v1/realtime, from the web app origin, through the edge', async () => {
    expect((await open({ path: '/v1/other' })).status).toBe(404);
    expect((await open({ origin: 'https://evil.example' })).status).toBe(403);
    expect((await open({ origin: ADMIN_ORIGIN })).status).toBe(403);
    expect((await open({ secret: null })).status).toBe(403);
    expect((await open({ secret: randomBytes(32).toString('base64') })).status).toBe(403);
    const ok = await open();
    expect(ok.device).toBeDefined();
    ok.device!.ws.close();
  });

  it('closes connections with a bad token or that speak before authenticating', async () => {
    const bad = (await open()).device!;
    bad.send({ type: 'auth', token: 'not-a-token' });
    expect(await bad.closed).toBe(REALTIME_CLOSE.unauthenticated);
    const early = (await open()).device!;
    early.send({ type: 'sync', since: 0 });
    expect(await early.closed).toBe(REALTIME_CLOSE.unauthenticated);
    const garbage = (await open()).device!;
    garbage.ws.send('{not json');
    expect(await garbage.closed).toBe(REALTIME_CLOSE.invalidMessage);
  });

  it('delivers new messages to every device of both users, with delivered status back to the sender', async () => {
    const ana = await newUser('Ana Realtime');
    const ben = await newUser('Ben Realtime');
    const chat = await api(ana).openChat(ben);
    const anaPhone = await connect(ana);
    const benLaptop = await connect(ben);
    const sent = (await api(ana).send(chat.id, 'hello over the socket')).body;
    const onBen = await benLaptop.next(isType('updates', (m) => m.sync.messages.some((message) => message.id === sent.id)));
    expect(onBen.sync.updates.map((update) => update.kind)).toContain('message.new');
    expect(onBen.sync.chats[0]).toMatchObject({ id: chat.id, unreadCount: 1 });
    // Ana's own device hears about her message too (multi-device sync).
    await anaPhone.next(isType('updates', (m) => m.sync.messages.some((message) => message.id === sent.id)));
    benLaptop.send({ type: 'delivered', chatId: chat.id, seq: sent.seq });
    const delivered = await anaPhone.next(isType('updates', (m) => m.sync.updates.some((update) => update.kind === 'chat.delivered')));
    expect(delivered.sync.chats[0]!.peerDeliveredSeq).toBe(sent.seq);
  });

  it('catches a device up after a disconnect, from the last seq it holds', async () => {
    const cai = await newUser('Cai Offline');
    const dee = await newUser('Dee Online');
    const chat = await api(dee).openChat(cai);
    const caiDevice = await connect(cai);
    const first = (await api(dee).send(chat.id, 'one')).body;
    const got = await caiDevice.next(isType('updates', (m) => m.sync.messages.some((message) => message.id === first.id)));
    caiDevice.ws.close();
    await caiDevice.closed;
    await resetMessageLimit(ctx, dee.id);
    const second = (await api(dee).send(chat.id, 'two')).body;
    const third = (await api(dee).send(chat.id, 'three')).body;
    const back = await connect(cai, got.sync.seq);
    const caughtUp = await back.next(isType('updates', (m) => m.sync.messages.some((message) => message.id === third.id)));
    const ids = back.received.flatMap((m) => (m.type === 'updates' ? m.sync.messages.map((message) => message.id) : []));
    expect(ids).toEqual(expect.arrayContaining([second.id, third.id]));
    expect(ids).not.toContain(first.id);
    expect(caughtUp.sync.resync).toBe(false);
  });

  it('relays typing only where a message could be sent, and presence only where privacy allows', async () => {
    const eve = await newUser('Eve Typing');
    const fin = await newUser('Fin Watching');
    const chat = await api(eve).openChat(fin);
    await api(eve).send(chat.id, 'hi');
    const finDevice = await connect(fin);
    // Eve coming online is shown to Fin (last seen Everyone).
    const eveDevice = await connect(eve);
    const online = await finDevice.next(isType('presence', (m) => m.userId === eve.id));
    expect(online.presence).toEqual({ online: true, lastSeenAt: null });
    eveDevice.send({ type: 'typing', chatId: chat.id });
    await finDevice.next(isType('typing', (m) => m.chatId === chat.id && m.userId === eve.id));
    // Fin blocks Eve: her typing no longer reaches him.
    await api(fin).post(`/v1/users/${eve.id}/block`);
    await new Promise((done) => setTimeout(done, 2_100));
    eveDevice.send({ type: 'typing', chatId: chat.id });
    await finDevice.none((m) => m.type === 'typing', 1_000);
    // Eve hides her last seen: going offline is not announced to Fin.
    await api(fin).del(`/v1/users/${eve.id}/block`);
    await api(eve).patch('/v1/me/privacy', { lastSeenVisibility: 'nobody' });
    eveDevice.ws.close();
    await eveDevice.closed;
    await finDevice.none((m) => m.type === 'presence' && m.userId === eve.id, 1_000);
  });

  it('stops delivering to a device as soon as its session ends, without waiting for a heartbeat', async () => {
    const hal = await newUser('Hal Revoked');
    const ivy = await newUser('Ivy Sender');
    const chat = (await api(ivy).openChat(hal));
    const device = await connect(hal);
    const before = (await api(ivy).send(chat.id, 'before revoke')).body;
    await device.next(isType('updates', (m) => m.sync.messages.some((message) => message.id === before.id)));
    await query(ctx.ownerUrl, "update app.sessions set revoked_at = now(), revoke_reason = 'terminated_by_user' where id = $1", [hal.sessionId]);
    const after = (await api(ivy).send(chat.id, 'secret after revoke')).body;
    expect(await device.closed).toBe(REALTIME_CLOSE.unauthenticated);
    const delivered = device.received.flatMap((m) => (m.type === 'updates' ? m.sync.messages.map((message) => message.id) : []));
    expect(delivered).not.toContain(after.id);
  });

  it('limits connections per account and unauthenticated connections per address', async () => {
    const jay = await newUser('Jay Many');
    const many: Device[] = [];
    for (let index = 0; index < 10; index += 1) {
      many.push(await connect(jay));
    }
    const { device: extra } = await open();
    extra!.send({ type: 'auth', token: jay.token });
    expect(await extra!.closed).toBe(REALTIME_CLOSE.tooManyConnections);
    for (const device of many) device.ws.close();
    await Promise.all(many.map((device) => device.closed));
    // Unauthenticated connections from one address.
    const idle: Device[] = [];
    for (let index = 0; index < 20; index += 1) {
      const opened = await open();
      idle.push(opened.device!);
    }
    expect((await open()).status).toBe(429);
    for (const device of idle) device.ws.close();
    await Promise.all(idle.map((device) => device.closed));
    expect((await open()).device).toBeDefined();
  });

  it('disconnects a device when its session ends (checked on every heartbeat)', async () => {
    const gil = await newUser('Gil Session');
    const device = await connect(gil);
    device.send({ type: 'ping' });
    await device.next(isType('pong'));
    await query(ctx.ownerUrl, "update app.sessions set revoked_at = now(), revoke_reason = 'logout' where id = $1", [gil.sessionId]);
    device.send({ type: 'ping' });
    expect(await device.closed).toBe(REALTIME_CLOSE.unauthenticated);
  });
});
