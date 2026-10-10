import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { type Message, type PollInput, SCHEDULE_RULES, type ScheduledMessage, type ScheduleMessageBody, type SendMessageBody } from '@bedo/contracts';
import type { ScheduledMessagesTable } from '@bedo/db';
import { sql, type Selectable } from 'kysely';
import type { Executor } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/user-auth.guard.js';
import { AppError } from '../common/app-error.js';
import { API_ENV } from '../config/tokens.js';
import { DatabaseService } from '../database/database.service.js';
import { UserPermissionsService } from '../groups/user-permissions.service.js';
import { FilesService } from '../media/files.service.js';
import { GifsService } from '../media/gifs.service.js';
import { StickersService } from '../media/stickers.service.js';
import { DeferredTasks } from '../runtime/deferred-tasks.service.js';
import { BroadcastsService } from './broadcasts.service.js';
import { MessagesService } from './messages.service.js';
import { MessagingLimitsService } from './messaging-limits.service.js';
import { type ChatAccess, PermissionService, type PostKind } from './permissions.service.js';
import { UpdateLogService } from './update-log.service.js';
import { joinEveryoneChannels } from '../groups/everyone-channels.js';

/** What a scheduled message sends, stored as JSON (D-40). Files and GIFs are already checked and kept. */
interface ScheduledPayload {
  text?: string;
  replyToId?: string;
  fileId?: string;
  stickerId?: string;
  poll?: PollInput;
  /** The file is a GIF (counts as a sticker for group permissions). */
  gif?: boolean;
}

type ScheduledRow = Selectable<ScheduledMessagesTable>;

/** Header the scheduled Netlify function sends to POST /v1/internal/dispatch (see dispatchToken). */
export const DISPATCH_HEADER = 'x-bedo-dispatch';
const DISPATCH_PURPOSE = 'bedo scheduled dispatch v1';

/**
 * The value of the dispatch header: an HMAC of a fixed purpose with the API's access-token secret, so the scheduled
 * function (which has the same server variables) can compute it and nobody else can. It grants nothing but "send the
 * scheduled messages that are due now".
 */
export function dispatchToken(accessTokenSecret: string): string {
  return createHmac('sha256', accessTokenSecret).update(DISPATCH_PURPOSE).digest('hex');
}

/** Each server instance asks the database for due messages at most this often (from ordinary requests). */
const POKE_EVERY_MS = 5_000;
/** D-52: how often a server instance catches up on channels for everyone while requests come in. */
const EVERYONE_EVERY_MS = 60_000;
/** A message claimed for sending but not finished after this long (the instance stopped) is claimed again. */
const STALE_SENDING_SECONDS = 120;
const BATCH = 25;
/** One dispatch run stops claiming after this long (a scheduled function has 30 seconds). */
const RUN_BUDGET_MS = 20_000;

const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
const invalid = () => new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED');

/**
 * Scheduled messages (Phase 6, D-40; blueprint: Channels, scheduled posts and messages). A message is saved with a
 * time and sent then by the API itself, as its author, after the same checks as any message (so an author who lost
 * the right to post meanwhile gets a failed scheduled message, not a post). There is no worker (D-36): a scheduled
 * Netlify function calls the internal dispatch endpoint every minute, and ordinary requests check for due messages
 * at most every five seconds per server instance; whichever comes first sends them. Sending reuses the message's
 * client id, so a message is never sent twice even if two runs overlap.
 */
@Injectable()
export class ScheduledService {
  private readonly logger = new Logger(ScheduledService.name);
  private nextPokeAt = 0;
  private nextEveryoneAt = 0;
  private readonly expectedToken: Buffer;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PermissionService) private readonly permissions: PermissionService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(GifsService) private readonly gifs: GifsService,
    @Inject(StickersService) private readonly stickers: StickersService,
    @Inject(MessagingLimitsService) private readonly limits: MessagingLimitsService,
    @Inject(UpdateLogService) private readonly updateLog: UpdateLogService,
    @Inject(UserPermissionsService) private readonly systemPermissions: UserPermissionsService,
    @Inject(DeferredTasks) private readonly deferred: DeferredTasks,
    @Inject(BroadcastsService) private readonly broadcasts: BroadcastsService,
    @Inject(API_ENV) env: ApiEnv,
  ) {
    this.expectedToken = Buffer.from(dispatchToken(env.ACCESS_TOKEN_SECRET), 'utf8');
  }

  private get db() {
    return this.database.db;
  }

  /** Whether `value` is the dispatch header's value (constant-time comparison). */
  isDispatchToken(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const given = Buffer.from(value, 'utf8');
    return given.length === this.expectedToken.length && timingSafeEqual(given, this.expectedToken);
  }

  private static postKind(payload: ScheduledPayload): PostKind {
    return payload.poll ? 'poll' : payload.stickerId || payload.gif ? 'sticker' : payload.fileId ? 'media' : 'text';
  }

  /**
   * Who may schedule here: channel owners and admins who may post schedule posts in their channel; anywhere else the
   * system permission "schedule messages" (O-21) is needed. Either way the author must be able to post it now.
   */
  private async assertMaySchedule(db: Executor, userId: string, access: ChatAccess, kind: PostKind): Promise<void> {
    await this.permissions.assertCanPost(db, userId, access, kind);
    if (access.type === 'channel') return;
    if (!(await this.systemPermissions.forUser(db, userId)).scheduleMessages) {
      throw new AppError(HttpStatus.FORBIDDEN, 'NOT_ALLOWED');
    }
  }

  private static assertTime(sendAt: string): Date {
    const at = new Date(sendAt);
    const now = Date.now();
    if (at.getTime() < now + SCHEDULE_RULES.minAheadSeconds * 1000 || at.getTime() > now + SCHEDULE_RULES.maxAheadDays * 24 * 3600 * 1000) {
      throw invalid();
    }
    return at;
  }

  // ---------------------------------------------------------------------------------- the author's list

  async schedule(auth: AuthContext, chatId: string, body: ScheduleMessageBody): Promise<ScheduledMessage> {
    const sendAt = ScheduledService.assertTime(body.sendAt);
    const db = this.db;
    const message = body.message;
    const existing = await db.selectFrom('app.scheduled_messages').selectAll().where('sender_id', '=', auth.userId).where('client_id', '=', message.clientId).executeTakeFirst();
    if (existing) {
      // A retry of the same request returns what was scheduled.
      if (existing.conversation_id !== chatId || existing.status === 'sent' || existing.status === 'cancelled') throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
      return this.view(db, existing);
    }
    const used = await db.selectFrom('app.message_requests').select('client_id').where('sender_id', '=', auth.userId).where('client_id', '=', message.clientId).executeTakeFirst();
    if (used) throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');

    const payload: ScheduledPayload = {
      ...(message.text !== undefined ? { text: message.text } : {}),
      ...(message.replyToId ? { replyToId: message.replyToId } : {}),
      ...(message.stickerId ? { stickerId: message.stickerId } : {}),
      ...(message.poll ? { poll: message.poll } : {}),
      ...(message.gifId ? { gif: true } : {}),
    };
    const kind = ScheduledService.postKind({ ...payload, ...(message.fileId ? { fileId: message.fileId } : {}) });
    const access = await this.permissions.chatAccess(db, auth.userId, chatId);
    await this.assertMaySchedule(db, auth.userId, access, kind);
    if (message.poll && access.type === 'private') throw invalid();
    await this.limits.messages(auth.userId);
    if (message.replyToId) {
      const [visible] = await this.messages.visibleViews(db, auth.userId, [message.replyToId]);
      if (!visible || visible.chatId !== chatId) throw notFound();
    }
    if (message.stickerId) await this.stickers.assertSendable(db, message.stickerId);
    const pending = await db
      .selectFrom('app.scheduled_messages')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('sender_id', '=', auth.userId)
      .where('conversation_id', '=', chatId)
      .where('status', 'in', ['pending', 'sending', 'failed'])
      .executeTakeFirstOrThrow();
    if (pending.n >= SCHEDULE_RULES.maxPendingPerChat) throw new AppError(HttpStatus.CONFLICT, 'LIMIT_REACHED');
    // The file is checked now and kept; a GIF is copied now, so nothing outside can fail when it is due.
    if (message.fileId) payload.fileId = await this.files.prepareForSchedule(auth.userId, message.fileId);
    if (message.gifId) payload.fileId = await this.gifs.fileFor(auth.userId, message.gifId);

    const row = await this.updateLog.run(async (trx, updates) => {
      const inserted = await trx
        .insertInto('app.scheduled_messages')
        .values({ conversation_id: chatId, sender_id: auth.userId, session_id: auth.sessionId, client_id: message.clientId, send_at: sendAt, payload: payload as Record<string, unknown> })
        .onConflict((conflict) => conflict.columns(['sender_id', 'client_id']).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (!inserted) throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
      updates.add({ userId: auth.userId, kind: 'scheduled', chatId });
      return inserted;
    });
    return this.view(db, row);
  }

  async list(viewerId: string, chatId: string): Promise<ScheduledMessage[]> {
    const db = this.db;
    await this.permissions.chatAccess(db, viewerId, chatId);
    const rows = await db
      .selectFrom('app.scheduled_messages')
      .selectAll()
      .where('sender_id', '=', viewerId)
      .where('conversation_id', '=', chatId)
      .where('status', 'in', ['pending', 'sending', 'failed'])
      .orderBy('send_at')
      .orderBy('created_at')
      .execute();
    return this.views(db, rows);
  }

  /** Change the time or the text of one's own scheduled message (a failed one is tried again at the new time). */
  async update(auth: AuthContext, id: string, body: { sendAt?: string | undefined; text?: string | undefined }): Promise<ScheduledMessage> {
    await this.limits.peerActions(auth.userId);
    const sendAt = body.sendAt !== undefined ? ScheduledService.assertTime(body.sendAt) : undefined;
    const row = await this.updateLog.run(async (trx, updates) => {
      const current = await trx.selectFrom('app.scheduled_messages').selectAll().where('id', '=', id).where('sender_id', '=', auth.userId).forUpdate().executeTakeFirst();
      if (!current || !(await this.permissions.findChatAccess(trx, auth.userId, current.conversation_id))) throw notFound();
      if (current.status !== 'pending' && current.status !== 'failed') throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
      const payload = current.payload as ScheduledPayload;
      if (body.text !== undefined && (payload.stickerId || payload.poll || payload.gif)) throw invalid();
      const updated = await trx
        .updateTable('app.scheduled_messages')
        .set({
          ...(sendAt ? { send_at: sendAt } : {}),
          ...(body.text !== undefined ? { payload: { ...payload, text: body.text } as Record<string, unknown> } : {}),
          ...(current.status === 'failed' && sendAt ? { status: 'pending' as const, attempts: 0, error_code: null } : {}),
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
      updates.add({ userId: auth.userId, kind: 'scheduled', chatId: current.conversation_id });
      return updated;
    });
    return this.view(this.db, row);
  }

  /** Remove one's own scheduled message before it is sent. */
  async cancel(auth: AuthContext, id: string): Promise<void> {
    await this.limits.peerActions(auth.userId);
    await this.updateLog.run(async (trx, updates) => {
      const current = await trx.selectFrom('app.scheduled_messages').select(['id', 'conversation_id', 'status']).where('id', '=', id).where('sender_id', '=', auth.userId).forUpdate().executeTakeFirst();
      if (!current || current.status === 'sent' || current.status === 'cancelled') throw notFound();
      if (current.status === 'sending') throw new AppError(HttpStatus.CONFLICT, 'CONFLICT');
      await trx.updateTable('app.scheduled_messages').set({ status: 'cancelled' }).where('id', '=', id).execute();
      updates.add({ userId: auth.userId, kind: 'scheduled', chatId: current.conversation_id });
    });
  }

  /** Send one's own scheduled message now. */
  async sendNow(auth: AuthContext, id: string): Promise<Message> {
    // Phase 9: sending now counts as sending a message.
    await this.limits.messages(auth.userId);
    const { rows } = await sql<ScheduledRow>`
      update app.scheduled_messages set status = 'sending', attempts = attempts + 1
      where id = ${id} and sender_id = ${auth.userId} and status in ('pending', 'failed')
      returning *
    `.execute(this.db);
    const row = rows[0];
    if (!row) throw notFound();
    const outcome = await this.deliver(row);
    if (outcome.status !== 'sent') {
      throw outcome.error instanceof AppError ? outcome.error : new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE');
    }
    const [message] = await this.messages.visibleViews(this.db, auth.userId, [outcome.messageId]);
    if (!message) throw notFound();
    return message;
  }

  // ------------------------------------------------------------------------------------------ sending

  /**
   * D-52: adds whoever is missing from the channels for everyone (all of them, or one account's) in one statement, and
   * tells their devices. Returns how many joined.
   */
  async joinEveryoneChannels(scope: { userId?: string } = {}): Promise<number> {
    const joins = await joinEveryoneChannels(this.db, scope, { type: 'system', id: null });
    if (joins.length > 0) {
      await this.updateLog.run(async (_trx, updates) => {
        for (const join of joins) updates.add({ userId: join.userId, kind: 'chat.info', chatId: join.conversationId });
      });
    }
    return joins.length;
  }

  /** Called for every API request; cheap unless a check is due (then it runs after the response). */
  poke(): void {
    const now = Date.now();
    // D-52: channels for everyone do not wait for the scheduled function either.
    if (now >= this.nextEveryoneAt) {
      this.nextEveryoneAt = now + EVERYONE_EVERY_MS;
      this.deferred.defer('channels for everyone', () => this.joinEveryoneChannels());
    }
    if (now < this.nextPokeAt) return;
    this.nextPokeAt = now + POKE_EVERY_MS;
    this.deferred.defer('scheduled messages', async () => {
      const due = await sql<{ due: boolean }>`
        select exists (
          select 1 from app.scheduled_messages
          where (status = 'pending' and send_at <= now())
             or (status = 'sending' and updated_at < now() - make_interval(secs => ${STALE_SENDING_SECONDS}))
        ) or exists (select 1 from app.broadcasts where status = 'sending') as due
      `.execute(this.db);
      if (due.rows[0]?.due) await this.dispatchDue();
    });
  }

  /** Sends every scheduled message that is due (in batches, for at most about 20 seconds). */
  async dispatchDue(): Promise<{ sent: number; failed: number }> {
    const started = Date.now();
    let sent = 0;
    let failed = 0;
    while (Date.now() - started < RUN_BUDGET_MS) {
      const { rows } = await sql<ScheduledRow>`
        update app.scheduled_messages s set status = 'sending', attempts = s.attempts + 1
        where s.id in (
          select id from app.scheduled_messages
          where (status = 'pending' and send_at <= now())
             or (status = 'sending' and updated_at < now() - make_interval(secs => ${STALE_SENDING_SECONDS}))
          order by send_at
          limit ${BATCH}
          for update skip locked
        )
        returning s.*
      `.execute(this.db);
      if (rows.length === 0) break;
      rows.sort((a, b) => new Date(a.send_at).getTime() - new Date(b.send_at).getTime() || new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      for (const row of rows) {
        const outcome = await this.deliver(row);
        if (outcome.status === 'sent') sent += 1;
        if (outcome.status === 'failed') failed += 1;
      }
    }
    // Phase 10 (O-20): broadcast notifications still being sent continue in the same run.
    await this.broadcasts.dispatch();
    return { sent, failed };
  }

  /**
   * Sends one claimed scheduled message as its author. A refusal (the author may no longer post there, the chat is
   * gone, the replied message was deleted) marks it failed with the reason; anything else (the database or storage
   * briefly unavailable) is retried up to five times.
   */
  private async deliver(row: ScheduledRow): Promise<{ status: 'sent'; messageId: string } | { status: 'failed' | 'retry'; error: unknown }> {
    const payload = row.payload as ScheduledPayload;
    const body: SendMessageBody = {
      clientId: row.client_id,
      ...(payload.text !== undefined ? { text: payload.text } : {}),
      ...(payload.replyToId ? { replyToId: payload.replyToId } : {}),
      ...(payload.fileId ? { fileId: payload.fileId } : {}),
      ...(payload.stickerId ? { stickerId: payload.stickerId } : {}),
      ...(payload.poll ? { poll: payload.poll } : {}),
    } as SendMessageBody;
    try {
      const access = await this.permissions.chatAccess(this.db, row.sender_id, row.conversation_id);
      // The author must still be allowed to schedule here (a channel admin who lost the right to post, say).
      await this.assertMaySchedule(this.db, row.sender_id, access, ScheduledService.postKind(payload));
      const message = await this.messages.send({ userId: row.sender_id, sessionId: row.session_id }, row.conversation_id, body, { scheduled: true });
      await this.finish(row, { status: 'sent', message_id: message.id, sent_at: new Date(), error_code: null });
      return { status: 'sent', messageId: message.id };
    } catch (error) {
      const refused = error instanceof AppError && error.getStatus() < 500;
      const final = refused || row.attempts >= SCHEDULE_RULES.maxAttempts;
      const code = error instanceof AppError ? error.code : 'SERVICE_UNAVAILABLE';
      if (!refused) {
        this.logger.warn(`Scheduled message ${row.id} could not be sent (attempt ${row.attempts}): ${error instanceof Error ? error.message : String(error)}`);
      }
      await this.finish(row, final ? { status: 'failed', error_code: code } : { status: 'pending', error_code: code }).catch((finishError: unknown) => {
        this.logger.error(`Scheduled message ${row.id}: ${finishError instanceof Error ? finishError.message : String(finishError)}`);
      });
      return { status: final ? 'failed' : 'retry', error };
    }
  }

  private async finish(row: ScheduledRow, change: { status: 'sent' | 'failed' | 'pending'; message_id?: string; sent_at?: Date; error_code: string | null }): Promise<void> {
    await this.updateLog.run(async (trx, updates) => {
      await trx.updateTable('app.scheduled_messages').set(change).where('id', '=', row.id).where('status', '=', 'sending').execute();
      updates.add({ userId: row.sender_id, kind: 'scheduled', chatId: row.conversation_id });
    });
  }

  // ------------------------------------------------------------------------------------------- views

  private async view(db: Executor, row: ScheduledRow): Promise<ScheduledMessage> {
    const [view] = await this.views(db, [row]);
    return view!;
  }

  private async views(db: Executor, rows: readonly ScheduledRow[]): Promise<ScheduledMessage[]> {
    const fileIds = rows.map((row) => (row.payload as ScheduledPayload).fileId).filter((id): id is string => Boolean(id));
    const files = fileIds.length > 0 ? await db.selectFrom('app.files').select(['id', 'kind', 'file_name']).where('id', 'in', fileIds).execute() : [];
    const fileById = new Map(files.map((file) => [file.id, file]));
    return rows.map((row) => {
      const payload = row.payload as ScheduledPayload;
      const file = payload.fileId ? fileById.get(payload.fileId) : undefined;
      return {
        id: row.id,
        chatId: row.conversation_id,
        clientId: row.client_id,
        sendAt: new Date(row.send_at).toISOString(),
        status: row.status === 'failed' ? 'failed' : 'pending',
        error: row.status === 'failed' ? row.error_code : null,
        text: payload.text ?? null,
        media: payload.poll ? 'poll' : payload.stickerId ? 'sticker' : (file?.kind ?? null),
        fileName: file?.file_name ?? null,
        pollQuestion: payload.poll?.question ?? null,
        replyToId: payload.replyToId ?? null,
        createdAt: new Date(row.created_at).toISOString(),
      };
    });
  }
}
