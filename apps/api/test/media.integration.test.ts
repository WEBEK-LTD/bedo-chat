import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { MEDIA_RULES } from '@bedo/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminClient, createTestAdmin } from './admin-helpers.js';
import { FakeGifProvider, FakeMediaStorage, type IntegrationEnv, query, setupIntegrationEnv, startApp } from './integration-env.js';
import { client, createUser, resetMessageLimit, type TestUser } from './messaging-helpers.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);
/** A made-up GIPHY key (a real key never appears in tests). */
const TEST_GIPHY_KEY = ['Giphy', 'Test', 'Key123'].join('');

const pad = (head: number[], size: number) => Buffer.concat([Buffer.from(head), Buffer.alloc(Math.max(0, size - head.length), 7)]);
export const JPEG = (size = 4000) => pad([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46], size);
const ZIP = (size = 3000) => pad([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00], size);
const EXE = (size = 3000) => pad([0x4d, 0x5a, 0x90, 0x00], size);
const MP4 = (size = 5000) => pad([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], size);
const WEBM = (size = 5000) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from('webm'), Buffer.alloc(size - 16, 3)]);
const WEBP = (size = 600) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(size - 16, 1)]);
/** PNG header with an IHDR chunk of the given size (enough for the size check). */
const PNG = (width: number, height: number, size = 900) => {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return Buffer.concat([head, Buffer.alloc(size - 33, 2)]);
};

describe.runIf(enabled)('Phase 4 media: files, stickers, GIFs, reactions (real Postgres, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  let storage: FakeMediaStorage;
  let gifs: FakeGifProvider;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let chatId: string;
  let carolChatId: string;

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    storage = new FakeMediaStorage();
    gifs = new FakeGifProvider();
    app = await startApp(ctx.env, undefined, { storage, gifs });
    alice = await createUser(ctx, app, 'Alice');
    bob = await createUser(ctx, app, 'Bob');
    carol = await createUser(ctx, app, 'Carol');
    chatId = (await client(app, alice).openChat(bob)).id;
    carolChatId = (await client(app, carol).openChat(bob)).id;
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  beforeEach(async () => {
    for (const user of [alice, bob, carol]) {
      await resetMessageLimit(ctx, user.id);
      await query(ctx.ownerUrl, 'delete from app.rate_counters where key like $1', [`rl:%:${user.id}`]);
    }
  });

  /** Asks for a slot, uploads (unless told not to) and returns the slot. */
  async function upload(user: TestUser, body: Record<string, unknown>, bytes: Buffer | null, thumbnail: Buffer | null = null) {
    const slot = await client(app, user).post('/v1/files/uploads', { chatId, ...body });
    expect(slot.status, JSON.stringify(slot.body)).toBe(200);
    if (bytes) expect(storage.upload(slot.body.upload.url, bytes)).toBe(true);
    if (thumbnail) expect(storage.upload(slot.body.thumbnailUpload.url, thumbnail)).toBe(true);
    return slot.body as { fileId: string; upload: { url: string; method: string; headers: Record<string, string> }; thumbnailUpload: { url: string } | null };
  }

  const sendFile = (user: TestUser, fileId: string, extra: Record<string, unknown> = {}, target = chatId) =>
    client(app, user).post(`/v1/chats/${target}/messages`, { clientId: randomUUID(), fileId, ...extra });

  it('gives upload slots only for a chat the person can send to, within the limits', async () => {
    const alices = client(app, alice);
    // Not a member of Carol's chat: the same 404 as a chat that does not exist.
    expect((await alices.post('/v1/files/uploads', { chatId: carolChatId, kind: 'photo', mimeType: 'image/jpeg', size: 1000 })).status).toBe(404);
    // Too large for the kind, a program, a waveform on a photo, an over-long voice message.
    expect((await alices.post('/v1/files/uploads', { chatId, kind: 'photo', mimeType: 'image/jpeg', size: MEDIA_RULES.maxBytes.photo + 1 })).status).toBe(400);
    expect((await alices.post('/v1/files/uploads', { chatId, kind: 'video', mimeType: 'video/mp4', size: MEDIA_RULES.maxFileBytes + 1 })).status).toBe(400);
    expect((await alices.post('/v1/files/uploads', { chatId, kind: 'file', mimeType: 'application/octet-stream', size: 100, fileName: 'setup.EXE' })).status).toBe(400);
    expect((await alices.post('/v1/files/uploads', { chatId, kind: 'photo', mimeType: 'image/jpeg', size: 100, waveform: [1, 2] })).status).toBe(400);
    expect((await alices.post('/v1/files/uploads', { chatId, kind: 'voice', mimeType: 'audio/ogg', size: 100, durationMs: MEDIA_RULES.voiceMaxDurationMs + 1 })).status).toBe(400);
    expect((await alices.post('/v1/files/uploads', { chatId, kind: 'video_note', mimeType: 'video/mp4', size: 100, durationMs: 61_000 })).status).toBe(400);
    // A slot: one-time URLs that cannot overwrite, the file's and the preview's.
    const slot = await alices.post('/v1/files/uploads', { chatId, kind: 'photo', mimeType: 'image/jpeg', size: 1000, width: 800, height: 600, thumbnail: { mimeType: 'image/jpeg', size: 500 } });
    expect(slot.status).toBe(200);
    expect(slot.body.upload).toMatchObject({ method: 'PUT', headers: { 'content-type': 'image/jpeg', 'x-upsert': 'false' } });
    expect(slot.body.thumbnailUpload).not.toBeNull();
    const row = await query(ctx.ownerUrl, 'select status, owner_id, object_path, thumbnail_path from app.files where id = $1', [slot.body.fileId]);
    expect(row.rows[0]).toMatchObject({ status: 'pending', owner_id: alice.id });
    expect(row.rows[0]!.object_path).toMatch(/^photo\/[0-9a-f-]{36}\.jpg$/);
    // Blocked: no slots.
    await client(app, bob).post(`/v1/users/${alice.id}/block`);
    expect((await alices.post('/v1/files/uploads', { chatId, kind: 'photo', mimeType: 'image/jpeg', size: 1000 })).body.error.code).toBe('CANNOT_MESSAGE');
    await client(app, bob).del(`/v1/users/${alice.id}/block`);
  });

  it('sends a photo only after reading it back, with its preview, and lets only chat members download it', async () => {
    const slot = await upload(alice, { kind: 'photo', mimeType: 'image/jpeg', size: 4000, width: 1600, height: 1200, thumbnail: { mimeType: 'image/jpeg', size: 300 } }, JPEG(4000), JPEG(300));
    const sent = await sendFile(alice, slot.fileId, { text: 'Our class photo' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body).toMatchObject({
      kind: 'media',
      text: 'Our class photo',
      attachment: { id: slot.fileId, kind: 'photo', mimeType: 'image/jpeg', size: 4000, width: 1600, height: 1200 },
      sticker: null,
      reactions: [],
    });
    expect(sent.body.attachment.thumbnailUrl).toMatch(/^https:\/\/storage\.bedo\.test\/sign\/chat-media\/thumbs\//);
    expect(storage.signed.at(-1)!.expiresInSeconds).toBe(MEDIA_RULES.thumbnailUrlSeconds);

    // Bob sees it through sync and downloads it (5 minutes, shown inline); Carol cannot.
    const bobs = client(app, bob);
    const history = await bobs.get(`/v1/chats/${chatId}/messages`);
    expect(history.body.messages.at(-1).attachment.id).toBe(slot.fileId);
    const link = await bobs.get(`/v1/messages/${sent.body.id}/file`);
    expect(link.status).toBe(200);
    expect(link.body.expiresInSeconds).toBe(300);
    expect(storage.objectFor(link.body.url)).toEqual(JPEG(4000));
    expect(storage.signed.at(-1)!.download).toBeUndefined();
    expect((await bobs.get(`/v1/messages/${sent.body.id}/file?download=true`)).status).toBe(200);
    expect(storage.signed.at(-1)!.download).toMatch(/\.jpg$/);
    expect((await client(app, carol).get(`/v1/messages/${sent.body.id}/file`)).status).toBe(404);

    // Sending the same file again is refused (it is forwarded instead); someone else cannot send it at all.
    expect((await sendFile(alice, slot.fileId)).status).toBe(409);
    expect((await client(app, bob).post(`/v1/chats/${chatId}/messages`, { clientId: randomUUID(), fileId: slot.fileId })).status).toBe(404);
    // A retry with the same client id returns the stored message.
  });

  it('refuses a file whose bytes are not what was declared, and removes it', async () => {
    // Declared a photo, uploaded a ZIP: refused, slot and object removed.
    const fake = await upload(alice, { kind: 'photo', mimeType: 'image/jpeg', size: 3000 }, ZIP(3000));
    const refused = await sendFile(alice, fake.fileId);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('FILE_INVALID');
    expect((await query(ctx.ownerUrl, 'select count(*)::int as n from app.files where id = $1', [fake.fileId])).rows[0]).toEqual({ n: 0 });
    expect(storage.removed.some((key) => key.startsWith('chat-media/photo/'))).toBe(true);

    // A different size than declared.
    const resized = await upload(alice, { kind: 'photo', mimeType: 'image/jpeg', size: 3000 }, JPEG(3500));
    expect((await sendFile(alice, resized.fileId)).body.error.code).toBe('FILE_INVALID');

    // A program renamed as a document.
    const program = await upload(alice, { kind: 'file', mimeType: 'application/pdf', size: 3000, fileName: 'notes.pdf' }, EXE(3000));
    expect((await sendFile(alice, program.fileId)).body.error.code).toBe('FILE_INVALID');

    // Not uploaded yet: refused, but the slot stays, so the upload can finish and the send be retried.
    const late = await upload(alice, { kind: 'video', mimeType: 'video/mp4', size: 5000, durationMs: 3000 }, null);
    expect((await sendFile(alice, late.fileId)).body.error.code).toBe('FILE_INVALID');
    expect(storage.upload(late.upload.url, MP4(5000))).toBe(true);
    const retried = await sendFile(alice, late.fileId);
    expect(retried.status).toBe(200);
    expect(retried.body.attachment).toMatchObject({ kind: 'video', mimeType: 'video/mp4', durationMs: 3000 });
    // A second upload to the same URL cannot replace it.
    expect(storage.upload(late.upload.url, ZIP(5000))).toBe(false);

    // A preview that is not a picture is dropped; the file is still sent.
    const odd = await upload(alice, { kind: 'photo', mimeType: 'image/jpeg', size: 2000, thumbnail: { mimeType: 'image/jpeg', size: 400 } }, JPEG(2000), ZIP(400));
    const sent = await sendFile(alice, odd.fileId);
    expect(sent.body.attachment.thumbnailUrl).toBeNull();
  });

  it('sends voice messages, video messages and files of each kind, typed from their bytes', async () => {
    const voice = await upload(alice, { kind: 'voice', mimeType: 'audio/webm', size: 5000, durationMs: 4200, waveform: [0, 10, 50, 100, 30] }, WEBM(5000));
    const voiceMessage = await sendFile(alice, voice.fileId);
    expect(voiceMessage.body.attachment).toMatchObject({ kind: 'voice', mimeType: 'audio/webm', durationMs: 4200, waveform: [0, 10, 50, 100, 30] });

    const note = await upload(alice, { kind: 'video_note', mimeType: 'video/webm', size: 5000, durationMs: 12_000 }, WEBM(5000));
    expect((await sendFile(alice, note.fileId)).body.attachment).toMatchObject({ kind: 'video_note', mimeType: 'video/webm' });

    // Any document; always downloaded under its name, never shown by the browser.
    const doc = await upload(alice, { kind: 'file', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 3000, fileName: 'Homework 3.docx' }, ZIP(3000));
    expect(doc.upload.headers['content-type']).toBe('application/octet-stream');
    const docMessage = await sendFile(alice, doc.fileId, { text: 'Due Friday' });
    expect(docMessage.body.attachment).toMatchObject({ kind: 'file', fileName: 'Homework 3.docx', size: 3000 });
    await client(app, bob).get(`/v1/messages/${docMessage.body.id}/file`);
    expect(storage.signed.at(-1)!.download).toBe('Homework 3.docx');

    // The media panel: one tab per group of kinds, newest first, only what the viewer can see.
    const media = await client(app, bob).get(`/v1/chats/${chatId}/media?kind=media`);
    expect(media.body.messages.map((message: { attachment: { kind: string } }) => message.attachment.kind)).toEqual(expect.arrayContaining(['video_note', 'photo', 'video']));
    expect(media.body.messages.every((message: { attachment: { kind: string } }) => ['photo', 'video', 'gif', 'video_note'].includes(message.attachment.kind))).toBe(true);
    expect((await client(app, bob).get(`/v1/chats/${chatId}/media?kind=voice`)).body.messages.map((message: { id: string }) => message.id)).toEqual([voiceMessage.body.id]);
    expect((await client(app, bob).get(`/v1/chats/${chatId}/media?kind=files`)).body.messages[0].id).toBe(docMessage.body.id);
    expect((await client(app, carol).get(`/v1/chats/${chatId}/media?kind=media`)).status).toBe(404);
  });

  it('forwards by reference, edits captions, and locks the file of a deleted message (D-38)', async () => {
    const slot = await upload(alice, { kind: 'photo', mimeType: 'image/jpeg', size: 4000 }, JPEG(4000));
    const original = await sendFile(alice, slot.fileId);
    expect(original.body.text).toBeNull();

    // Adding a caption to a photo sent without one is an edit with its revision.
    const edited = await client(app, alice).patch(`/v1/messages/${original.body.id}`, { text: 'Added later' });
    expect(edited.status).toBe(200);
    expect(edited.body.text).toBe('Added later');

    // Bob forwards it to Carol: the copy carries the same file.
    const forwarded = await client(app, bob).post('/v1/messages/forward', {
      fromChatId: chatId,
      messageIds: [original.body.id],
      targets: [{ chatId: carolChatId, clientId: randomUUID() }],
    });
    expect(forwarded.status).toBe(200);
    const copy = forwarded.body.messages[0];
    expect(copy.attachment.id).toBe(slot.fileId);
    expect(copy.forwardedFrom.id).toBe(alice.id);
    expect((await client(app, carol).get(`/v1/messages/${copy.id}/file`)).status).toBe(200);

    // Alice deletes hers for both sides: the file disappears from the message and cannot be downloaded through it.
    expect((await client(app, alice).post('/v1/messages/delete', { chatId, messageIds: [original.body.id], scope: 'both' })).status).toBe(200);
    const after = (await client(app, bob).get(`/v1/chats/${chatId}/messages`)).body.messages.find((message: { id: string }) => message.id === original.body.id);
    expect(after).toMatchObject({ deleted: true, text: null, attachment: null, reactions: [] });
    expect((await client(app, bob).get(`/v1/messages/${original.body.id}/file`)).status).toBe(404);
    // The forwarded copy is another message: it keeps working.
    expect((await client(app, carol).get(`/v1/messages/${copy.id}/file`)).status).toBe(200);

    // The history keeps everything: revisions name the file, and the file can never be removed.
    const revisions = await query(ctx.ownerUrl, 'select action, previous_text, new_text, file_id from audit.message_revisions where message_id = $1 order by id', [original.body.id]);
    expect(revisions.rows).toEqual([
      { action: 'edited', previous_text: null, new_text: 'Added later', file_id: slot.fileId },
      { action: 'deleted_for_both', previous_text: 'Added later', file_id: slot.fileId, new_text: null },
    ]);
    expect(storage.objects.has(`chat-media/${(await query(ctx.ownerUrl, 'select object_path from app.files where id = $1', [slot.fileId])).rows[0]!.object_path}`)).toBe(true);
    await expect(query(ctx.runtimeUrl, 'delete from app.files where id = $1', [slot.fileId])).rejects.toThrow(/part of the history/);
    await expect(query(ctx.ownerUrl, 'delete from app.files where id = $1', [slot.fileId])).rejects.toThrow(/part of the history/);
    await expect(query(ctx.runtimeUrl, `update app.files set object_path = 'photo/00000000-0000-0000-0000-000000000000.jpg' where id = $1`, [slot.fileId])).rejects.toThrow(/cannot change/);
  });

  it('keeps one reaction per person per message, from the fixed set, and tells both sides', async () => {
    const message = await client(app, alice).send(chatId, 'React to this');
    const id = message.body.id;
    const bobs = client(app, bob);
    expect((await bobs.put(`/v1/messages/${id}/reaction`, { emoji: '🍕' })).status).toBe(400);
    expect((await bobs.put(`/v1/messages/${id}/reaction`, { emoji: '👍' })).body.reactions).toEqual([{ emoji: '👍', count: 1, mine: true }]);
    const both = await client(app, alice).put(`/v1/messages/${id}/reaction`, { emoji: '👍' });
    expect(both.body.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }]);
    // Changing replaces; the order follows the reaction set.
    const changed = await bobs.put(`/v1/messages/${id}/reaction`, { emoji: '❤️' });
    expect(changed.body.reactions).toEqual([
      { emoji: '👍', count: 1, mine: false },
      { emoji: '❤️', count: 1, mine: true },
    ]);
    // Alice's devices hear about it and fetch the message.
    const sync = await client(app, alice).get('/v1/sync?since=0');
    const update = sync.body.updates.filter((entry: { kind: string; messageId: string }) => entry.kind === 'message.reactions' && entry.messageId === id);
    expect(update.length).toBeGreaterThanOrEqual(2);
    expect(sync.body.messages.find((entry: { id: string }) => entry.id === id).reactions).toEqual([
      { emoji: '👍', count: 1, mine: true },
      { emoji: '❤️', count: 1, mine: false },
    ]);
    expect((await bobs.del(`/v1/messages/${id}/reaction`)).body.reactions).toEqual([{ emoji: '👍', count: 1, mine: false }]);
    // Not a member: not found.
    expect((await client(app, carol).put(`/v1/messages/${id}/reaction`, { emoji: '👍' })).status).toBe(404);
    // Blocked: cannot react (taking a reaction back still works).
    await client(app, alice).post(`/v1/users/${bob.id}/block`);
    expect((await bobs.put(`/v1/messages/${id}/reaction`, { emoji: '🔥' })).body.error.code).toBe('CANNOT_MESSAGE');
    expect((await client(app, alice).del(`/v1/messages/${id}/reaction`)).status).toBe(200);
    await client(app, alice).del(`/v1/users/${bob.id}/block`);
    // Deleted messages take no reactions.
    await client(app, alice).post('/v1/messages/delete', { chatId, messageIds: [id], scope: 'both' });
    expect((await bobs.put(`/v1/messages/${id}/reaction`, { emoji: '👍' })).status).toBe(404);
  });

  it('lets Super Admins manage sticker packs that students send from', async () => {
    const superAdmin = await adminClient(app, await createTestAdmin(ctx, app, 'super_admin'));
    const moderator = await adminClient(app, await createTestAdmin(ctx, app, 'moderator'));
    expect((await moderator.post('/v1/admin/stickers/packs', { name: 'Not allowed' })).status).toBe(403);
    const created = await superAdmin.post('/v1/admin/stickers/packs', { name: 'Academy' });
    expect(created.status).toBe(200);
    const packId = created.body.packs.find((pack: { name: string }) => pack.name === 'Academy').id;
    // Not an image, too large in bytes or in pixels: refused.
    expect((await superAdmin.post(`/v1/admin/stickers/packs/${packId}/stickers`, { emoji: '😀', data: ZIP(500).toString('base64') })).body.error.code).toBe('FILE_INVALID');
    expect((await superAdmin.post(`/v1/admin/stickers/packs/${packId}/stickers`, { emoji: '😀', data: PNG(513, 100).toString('base64') })).body.error.code).toBe('FILE_INVALID');
    const added = await superAdmin.post(`/v1/admin/stickers/packs/${packId}/stickers`, { emoji: '😀', data: PNG(512, 512).toString('base64') });
    expect(added.status).toBe(200);
    const sticker = added.body.packs.find((pack: { id: string }) => pack.id === packId).stickers[0];
    expect(sticker).toMatchObject({ emoji: '😀', width: 512, height: 512, removed: false });
    expect(sticker.url).toMatch(/^https:\/\/storage\.bedo\.test\/public\/stickers\//);
    expect(await moderator.get('/v1/admin/stickers')).toMatchObject({ status: 200 });
    // The dashboard shows the image as a data URL (its security policy allows no storage host).
    const image = await moderator.get(`/v1/admin/stickers/${sticker.id}/image`);
    expect(image.body).toEqual({ mimeType: 'image/png', data: PNG(512, 512).toString('base64') });

    // Students see the pack and send the sticker; a sticker has no caption and cannot be edited.
    const packs = await client(app, alice).get('/v1/stickers');
    expect(packs.body.packs.find((pack: { id: string }) => pack.id === packId).stickers[0].id).toBe(sticker.id);
    expect((await client(app, alice).post(`/v1/chats/${chatId}/messages`, { clientId: randomUUID(), stickerId: sticker.id, text: 'no' })).status).toBe(400);
    const sent = await client(app, alice).post(`/v1/chats/${chatId}/messages`, { clientId: randomUUID(), stickerId: sticker.id });
    expect(sent.body).toMatchObject({ kind: 'sticker', text: null, sticker: { id: sticker.id, emoji: '😀' } });
    expect((await client(app, alice).patch(`/v1/messages/${sent.body.id}`, { text: 'x' })).status).toBe(403);

    // Taken out of the pack: no longer offered or sendable, but the sent message still shows it.
    await superAdmin.del(`/v1/admin/stickers/${sticker.id}`);
    expect((await client(app, alice).get('/v1/stickers')).body.packs.some((pack: { id: string }) => pack.id === packId)).toBe(false);
    expect((await client(app, alice).post(`/v1/chats/${chatId}/messages`, { clientId: randomUUID(), stickerId: sticker.id })).status).toBe(404);
    const history = await client(app, bob).get(`/v1/chats/${chatId}/messages`);
    expect(history.body.messages.find((message: { id: string }) => message.id === sent.body.id).sticker.id).toBe(sticker.id);
    await expect(query(ctx.runtimeUrl, 'delete from app.stickers where id = $1', [sticker.id])).rejects.toThrow();

    const audit = await query(ctx.ownerUrl, `select action from app.audit_log where action like 'stickers.%' order by id`);
    expect(audit.rows.map((row) => row.action)).toEqual(['stickers.pack_created', 'stickers.sticker_added', 'stickers.sticker_removed']);
  });

  it('searches GIFs through the API with the academy key and sends a GIF as a stored copy (O-09)', async () => {
    gifs.add('abc123', MP4(9000), WEBP(600));
    gifs.add('def456', MP4(7000), WEBP(500));
    // No key yet: search is off and sending refused.
    expect((await client(app, alice).get('/v1/gifs/search?q=gif')).body).toEqual({ enabled: false, gifs: [], nextOffset: null });
    expect((await client(app, alice).post(`/v1/chats/${chatId}/messages`, { clientId: randomUUID(), gifId: 'abc123' })).body.error.code).toBe('FEATURE_UNAVAILABLE');

    const superAdmin = await adminClient(app, await createTestAdmin(ctx, app, 'super_admin'));
    expect((await superAdmin.put('/v1/admin/settings/gifs', { apiKey: 'not a key!' })).status).toBe(400);
    const saved = await superAdmin.put('/v1/admin/settings/gifs', { apiKey: TEST_GIPHY_KEY });
    expect(saved.body).toMatchObject({ configured: true });
    expect(JSON.stringify(saved.body)).not.toContain(TEST_GIPHY_KEY);
    const stored = await query(ctx.ownerUrl, 'select giphy_key_enc from app.gif_settings');
    expect(stored.rows[0]!.giphy_key_enc).not.toContain(TEST_GIPHY_KEY);

    const found = await client(app, alice).get('/v1/gifs/search?q=abc');
    expect(found.body.enabled).toBe(true);
    expect(found.body.gifs).toHaveLength(1);
    expect(gifs.calls.at(-1)).toEqual({ apiKey: TEST_GIPHY_KEY, kind: 'search', value: 'abc' });
    // The preview comes through the API with a signed link; a changed or foreign link is refused.
    const preview = found.body.gifs[0].previewUrl as string;
    expect(preview).toMatch(/^\/api\/v1\/gifs\/preview\?u=/);
    const image = await app.inject({ method: 'GET', url: preview.replace(/^\/api/, '') });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toBe('image/webp');
    expect(image.headers['cache-control']).toBe('private, max-age=3600');
    expect(image.rawPayload).toEqual(WEBP(600));
    const forged = preview.replace(encodeURIComponent('https://media.giphy.com/media/abc123/100.webp'), encodeURIComponent('https://evil.example/x.webp'));
    expect((await app.inject({ method: 'GET', url: forged.replace(/^\/api/, '') })).statusCode).toBe(404);

    // Sending copies the MP4 into chat storage once; a second send reuses the same file.
    const first = await client(app, alice).post(`/v1/chats/${chatId}/messages`, { clientId: randomUUID(), gifId: 'abc123' });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.attachment).toMatchObject({ kind: 'gif', mimeType: 'video/mp4', size: 9000, width: 200, height: 150 });
    const second = await client(app, bob).post(`/v1/chats/${chatId}/messages`, { clientId: randomUUID(), gifId: 'abc123' });
    expect(second.body.attachment.id).toBe(first.body.attachment.id);
    const link = await client(app, bob).get(`/v1/messages/${first.body.id}/file`);
    expect(storage.objectFor(link.body.url)).toEqual(MP4(9000));
    expect((await client(app, alice).post(`/v1/chats/${chatId}/messages`, { clientId: randomUUID(), gifId: 'missing1' })).status).toBe(404);
    expect((await client(app, alice).post(`/v1/chats/${chatId}/messages`, { clientId: randomUUID(), gifId: 'abc123', text: 'caption' })).status).toBe(400);
  });

  it('removes upload slots that were never used, and only those', async () => {
    const unused = await upload(alice, { kind: 'photo', mimeType: 'image/jpeg', size: 4000 }, JPEG(4000));
    const used = await upload(alice, { kind: 'photo', mimeType: 'image/jpeg', size: 4000 }, JPEG(4000));
    await sendFile(alice, used.fileId);
    await query(ctx.ownerUrl, `alter table app.files disable trigger files_guard`);
    await query(ctx.ownerUrl, `update app.files set created_at = now() - interval '25 hours' where id = any($1)`, [[unused.fileId, used.fileId]]);
    await query(ctx.ownerUrl, `alter table app.files enable trigger files_guard`);
    const { MaintenanceService } = await import('../src/runtime/maintenance.service.js');
    expect(await app.get(MaintenanceService).pruneUnusedUploads()).toBe(1);
    const left = await query(ctx.ownerUrl, 'select id from app.files where id = any($1)', [[unused.fileId, used.fileId]]);
    expect(left.rows.map((row) => row.id)).toEqual([used.fileId]);
  });
});
