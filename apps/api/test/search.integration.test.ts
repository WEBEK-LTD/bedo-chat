import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeMediaStorage, type IntegrationEnv, query, setupIntegrationEnv, startApp } from './integration-env.js';
import { client, createUser, resetMessageLimit, type TestUser } from './messaging-helpers.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const JPEG = (size: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), Buffer.alloc(size - 10, 7)]);
const PDF = (size: number) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(size - 9, 32)]);

interface Hit {
  id: string;
  chatId: string;
  senderId: string;
  text: string | null;
  sender: unknown;
  attachment: { kind: string; fileName: string | null } | null;
}

describe.runIf(enabled)('Phase 8 global search (real Postgres, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  let storage: FakeMediaStorage;
  const users: TestUser[] = [];
  let ana: TestUser;
  let ben: TestUser;
  let cleo: TestUser;
  let dan: TestUser;
  let api: (user: TestUser) => ReturnType<typeof client>;

  async function newUser(name: string): Promise<TestUser> {
    const user = await createUser(ctx, app, name);
    users.push(user);
    return user;
  }

  const search = async (user: TestUser, params: Record<string, string>) => {
    const response = await api(user).get(`/v1/search?${new URLSearchParams(params).toString()}`);
    return response as { status: number; body: { messages: Hit[]; nextCursor: string | null; error?: { code: string } } };
  };
  const texts = (hits: Hit[]) => hits.map((hit) => hit.text);

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    storage = new FakeMediaStorage();
    app = await startApp(ctx.env, undefined, { storage });
    api = (user) => client(app, user);
    ana = await newUser('Ana Search');
    ben = await newUser('Ben Search');
    cleo = await newUser('Cleo Search');
    dan = await newUser('Dan Outside');
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

  it('finds words across the user’s own chats only, never deleted or hidden messages', async () => {
    const ab = await api(ana).openChat(ben);
    const cd = await api(cleo).openChat(dan);
    await api(ben).send(ab.id, 'Physics homework is due Monday');
    await api(dan).send(cd.id, 'Physics secret between Cleo and Dan');
    const gone = await api(ben).send(ab.id, 'Physics answers, deleted later');
    const hidden = await api(ben).send(ab.id, 'Physics notes Ana hides');
    await api(ben).post('/v1/messages/delete', { chatId: ab.id, messageIds: [gone.body.id], scope: 'both' });
    await api(ana).post('/v1/messages/delete', { chatId: ab.id, messageIds: [hidden.body.id], scope: 'me' });

    const found = await search(ana, { q: 'physics' });
    expect(found.status).toBe(200);
    expect(texts(found.body.messages)).toEqual(['Physics homework is due Monday']);
    // Parts of words match too.
    expect(texts((await search(ana, { q: 'homew' })).body.messages)).toEqual(['Physics homework is due Monday']);
    // Ben still finds what only Ana hid; nobody finds what was deleted for both.
    expect(texts((await search(ben, { q: 'physics' })).body.messages)).toEqual(['Physics notes Ana hides', 'Physics homework is due Monday']);
    // Dan's chat is not Ana's: nothing from it, even by chat id.
    expect((await search(ana, { q: 'secret' })).body.messages).toEqual([]);
    expect((await search(ana, { q: 'physics', chatId: cd.id })).body.messages).toEqual([]);
    // There must be something to search for.
    expect((await search(ana, {})).status).toBe(400);
    expect((await search(ana, { q: 'x'.repeat(101) })).status).toBe(400);
  });

  it('filters by sender and dates, hides who posted in channels, and forgets chats the user left', async () => {
    const group = (await api(ana).post('/v1/groups', { title: 'Lab group', memberIds: [ben.id, cleo.id] })).body;
    await api(ben).send(group.id, 'Lab report template attached');
    await api(cleo).send(group.id, 'Lab starts at nine');
    expect(texts((await search(ana, { q: 'lab', fromUserId: ben.id })).body.messages)).toEqual(['Lab report template attached']);
    // From someone, with no words.
    expect(texts((await search(ana, { fromUserId: cleo.id })).body.messages)).toContain('Lab starts at nine');
    const future = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 3600_000).toISOString();
    expect((await search(ana, { q: 'lab', after: future })).body.messages).toEqual([]);
    expect((await search(ana, { q: 'lab', before: past })).body.messages).toEqual([]);
    expect((await search(ana, { q: 'lab', after: past, before: future })).body.messages).toHaveLength(2);

    // A channel: subscribers find posts as from the channel, and cannot search by who posted.
    await query(ctx.ownerUrl, 'insert into app.user_permissions (user_id, create_channels) values ($1, true)', [cleo.id]);
    const channel = (await api(cleo).post('/v1/channels', { title: 'Cleo news', isPublic: true })).body;
    await api(ana).post(`/v1/channels/${channel.id}/join`);
    await api(cleo).send(channel.id, 'Lab closed tomorrow');
    const post = (await search(ana, { q: 'closed' })).body.messages;
    expect(post).toEqual([expect.objectContaining({ text: 'Lab closed tomorrow', senderId: channel.id, sender: null })]);
    expect(JSON.stringify(post)).not.toContain(cleo.id);
    expect((await search(ana, { q: 'closed', fromUserId: cleo.id })).body.messages).toEqual([]);
    // The owner sees her own posts by sender.
    expect(texts((await search(cleo, { q: 'closed', fromUserId: cleo.id })).body.messages)).toEqual(['Lab closed tomorrow']);

    // Leaving the group removes its messages from Ana's results; a deleted group from everyone's.
    await api(ana).post(`/v1/groups/${group.id}/owner`, { userId: ben.id });
    await api(ana).post(`/v1/groups/${group.id}/leave`);
    expect(texts((await search(ana, { q: 'lab' })).body.messages)).toEqual(['Lab closed tomorrow']);
    await api(ben).del(`/v1/groups/${group.id}`);
    expect(texts((await search(cleo, { q: 'lab' })).body.messages)).toEqual(['Lab closed tomorrow']);
  });

  it('finds files by name and kind, images without words, and pages through many results', async () => {
    const chat = await api(ana).openChat(dan);
    const upload = async (kind: string, mimeType: string, bytes: Buffer, fileName?: string) => {
      const slot = await api(dan).post('/v1/files/uploads', { chatId: chat.id, kind, mimeType, size: bytes.length, ...(fileName ? { fileName } : {}) });
      expect(slot.status, JSON.stringify(slot.body)).toBe(200);
      storage.upload(slot.body.upload.url, bytes);
      const sent = await api(dan).post(`/v1/chats/${chat.id}/messages`, { clientId: randomUUID(), fileId: slot.body.fileId });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      return sent.body as Hit;
    };
    const pdf = await upload('file', 'application/pdf', PDF(2000), 'Course syllabus 2026.pdf');
    const photo = await upload('photo', 'image/jpeg', JPEG(3000));
    const byName = (await search(ana, { q: 'syllabus', kind: 'files' })).body.messages;
    expect(byName.map((hit) => hit.id)).toEqual([pdf.id]);
    expect(byName[0]!.attachment).toMatchObject({ kind: 'file', fileName: 'Course syllabus 2026.pdf' });
    expect((await search(ana, { q: 'syllabus', kind: 'media' })).body.messages).toEqual([]);
    expect((await search(ana, { kind: 'media' })).body.messages.map((hit) => hit.id)).toEqual([photo.id]);
    expect((await search(ben, { kind: 'media' })).body.messages).toEqual([]);

    for (let index = 0; index < 35; index += 1) {
      await resetMessageLimit(ctx, dan.id);
      await api(dan).send(chat.id, `bulk message ${index}`);
    }
    const first = await search(ana, { q: 'bulk' });
    expect(first.body.messages).toHaveLength(30);
    expect(first.body.messages[0]!.text).toBe('bulk message 34');
    expect(first.body.nextCursor).not.toBeNull();
    const second = await search(ana, { q: 'bulk', cursor: first.body.nextCursor! });
    expect(texts(second.body.messages)).toEqual(['bulk message 4', 'bulk message 3', 'bulk message 2', 'bulk message 1', 'bulk message 0']);
    expect(second.body.nextCursor).toBeNull();
  });
});
