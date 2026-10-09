import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DELETED_ACCOUNT_NAME, MESSAGING_RULES } from '@bedo/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type IntegrationEnv, query, setupIntegrationEnv, startApp } from './integration-env.js';
import { client, createUser, resetMessageLimit, type TestUser } from './messaging-helpers.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Phase 3 messaging core against real Postgres and Redis, with the API connected as the least-privilege
 * runtime role: sending, idempotency, edits and deletions with their audit records, forwarding, pins,
 * chat-list state, folders, blocks and privacy, reports, screenshot intake, user search and sync.
 */
describe.runIf(enabled)('Phase 3 messaging (real Postgres + Redis, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  let ana: TestUser;
  let ben: TestUser;
  let cai: TestUser;

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    app = await startApp(ctx.env);
    ana = await createUser(ctx, app, 'Ana Lopez');
    ben = await createUser(ctx, app, 'Ben Carter');
    cai = await createUser(ctx, app, 'Cai Wen');
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  const owner = (sql: string, params: unknown[] = []) => query(ctx.ownerUrl, sql, params);

  describe('sending and history', () => {
    it('opens one private chat per pair, visible to the other user only after the first message', async () => {
      const a = client(app, ana);
      const b = client(app, ben);
      const chat = await a.openChat(ben);
      expect(chat.type).toBe('private');
      expect(chat.peer).toMatchObject({ id: ben.id, displayName: 'Ben Carter', deleted: false, canMessage: true, blockedByMe: false });
      expect((await b.openChat(ana)).id).toBe(chat.id);
      const benList = async () => (await b.get('/v1/chats')).body.chats.map((c: { id: string }) => c.id);
      expect(await benList()).not.toContain(chat.id);
      expect((await a.get('/v1/chats')).body.chats.map((c: { id: string }) => c.id)).toContain(chat.id);
      await a.send(chat.id, 'Hi Ben');
      expect(await benList()).toContain(chat.id);
      const own = await a.post('/v1/chats', { userId: ana.id });
      expect(own.status).toBe(400);
    });

    it('stores a retried message once (same client id) and returns the same message', async () => {
      const a = client(app, ana);
      const chat = await a.openChat(cai);
      const clientId = randomUUID();
      const [first, second] = await Promise.all([
        a.post(`/v1/chats/${chat.id}/messages`, { clientId, text: '  Hello Cai  ' }),
        a.post(`/v1/chats/${chat.id}/messages`, { clientId, text: '  Hello Cai  ' }),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body.id).toBe(first.body.id);
      expect(first.body).toMatchObject({ text: 'Hello Cai', seq: 1, senderId: ana.id, clientId, deleted: false, replyTo: null, forwardedFrom: null });
      const third = await a.post(`/v1/chats/${chat.id}/messages`, { clientId, text: 'Hello Cai' });
      expect(third.body.id).toBe(first.body.id);
      const rows = await owner('select count(*)::int as n from app.messages where client_id = $1', [clientId]);
      expect(rows.rows[0]!.n).toBe(1);
      // The same client id for a different chat is a mistake, not a retry.
      const other = await a.openChat(ben);
      expect((await a.post(`/v1/chats/${other.id}/messages`, { clientId, text: 'x' })).status).toBe(409);
    });

    it('enforces message length 1-4096 (P-16) and returns pages of history oldest first', async () => {
      const a = client(app, ana);
      const chat = await a.openChat(ben);
      await resetMessageLimit(ctx, ana.id);
      expect((await a.send(chat.id, '   ')).status).toBe(400);
      expect((await a.send(chat.id, 'x'.repeat(MESSAGING_RULES.textMaxLength + 1))).status).toBe(400);
      expect((await a.send(chat.id, 'y'.repeat(MESSAGING_RULES.textMaxLength))).status).toBe(200);
      // Characters, not UTF-16 units: 4,096 characters outside the basic plane are accepted too.
      expect((await a.send(chat.id, '\u{1D400}'.repeat(MESSAGING_RULES.textMaxLength))).status).toBe(200);
      expect((await a.send(chat.id, '\u{1D400}'.repeat(MESSAGING_RULES.textMaxLength + 1))).status).toBe(400);
      for (let index = 0; index < 5; index += 1) {
        await a.send(chat.id, `page ${index}`);
      }
      const latest = await a.get(`/v1/chats/${chat.id}/messages?limit=3`);
      expect(latest.body.messages.map((m: { text: string }) => m.text)).toEqual(['page 2', 'page 3', 'page 4']);
      const older = await a.get(`/v1/chats/${chat.id}/messages?limit=3&before=${latest.body.messages[0].seq}`);
      expect(older.body.messages.at(-1).text).toBe('page 1');
      expect((await a.get(`/v1/chats/${chat.id}/messages?limit=51`)).status).toBe(400);
      // Someone else's chat looks like one that does not exist.
      expect((await client(app, cai).get(`/v1/chats/${chat.id}/messages`)).status).toBe(404);
      expect((await client(app, cai).send(chat.id, 'intrude')).status).toBe(404);
    });

    it('replies only to a message in the same chat', async () => {
      const a = client(app, ana);
      const b = client(app, ben);
      const chat = await a.openChat(ben);
      await resetMessageLimit(ctx, ana.id);
      const original = (await a.send(chat.id, 'Question?')).body;
      const reply = await b.send(chat.id, 'Answer.', { replyToId: original.id });
      expect(reply.body.replyTo).toEqual({ id: original.id, senderId: ana.id, text: 'Question?' });
      const elsewhere = await a.openChat(cai);
      expect((await a.send(elsewhere.id, 'wrong chat', { replyToId: original.id })).status).toBe(404);
    });

    it('moves statuses from sent to delivered to seen and keeps unread counts (P-20)', async () => {
      const a = client(app, ana);
      const b = client(app, ben);
      const chat = await a.openChat(ben);
      await resetMessageLimit(ctx, ana.id);
      const sent = (await a.send(chat.id, 'status check')).body;
      let view = (await a.get(`/v1/chats/${chat.id}`)).body;
      expect(view.peerDeliveredSeq).toBeLessThan(sent.seq);
      let benView = (await b.get(`/v1/chats/${chat.id}`)).body;
      expect(benView.unreadCount).toBeGreaterThan(0);
      expect((await b.post(`/v1/chats/${chat.id}/delivered`, { seq: sent.seq })).status).toBe(200);
      view = (await a.get(`/v1/chats/${chat.id}`)).body;
      expect(view.peerDeliveredSeq).toBe(sent.seq);
      expect(view.peerReadSeq).toBeLessThan(sent.seq);
      benView = (await b.post(`/v1/chats/${chat.id}/read`, { seq: sent.seq + 1000 })).body;
      expect(benView.readSeq).toBe(sent.seq);
      expect(benView.unreadCount).toBe(0);
      view = (await a.get(`/v1/chats/${chat.id}`)).body;
      expect(view.peerReadSeq).toBe(sent.seq);
      // Mark as unread, then reading clears it.
      expect((await b.patch(`/v1/chats/${chat.id}/state`, { unread: true })).body.markedUnread).toBe(true);
      expect((await b.post(`/v1/chats/${chat.id}/read`, { seq: sent.seq })).body.markedUnread).toBe(false);
    });
  });

  describe('edits and deletions keep their history (D-17)', () => {
    it('records every edit with the previous text; only the sender can edit', async () => {
      const a = client(app, ana);
      const b = client(app, ben);
      const chat = await a.openChat(ben);
      await resetMessageLimit(ctx, ana.id);
      const message = (await a.send(chat.id, 'first version')).body;
      const edited = await a.patch(`/v1/messages/${message.id}`, { text: 'second version' });
      expect(edited.body).toMatchObject({ text: 'second version', id: message.id });
      expect(edited.body.editedAt).not.toBeNull();
      await a.patch(`/v1/messages/${message.id}`, { text: 'third version' });
      expect((await b.patch(`/v1/messages/${message.id}`, { text: 'hijack' })).status).toBe(404);
      const history = await owner(
        "select action, previous_text, new_text, actor_id, session_id from audit.message_revisions where message_id = $1 order by id",
        [message.id],
      );
      expect(history.rows).toEqual([
        { action: 'edited', previous_text: 'first version', new_text: 'second version', actor_id: ana.id, session_id: ana.sessionId },
        { action: 'edited', previous_text: 'second version', new_text: 'third version', actor_id: ana.id, session_id: ana.sessionId },
      ]);
    });

    it('deletes for me (anyone) and for both sides (sender only, P-29), with audit records', async () => {
      const a = client(app, ana);
      const b = client(app, ben);
      const chat = await a.openChat(ben);
      await resetMessageLimit(ctx, ana.id);
      const mine = (await a.send(chat.id, 'secret plan')).body;
      const another = (await a.send(chat.id, 'keep for ben')).body;
      // Ben cannot delete Ana's message for both sides.
      expect((await b.post('/v1/messages/delete', { chatId: chat.id, messageIds: [mine.id], scope: 'both' })).status).toBe(403);
      // Ben hides Ana's message for himself only.
      expect((await b.post('/v1/messages/delete', { chatId: chat.id, messageIds: [another.id], scope: 'me' })).status).toBe(200);
      const benIds = (await b.get(`/v1/chats/${chat.id}/messages`)).body.messages.map((m: { id: string }) => m.id);
      expect(benIds).not.toContain(another.id);
      const anaIds = (await a.get(`/v1/chats/${chat.id}/messages`)).body.messages.map((m: { id: string }) => m.id);
      expect(anaIds).toContain(another.id);
      // Ana deletes her message for both sides: a tombstone for both.
      expect((await a.post('/v1/messages/delete', { chatId: chat.id, messageIds: [mine.id], scope: 'both' })).status).toBe(200);
      const benMessages = (await b.get(`/v1/chats/${chat.id}/messages`)).body.messages;
      expect(benMessages.find((m: { id: string }) => m.id === mine.id)).toMatchObject({ deleted: true, text: null });
      // A deleted message cannot be edited, pinned or deleted again for both.
      expect((await a.patch(`/v1/messages/${mine.id}`, { text: 'back' })).status).toBe(404);
      expect((await a.put(`/v1/messages/${mine.id}/pin`)).status).toBe(404);
      const audit = await owner('select message_id, action, previous_text, actor_id from audit.message_revisions where message_id = any($1) order by id', [[mine.id, another.id]]);
      expect(audit.rows).toEqual([
        { message_id: another.id, action: 'deleted_for_me', previous_text: 'keep for ben', actor_id: ben.id },
        { message_id: mine.id, action: 'deleted_for_both', previous_text: 'secret plan', actor_id: ana.id },
      ]);
      const stored = await owner('select text, deleted_at is not null as deleted from app.messages where id = $1', [mine.id]);
      expect(stored.rows[0]).toEqual({ text: null, deleted: true });
      // Hiding is permanent and a hidden message cannot be touched again by that user.
      expect((await b.post('/v1/messages/delete', { chatId: chat.id, messageIds: [another.id], scope: 'me' })).status).toBe(404);
    });

    it('refuses more than 100 selected messages (P-23) and messages from another chat', async () => {
      const a = client(app, ana);
      const chat = await a.openChat(ben);
      const ids = Array.from({ length: 101 }, () => randomUUID());
      expect((await a.post('/v1/messages/delete', { chatId: chat.id, messageIds: ids, scope: 'me' })).status).toBe(400);
      const other = await a.openChat(cai);
      await resetMessageLimit(ctx, ana.id);
      const foreign = (await a.send(other.id, 'other chat')).body;
      expect((await a.post('/v1/messages/delete', { chatId: chat.id, messageIds: [foreign.id], scope: 'me' })).status).toBe(404);
    });
  });

  describe('the runtime role cannot rewrite history', () => {
    it('cannot delete messages, change audit rows, or change a message without its audit record', async () => {
      const a = client(app, ana);
      const chat = await a.openChat(ben);
      await resetMessageLimit(ctx, ana.id);
      const message = (await a.send(chat.id, 'protected')).body;
      const runtime = new pg.Client({ connectionString: ctx.runtimeUrl });
      await runtime.connect();
      try {
        await expect(runtime.query('delete from app.messages where id = $1', [message.id])).rejects.toThrow(/permission denied/);
        await expect(runtime.query('update audit.message_revisions set previous_text = null')).rejects.toThrow(/permission denied/);
        await expect(runtime.query('delete from audit.screenshot_events')).rejects.toThrow(/permission denied/);
        await expect(runtime.query('delete from app.reports')).rejects.toThrow(/permission denied/);
        await expect(runtime.query('update app.messages set sender_id = $1 where id = $2', [ben.id, message.id])).rejects.toThrow(/permission denied/);
        await expect(runtime.query("update app.messages set text = 'rewritten' where id = $1", [message.id])).rejects.toThrow(/without its audit record/);
        // A revision row must record the text the message really gets.
        await runtime.query('begin');
        await runtime.query(
          "insert into audit.message_revisions (message_id, conversation_id, sender_id, action, previous_text, new_text, actor_type, actor_id) values ($1, $2, $3, 'edited', 'protected', 'harmless', 'user', $3)",
          [message.id, chat.id, ana.id],
        );
        await runtime.query("update app.messages set text = 'FORGED', edited_at = now() where id = $1", [message.id]);
        await expect(runtime.query('commit')).rejects.toThrow(/without its audit record/);
        await expect(
          runtime.query('insert into app.message_hidden (user_id, message_id, conversation_id) values ($1, $2, $3)', [ben.id, message.id, chat.id]),
        ).rejects.toThrow(/without its audit record/);
      } finally {
        await runtime.end();
      }
      expect((await owner('select text from app.messages where id = $1', [message.id])).rows[0]!.text).toBe('protected');
    });
  });

  describe('forwarding, pins and search', () => {
    it('forwards to up to 10 chats with the original sender (P-23), all or nothing', async () => {
      const a = client(app, ana);
      const b = client(app, ben);
      const ab = await a.openChat(ben);
      const ac = await a.openChat(cai);
      await resetMessageLimit(ctx, ana.id);
      await resetMessageLimit(ctx, ben.id);
      const fromBen = (await b.send(ab.id, 'Ben wrote this')).body;
      const fromAna = (await a.send(ab.id, 'Ana wrote this')).body;
      const forwarded = await a.post('/v1/messages/forward', {
        fromChatId: ab.id,
        messageIds: [fromAna.id, fromBen.id],
        targets: [{ chatId: ac.id, clientId: randomUUID() }],
      });
      expect(forwarded.status).toBe(200);
      expect(forwarded.body.messages.map((m: { text: string; forwardedFrom: { id: string } }) => [m.text, m.forwardedFrom.id])).toEqual([
        ['Ben wrote this', ben.id],
        ['Ana wrote this', ana.id],
      ]);
      // Forwarding a forward keeps the original sender.
      const again = await a.post('/v1/messages/forward', {
        fromChatId: ac.id,
        messageIds: [forwarded.body.messages[0].id],
        targets: [{ chatId: ab.id, clientId: randomUUID() }],
      });
      expect(again.body.messages[0].forwardedFrom).toEqual({ id: ben.id, displayName: 'Ben Carter', deleted: false });
      const tooMany = Array.from({ length: 11 }, () => ({ chatId: randomUUID(), clientId: randomUUID() }));
      expect((await a.post('/v1/messages/forward', { fromChatId: ab.id, messageIds: [fromAna.id], targets: tooMany })).status).toBe(400);
      // A chat the sender is not in makes the whole request fail; nothing is stored.
      const before = await owner('select count(*)::int as n from app.messages');
      const stranger = await createUser(ctx, app, 'Dee Stranger');
      const foreignChat = await client(app, ben).openChat(stranger);
      const failed = await a.post('/v1/messages/forward', {
        fromChatId: ab.id,
        messageIds: [fromAna.id],
        targets: [
          { chatId: ac.id, clientId: randomUUID() },
          { chatId: foreignChat.id, clientId: randomUUID() },
        ],
      });
      expect(failed.status).toBe(404);
      expect((await owner('select count(*)::int as n from app.messages')).rows[0]!.n).toBe(before.rows[0]!.n);
    });

    it('lets either participant pin; pins are visible to both (P-22)', async () => {
      const a = client(app, ana);
      const b = client(app, ben);
      const chat = await a.openChat(ben);
      await resetMessageLimit(ctx, ana.id);
      const message = (await a.send(chat.id, 'pin me')).body;
      expect((await b.put(`/v1/messages/${message.id}/pin`)).status).toBe(200);
      expect((await a.get(`/v1/chats/${chat.id}/pins`)).body.messages.map((m: { id: string }) => m.id)).toContain(message.id);
      expect((await a.del(`/v1/messages/${message.id}/pin`)).status).toBe(200);
      expect((await b.get(`/v1/chats/${chat.id}/pins`)).body.messages.map((m: { id: string }) => m.id)).not.toContain(message.id);
      await b.put(`/v1/messages/${message.id}/pin`);
      await a.post('/v1/messages/delete', { chatId: chat.id, messageIds: [message.id], scope: 'both' });
      expect((await b.get(`/v1/chats/${chat.id}/pins`)).body.messages).toHaveLength(0);
    });

    it('searches one chat by whole and partial words, never other chats or deleted or hidden messages', async () => {
      const a = client(app, ana);
      const b = client(app, ben);
      const chat = await a.openChat(ben);
      const other = await a.openChat(cai);
      await resetMessageLimit(ctx, ana.id);
      const visible = (await a.send(chat.id, 'Assignment deadline is Friday')).body;
      const removed = (await a.send(chat.id, 'Assignment answers leaked')).body;
      const hidden = (await a.send(chat.id, 'Assignment notes for Ana')).body;
      await a.send(other.id, 'Assignment for Cai');
      await a.post('/v1/messages/delete', { chatId: chat.id, messageIds: [removed.id], scope: 'both' });
      await b.post('/v1/messages/delete', { chatId: chat.id, messageIds: [hidden.id], scope: 'me' });
      const found = (await b.get(`/v1/chats/${chat.id}/search?q=${encodeURIComponent('signmen')}`)).body.messages;
      expect(found.map((m: { id: string }) => m.id)).toEqual([visible.id]);
      const wildcard = (await b.get(`/v1/chats/${chat.id}/search?q=${encodeURIComponent('%')}`)).body.messages;
      expect(wildcard).toEqual([]);
      expect((await client(app, cai).get(`/v1/chats/${chat.id}/search?q=deadline`)).status).toBe(404);
    });
  });

  describe('chat list state and folders', () => {
    it('pins at most 5 chats (P-19) and keeps archived chats archived when messages arrive', async () => {
      const a = client(app, ana);
      const others = await Promise.all(Array.from({ length: 6 }, (_, index) => createUser(ctx, app, `Pin Friend ${index}`)));
      const chats = [];
      for (const other of others) {
        chats.push(await a.openChat(other));
      }
      for (const chat of chats.slice(0, 5)) {
        expect((await a.patch(`/v1/chats/${chat.id}/state`, { pinned: true })).body.pinned).toBe(true);
      }
      const sixth = await a.patch(`/v1/chats/${chats[5].id}/state`, { pinned: true });
      expect(sixth.status).toBe(409);
      expect(sixth.body.error.code).toBe('LIMIT_REACHED');
      await a.patch(`/v1/chats/${chats[0].id}/state`, { pinned: false });
      expect((await a.patch(`/v1/chats/${chats[5].id}/state`, { pinned: true })).status).toBe(200);
      const archived = await a.patch(`/v1/chats/${chats[1].id}/state`, { archived: true });
      expect(archived.body.archived).toBe(true);
      await resetMessageLimit(ctx, others[1]!.id);
      await client(app, others[1]!).send(chats[1].id, 'new message');
      expect((await a.get(`/v1/chats/${chats[1].id}`)).body.archived).toBe(true);
    });

    it('allows up to 10 folders with names of 1-12 characters and only the user’s own chats (P-21)', async () => {
      const b = client(app, ben);
      const chat = await b.openChat(ana);
      expect((await b.post('/v1/folders', { name: 'x'.repeat(13) })).status).toBe(400);
      expect((await b.post('/v1/folders', { name: '   ' })).status).toBe(400);
      const created = await b.post('/v1/folders', { name: 'Study', chatIds: [chat.id] });
      expect(created.body.folders).toEqual([{ id: expect.any(String), name: 'Study', chatIds: [chat.id] }]);
      const caiChat = await client(app, cai).openChat(await createUser(ctx, app, 'Folder Other'));
      expect((await b.post('/v1/folders', { name: 'Theirs', chatIds: [caiChat.id] })).status).toBe(404);
      for (let index = 1; index < MESSAGING_RULES.maxFolders; index += 1) {
        expect((await b.post('/v1/folders', { name: `F${index}` })).status).toBe(200);
      }
      const eleventh = await b.post('/v1/folders', { name: 'Too many' });
      expect(eleventh.body.error.code).toBe('LIMIT_REACHED');
      const folderId = created.body.folders[0].id;
      const renamed = await b.patch(`/v1/folders/${folderId}`, { name: 'Classes', chatIds: [] });
      expect(renamed.body.folders[0]).toEqual({ id: folderId, name: 'Classes', chatIds: [] });
      expect((await client(app, ana).patch(`/v1/folders/${folderId}`, { name: 'Mine' })).status).toBe(404);
      expect((await b.del(`/v1/folders/${folderId}`)).body.folders).toHaveLength(MESSAGING_RULES.maxFolders - 1);
    });
  });

  describe('blocks, privacy and account states (P-26, P-30, P-31)', () => {
    it('gives a block and "Who can message: Nobody" the same neutral answer; history stays readable', async () => {
      const eve = await createUser(ctx, app, 'Eve Block');
      const fay = await createUser(ctx, app, 'Fay Nobody');
      const gus = await createUser(ctx, app, 'Gus Sender');
      const g = client(app, gus);
      const toEve = await g.openChat(eve);
      const toFay = await g.openChat(fay);
      await g.send(toEve.id, 'before block');
      await client(app, eve).post(`/v1/users/${gus.id}/block`);
      await client(app, fay).patch('/v1/me/privacy', { messagesFrom: 'nobody' });
      const blocked = await g.send(toEve.id, 'after block');
      const nobody = await g.send(toFay.id, 'after nobody');
      expect(blocked.status).toBe(403);
      expect(nobody.status).toBe(403);
      expect(blocked.body.error.code).toBe('CANNOT_MESSAGE');
      expect(blocked.body.error.message).toBe("You can't message this user");
      expect({ ...blocked.body.error, requestId: '' }).toEqual({ ...nobody.body.error, requestId: '' });
      // The two cases also look the same in the profile and the chat.
      const eveView = (await g.get(`/v1/users/${eve.id}`)).body;
      const fayView = (await g.get(`/v1/users/${fay.id}`)).body;
      expect(eveView.canMessage).toBe(false);
      expect(fayView.canMessage).toBe(false);
      expect(eveView.blockedByMe).toBe(false);
      // A new chat with a Nobody user cannot be started.
      const hal = await createUser(ctx, app, 'Hal New');
      expect((await client(app, hal).post('/v1/chats', { userId: fay.id })).body.error.code).toBe('CANNOT_MESSAGE');
      // History stays readable.
      expect((await g.get(`/v1/chats/${toEve.id}/messages`)).body.messages.map((m: { text: string }) => m.text)).toEqual(['before block']);
      // The blocker cannot send until unblocking (P-30); the chat shows the block.
      const e = client(app, eve);
      const eveChat = (await e.get(`/v1/chats/${toEve.id}`)).body;
      expect(eveChat.peer).toMatchObject({ blockedByMe: true, canMessage: false });
      const fromBlocker = await e.send(toEve.id, 'blocker writes');
      expect(fromBlocker.body.error.code).toBe('USER_BLOCKED');
      await e.del(`/v1/users/${gus.id}/block`);
      expect((await e.send(toEve.id, 'after unblock')).status).toBe(200);
      expect((await g.send(toEve.id, 'reply after unblock')).status).toBe(200);
    });

    it('hides photo, last seen and online status from a blocked user, and online with last seen Nobody', async () => {
      const ivy = await createUser(ctx, app, 'Ivy Hidden');
      const jon = await createUser(ctx, app, 'Jon Viewer');
      await owner("update app.users set photo_key = 'ivy/photo.png' where id = $1", [ivy.id]);
      await owner('insert into app.user_presence (user_id, last_seen_at) values ($1, $2)', [ivy.id, '2026-10-01T10:15:42.123Z']);
      const j = client(app, jon);
      let view = (await j.get(`/v1/users/${ivy.id}`)).body;
      expect(view.presence).toEqual({ online: false, lastSeenAt: '2026-10-01T10:15:00.000Z' });
      await client(app, ivy).patch('/v1/me/privacy', { lastSeenVisibility: 'nobody' });
      view = (await j.get(`/v1/users/${ivy.id}`)).body;
      expect(view.presence).toBeNull();
      await client(app, ivy).patch('/v1/me/privacy', { lastSeenVisibility: 'everyone', phoneVisibility: 'everyone' });
      expect((await j.get(`/v1/users/${ivy.id}`)).body.phone).toBe(ivy.phone);
      await client(app, ivy).post(`/v1/users/${jon.id}/block`);
      view = (await j.get(`/v1/users/${ivy.id}`)).body;
      expect(view).toMatchObject({ presence: null, photoUrl: null, phone: null, canMessage: false, blockedByMe: false });
    });

    it('treats deleted accounts as read-only "Deleted account" and stops suspended users from sending', async () => {
      const kim = await createUser(ctx, app, 'Kim Leaving');
      const lou = await createUser(ctx, app, 'Lou Staying');
      const l = client(app, lou);
      const chat = await l.openChat(kim);
      await l.send(chat.id, 'hello Kim');
      await resetMessageLimit(ctx, kim.id);
      const fromKim = (await client(app, kim).send(chat.id, 'bye Lou')).body;
      const forwarded = await l.post('/v1/messages/forward', {
        fromChatId: chat.id,
        messageIds: [fromKim.id],
        targets: [{ chatId: (await l.openChat(ana)).id, clientId: randomUUID() }],
      });
      await owner(
        "update app.users set status = 'deleted', phone = null, name = null, username = null, bio = null, photo_key = null, deleted_at = now() where id = $1",
        [kim.id],
      );
      const view = (await l.get(`/v1/chats/${chat.id}`)).body;
      expect(view.peer).toMatchObject({ deleted: true, displayName: DELETED_ACCOUNT_NAME, canMessage: false });
      expect((await l.send(chat.id, 'are you there?')).body.error.code).toBe('CANNOT_MESSAGE');
      expect((await l.get(`/v1/chats/${chat.id}/messages`)).body.messages).toHaveLength(2);
      const copy = (await l.get(`/v1/chats/${forwarded.body.messages[0].chatId}/messages`)).body.messages.find(
        (m: { id: string }) => m.id === forwarded.body.messages[0].id,
      );
      expect(copy.forwardedFrom).toEqual({ id: kim.id, displayName: 'Deleted account', deleted: true });
      await owner("update app.users set status = 'suspended' where id = $1", [lou.id]);
      expect((await l.send(chat.id, 'suspended')).body.error.code).toBe('ACCOUNT_BLOCKED');
    });
  });

  describe('reports, screenshots and finding users', () => {
    it('stores reports permanently with the reported message text (P-27), 20 per day', async () => {
      const mia = await createUser(ctx, app, 'Mia Reporter');
      const ned = await createUser(ctx, app, 'Ned Reported');
      const chat = await client(app, ned).openChat(mia);
      const message = (await client(app, ned).send(chat.id, 'rude words')).body;
      const m = client(app, mia);
      expect((await m.post('/v1/reports', { userId: ned.id, messageId: message.id, reason: 'harassment', details: 'Please check' })).status).toBe(200);
      expect((await m.post('/v1/reports', { userId: ned.id, reason: 'bad_reason' })).status).toBe(400);
      expect((await m.post('/v1/reports', { userId: ned.id, reason: 'other', details: 'x'.repeat(501) })).status).toBe(400);
      // Only that user's message in a chat the reporter is in.
      expect((await m.post('/v1/reports', { userId: mia.id, messageId: message.id, reason: 'spam' })).status).toBe(400);
      expect((await client(app, cai).post('/v1/reports', { userId: ned.id, messageId: message.id, reason: 'spam' })).status).toBe(404);
      const stored = await owner('select reason, details, message_text, conversation_id from app.reports where reporter_id = $1', [mia.id]);
      expect(stored.rows).toEqual([{ reason: 'harassment', details: 'Please check', message_text: 'rude words', conversation_id: chat.id }]);
      for (let index = 1; index < MESSAGING_RULES.reportsPerDay; index += 1) {
        expect((await m.post('/v1/reports', { userId: ned.id, reason: 'spam' })).status).toBe(200);
      }
      const limited = await m.post('/v1/reports', { userId: ned.id, reason: 'spam' });
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
    });

    it('accepts screenshot events only from iOS and Android sessions (P-28)', async () => {
      const ola = await createUser(ctx, app, 'Ola Phone');
      const chat = await client(app, ola).openChat(ana);
      const message = (await client(app, ola).send(chat.id, 'on screen')).body;
      const event = { chatId: chat.id, screen: 'chat', messageIds: [message.id], occurredAt: new Date().toISOString() };
      expect((await client(app, ola).post('/v1/screenshot-events', event)).status).toBe(403);
      await owner("update app.sessions set platform = 'ios', device_name = 'iPhone' where id = $1", [ola.sessionId]);
      expect((await client(app, ola).post('/v1/screenshot-events', event)).status).toBe(200);
      expect((await client(app, ola).post('/v1/screenshot-events', { ...event, chatId: (await client(app, ben).openChat(cai)).id })).status).toBe(404);
      const rows = await owner('select platform, device_name, conversation_id, screen, message_ids from audit.screenshot_events where user_id = $1', [ola.id]);
      expect(rows.rows).toEqual([{ platform: 'ios', device_name: 'iPhone', conversation_id: chat.id, screen: 'chat', message_ids: [message.id] }]);
    });

    it('finds users by name or username from 3 characters, by phone only when allowed (P-25)', async () => {
      const pia = await createUser(ctx, app, 'Pia Quantum');
      await client(app, pia).patch('/v1/me', { username: 'pia_quantum' });
      const r = client(app, ana);
      expect((await r.get('/v1/users/search?q=Pi')).status).toBe(400);
      expect((await r.get('/v1/users/search?q=quant')).body.users.map((u: { id: string }) => u.id)).toEqual([pia.id]);
      expect((await r.get('/v1/users/search?q=%40pia_q')).body.users.map((u: { id: string }) => u.id)).toEqual([pia.id]);
      expect((await r.get(`/v1/users/search?q=${encodeURIComponent(pia.phone)}`)).body.users).toEqual([]);
      await client(app, pia).patch('/v1/me/privacy', { phoneVisibility: 'everyone' });
      expect((await r.get(`/v1/users/search?q=${encodeURIComponent(pia.phone)}`)).body.users.map((u: { id: string }) => u.id)).toEqual([pia.id]);
      // The searcher never finds themselves, and deleted accounts are never found.
      expect((await client(app, pia).get('/v1/users/search?q=quantum')).body.users).toEqual([]);
      await owner("update app.users set status = 'deleted', phone = null, name = null, username = null, bio = null, photo_key = null where id = $1", [pia.id]);
      expect((await r.get('/v1/users/search?q=quant')).body.users).toEqual([]);
    });
  });

  describe('rate limits and sync', () => {
    it('allows 30 messages per minute, counting edits (D-30)', async () => {
      const quinn = await createUser(ctx, app, 'Quinn Fast');
      const q = client(app, quinn);
      const chat = await q.openChat(ana);
      const first = (await q.send(chat.id, 'message 1')).body;
      for (let index = 2; index <= 29; index += 1) {
        expect((await q.send(chat.id, `message ${index}`)).status).toBe(200);
      }
      expect((await q.patch(`/v1/messages/${first.id}`, { text: 'edited counts' })).status).toBe(200);
      const limited = await q.send(chat.id, 'message 31');
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      expect(limited.body.error.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('counts every forwarded copy towards the 30 messages per minute (D-30)', async () => {
      const una = await createUser(ctx, app, 'Una Forward');
      const u = client(app, una);
      const first = await u.openChat(ana);
      const second = await u.openChat(ben);
      const sources = [(await u.send(first.id, 'one')).body.id, (await u.send(first.id, 'two')).body.id];
      for (let index = 3; index <= 26; index += 1) {
        expect((await u.send(first.id, `message ${index}`)).status).toBe(200);
      }
      // 26 sent; 2 messages to 2 chats is 4 more: exactly 30.
      const forward = (chatIds: string[], ids = sources) =>
        u.post('/v1/messages/forward', { fromChatId: first.id, messageIds: ids, targets: chatIds.map((chatId) => ({ chatId, clientId: randomUUID() })) });
      // More copies than a whole minute allows can never succeed: a distinct answer, not "try again".
      const tooMany = await forward([first.id], Array.from({ length: 31 }, () => randomUUID()));
      expect(tooMany.status).toBe(409);
      expect(tooMany.body.error.code).toBe('LIMIT_REACHED');
      expect((await forward([first.id, second.id])).status).toBe(200);
      const limited = await forward([second.id], [sources[0]]);
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
    });

    it('replays updates since a seq and asks a device more than 1000 behind to re-fetch (P-17)', async () => {
      const rex = await createUser(ctx, app, 'Rex Sync');
      const sid = await createUser(ctx, app, 'Sid Sync');
      const r = client(app, rex);
      const s = client(app, sid);
      const chat = await r.openChat(sid);
      const start = (await s.get('/v1/sync?since=0')).body;
      expect(start).toMatchObject({ seq: 0, updates: [], resync: false, hasMore: false });
      const sent = (await r.send(chat.id, 'sync me')).body;
      await r.patch(`/v1/messages/${sent.id}`, { text: 'sync me (edited)' });
      const sync = (await s.get('/v1/sync?since=0')).body;
      expect(sync.updates.map((u: { kind: string }) => u.kind)).toEqual(['message.new', 'message.edited']);
      expect(sync.messages).toEqual([expect.objectContaining({ id: sent.id, text: 'sync me (edited)' })]);
      expect(sync.chats.map((c: { id: string }) => c.id)).toEqual([chat.id]);
      // Hidden for the reader: the update says so and the message itself is not sent.
      await s.post('/v1/messages/delete', { chatId: chat.id, messageIds: [sent.id], scope: 'me' });
      const after = (await s.get(`/v1/sync?since=${sync.seq}`)).body;
      expect(after.updates.map((u: { kind: string }) => u.kind)).toEqual(['message.hidden']);
      expect(after.messages).toEqual([]);
      // Far behind: re-fetch.
      await owner('update app.user_sync_state set last_seq = last_seq + 1001 where user_id = $1', [sid.id]);
      const behind = (await s.get(`/v1/sync?since=${after.seq}`)).body;
      expect(behind).toMatchObject({ resync: true, updates: [] });
      expect(behind.seq).toBe(after.seq + 1001);
      // Older than the 30-day log: re-fetch as well.
      await owner('update app.user_sync_state set pruned_through_seq = $2 where user_id = $1', [sid.id, behind.seq - 10]);
      expect((await s.get(`/v1/sync?since=${behind.seq - 20}`)).body.resync).toBe(true);
      // Updates for other users never show up.
      const other = (await client(app, cai).get('/v1/sync?since=0')).body;
      expect(other.messages.map((m: { id: string }) => m.id)).not.toContain(sent.id);
    });
  });
});
