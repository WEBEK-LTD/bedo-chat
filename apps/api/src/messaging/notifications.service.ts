import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { BADGE_MAX, DEFAULT_NOTIFICATION_SETTINGS, type FileKind, type NotificationSettings } from '@bedo/contracts';
import { sql } from 'kysely';
import type { Executor } from '../audit/audit.service.js';
import { AppError } from '../common/app-error.js';
import { DatabaseService } from '../database/database.service.js';
import { PushService } from '../delivery/push.service.js';
import { DeferredTasks } from '../runtime/deferred-tasks.service.js';
import { MessagingLimitsService } from './messaging-limits.service.js';
import { PermissionService } from './permissions.service.js';
import { PresenceService } from './presence.service.js';

/** How media is named in a notification (the same words as in the apps). */
const MEDIA_WORDS: Record<FileKind, string> = {
  photo: 'Photo',
  video: 'Video',
  audio: 'Audio',
  voice: 'Voice message',
  video_note: 'Video message',
  file: 'File',
  gif: 'GIF',
};
const GENERIC = { title: 'Bedo Chat', body: 'New message' } as const;
const DELETED_ACCOUNT = 'Deleted account';
const BODY_MAX = 280;
const TITLE_MAX = 100;

const clip = (text: string, max: number) => {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
};

interface Recipient {
  user_id: string;
  session_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Notifications (Phase 7, D-41; blueprint: Notifications and push). After a message is stored, the API decides who
 * is told and how, then sends Web Push to their devices right after the response (D-36). The rules:
 *  - everyone in the chat but the sender, on devices that are signed in and not showing that chat right now;
 *  - not when the person muted the chat or turned that kind of chat off, unless the message mentions them or replies
 *    to them (O-19); never about someone they blocked;
 *  - the sender and the text (O-19), or "New message" when they turned previews off; a channel's posts show the
 *    channel, never the admin who posted;
 *  - every push carries the badge count, computed here from read positions, so all devices show the same number.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PushService) private readonly push: PushService,
    @Inject(DeferredTasks) private readonly deferred: DeferredTasks,
    @Inject(PermissionService) private readonly permissions: PermissionService,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(MessagingLimitsService) private readonly limits: MessagingLimitsService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ------------------------------------------------------------------------------------- settings

  async settings(db: Executor, userId: string): Promise<NotificationSettings> {
    const row = await db.selectFrom('app.notification_settings').selectAll().where('user_id', '=', userId).executeTakeFirst();
    return row ? { privateChats: row.private_chats, groups: row.groups, channels: row.channels, previews: row.previews } : { ...DEFAULT_NOTIFICATION_SETTINGS };
  }

  async updateSettings(userId: string, change: Partial<NotificationSettings>): Promise<NotificationSettings> {
    const next = { ...(await this.settings(this.db, userId)), ...change };
    const values = { private_chats: next.privateChats, groups: next.groups, channels: next.channels, previews: next.previews };
    await this.db
      .insertInto('app.notification_settings')
      .values({ user_id: userId, ...values })
      .onConflict((conflict) => conflict.column('user_id').doUpdateSet(values))
      .execute();
    return next;
  }

  /** This device shows `chatId` (or nothing): it is not pushed about that chat while it does. */
  async viewing(userId: string, sessionId: string, chatId: string | null): Promise<void> {
    await this.limits.viewing(userId);
    if (chatId && !(await this.permissions.findChatAccess(this.db, userId, chatId))) {
      throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND');
    }
    await this.presence.touch(userId, sessionId);
    await this.db.updateTable('app.presence_devices').set({ viewing_chat_id: chatId }).where('user_id', '=', userId).where('session_id', '=', sessionId).execute();
  }

  // ---------------------------------------------------------------------------------------- badge

  /** Badge counts for several users: unread messages in chats they did not mute (a chat marked unread counts 1). */
  async badges(db: Executor, userIds: readonly string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>(userIds.map((id) => [id, 0]));
    if (userIds.length === 0) return result;
    const { rows } = await sql<{ user_id: string; badge: number }>`
      select me.user_id, least(coalesce(sum(
        case when s.muted_until is not null and s.muted_until > now() then 0
             when u.n > 0 then u.n
             when coalesce(s.marked_unread, false) then 1
             else 0 end), 0), ${BADGE_MAX})::int as badge
      from app.conversation_members me
      join app.conversations c on c.id = me.conversation_id and c.deleted_at is null
      left join app.user_chat_state s on s.user_id = me.user_id and s.conversation_id = c.id
      left join lateral (
        select count(*)::int as n from (
          select 1 from app.messages m
          where m.conversation_id = c.id and m.seq > me.read_seq and m.sender_id <> me.user_id and m.deleted_at is null
            and not exists (select 1 from app.message_hidden h where h.user_id = me.user_id and h.message_id = m.id)
          limit 1000
        ) unread
      ) u on true
      where me.user_id in (${sql.join([...userIds])})
        and (c.type <> 'private' or exists (
          select 1 from app.conversation_members p where p.conversation_id = c.id and p.user_id <> me.user_id))
      group by me.user_id
    `.execute(db);
    for (const row of rows) result.set(row.user_id, Number(row.badge));
    return result;
  }

  async badge(userId: string): Promise<number> {
    return (await this.badges(this.db, [userId])).get(userId) ?? 0;
  }

  // ---------------------------------------------------------------------------------------- events

  /** New messages in a chat (sent, forwarded or scheduled): notify after the response. */
  messagesCreated(chatId: string, messageIds: readonly string[], senderId: string): void {
    if (messageIds.length === 0) return;
    this.deferred.defer('notifications', () => this.deliverMessages(chatId, [...messageIds], senderId));
  }

  /** People were added to (or let into) a group or channel by someone else (null: by a system admin, Phase 10). */
  addedToChat(chatId: string, userIds: readonly string[], actorId: string | null): void {
    const targets = userIds.filter((id) => id !== actorId);
    if (targets.length === 0) return;
    this.deferred.defer('notifications', () => this.deliverAdded(chatId, targets, actorId));
  }

  private async recipients(db: Executor, chatId: string, userIds: readonly string[] | null, excludeUserId: string): Promise<Recipient[]> {
    const { rows } = await sql<Recipient>`
      select m.user_id, ps.session_id, ps.endpoint, ps.p256dh, ps.auth
      from app.conversation_members m
      join app.push_subscriptions ps on ps.user_id = m.user_id
      join app.sessions se on se.id = ps.session_id and se.revoked_at is null and se.expires_at > now()
      where m.conversation_id = ${chatId} and m.user_id <> ${excludeUserId}
        ${userIds ? sql`and m.user_id in (${sql.join([...userIds])})` : sql``}
        and not exists (
          select 1 from app.presence_devices d
          where d.user_id = m.user_id and d.session_id = ps.session_id and d.viewing_chat_id = ${chatId} and d.expires_at > now()
        )
    `.execute(db);
    return rows;
  }

  private async send(recipients: readonly Recipient[], content: (userId: string) => { title: string; body: string } | null, tag: string, url: string): Promise<void> {
    const byUser = new Map<string, Recipient[]>();
    for (const recipient of recipients) byUser.set(recipient.user_id, [...(byUser.get(recipient.user_id) ?? []), recipient]);
    const badges = await this.badges(this.db, [...byUser.keys()]);
    await Promise.all(
      [...byUser].map(async ([userId, devices]) => {
        const text = content(userId);
        if (!text) return;
        await this.push.deliver({
          userId,
          excludeSessionId: null,
          notification: { title: clip(text.title, TITLE_MAX), body: clip(text.body, BODY_MAX), tag, url, badge: badges.get(userId) ?? 0 },
          subscriptions: devices.map((device) => ({ endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth })),
        });
      }),
    );
  }

  private async deliverMessages(chatId: string, messageIds: string[], senderId: string): Promise<void> {
    const db = this.db;
    const recipients = await this.recipients(db, chatId, null, senderId);
    if (recipients.length === 0) return;
    const userIds = [...new Set(recipients.map((recipient) => recipient.user_id))];
    const [chat, sender, messages, settings, states, blocks, mentions] = await Promise.all([
      db.selectFrom('app.conversations').select(['type', 'title']).where('id', '=', chatId).executeTakeFirst(),
      db.selectFrom('app.users').select(['name', 'status']).where('id', '=', senderId).executeTakeFirst(),
      db
        .selectFrom('app.messages as m')
        .leftJoin('app.files as f', 'f.id', 'm.file_id')
        .leftJoin('app.stickers as st', 'st.id', 'm.sticker_id')
        .leftJoin('app.polls as p', 'p.id', 'm.poll_id')
        .leftJoin('app.messages as r', 'r.id', 'm.reply_to_id')
        .select(['m.id', 'm.text', 'm.kind', 'm.forward_from_user_id', 'm.forward_from_chat_id', 'f.kind as file_kind', 'st.emoji', 'p.question', 'r.sender_id as reply_sender_id'])
        .where('m.id', 'in', messageIds)
        .orderBy('m.seq')
        .execute(),
      db.selectFrom('app.notification_settings').selectAll().where('user_id', 'in', userIds).execute(),
      db.selectFrom('app.user_chat_state').select(['user_id', 'muted_until']).where('conversation_id', '=', chatId).where('user_id', 'in', userIds).execute(),
      db.selectFrom('app.blocks').select('blocker_id').where('blocked_id', '=', senderId).where('blocker_id', 'in', userIds).execute(),
      db.selectFrom('app.message_mentions').select('user_id').where('message_id', 'in', messageIds).where('user_id', 'in', userIds).execute(),
    ]);
    if (!chat || messages.length === 0) return;
    const settingsOf = new Map(settings.map((row) => [row.user_id, row]));
    const mutedFor = new Set(states.filter((row) => row.muted_until && new Date(row.muted_until).getTime() > Date.now()).map((row) => row.user_id));
    const blockedBy = new Set(blocks.map((row) => row.blocker_id));
    const mentioned = new Set(mentions.map((row) => row.user_id));
    const repliedTo = new Set(messages.map((message) => message.reply_sender_id).filter((id): id is string => id !== null));
    const senderName = !sender || sender.status === 'deleted' ? DELETED_ACCOUNT : sender.name || 'Bedo Chat user';
    const last = messages[messages.length - 1]!;
    const describe = (message: (typeof messages)[number]) => {
      const media = message.question
        ? `📊 ${message.question}`
        : message.emoji
          ? `${message.emoji} Sticker`
          : message.file_kind
            ? MEDIA_WORDS[message.file_kind]
            : null;
      const text = message.text?.trim() || null;
      return media ? (text ? `${media}, ${text}` : media) : (text ?? 'Message');
    };
    const forwarded = messages.every((message) => message.forward_from_user_id || message.forward_from_chat_id);
    const summary = messages.length > 1 ? `${messages.length} ${forwarded ? 'forwarded messages' : 'messages'}` : `${forwarded ? 'Forwarded: ' : ''}${describe(last)}`;
    const category = chat.type === 'private' ? 'private_chats' : chat.type === 'group' ? 'groups' : 'channels';

    await this.send(
      recipients,
      (userId) => {
        // In a channel the post is the channel's: skipping it for someone who blocked its author would tell
        // them who posted (D-40), so blocks apply to private chats and groups only.
        if (chat.type !== 'channel' && blockedBy.has(userId)) return null;
        const own = settingsOf.get(userId);
        const direct = mentioned.has(userId) || repliedTo.has(userId);
        // O-19: a mention or a reply notifies even in a muted chat or a category turned off.
        if (!direct && (mutedFor.has(userId) || own?.[category] === false)) return null;
        if (own?.previews === false) return { ...GENERIC };
        if (chat.type === 'private') return { title: senderName, body: summary };
        if (chat.type === 'channel') return { title: chat.title ?? 'Channel', body: summary };
        const lead = mentioned.has(userId) ? `${senderName} mentioned you: ` : `${senderName}: `;
        return { title: chat.title ?? 'Group', body: `${lead}${summary}` };
      },
      `chat-${chatId}`,
      `/?chat=${chatId}`,
    );
  }

  private async deliverAdded(chatId: string, userIds: string[], actorId: string | null): Promise<void> {
    const db = this.db;
    const recipients = await this.recipients(db, chatId, userIds, actorId ?? '00000000-0000-0000-0000-000000000000');
    if (recipients.length === 0) return;
    const [chat, actor, settings] = await Promise.all([
      db.selectFrom('app.conversations').select(['type', 'title']).where('id', '=', chatId).executeTakeFirst(),
      actorId ? db.selectFrom('app.users').select(['name', 'status']).where('id', '=', actorId).executeTakeFirst() : Promise.resolve(undefined),
      db.selectFrom('app.notification_settings').select(['user_id', 'previews']).where('user_id', 'in', userIds).execute(),
    ]);
    if (!chat) return;
    const noPreview = new Set(settings.filter((row) => !row.previews).map((row) => row.user_id));
    const actorName = actorId === null ? 'An administrator' : !actor || actor.status === 'deleted' ? DELETED_ACCOUNT : actor.name || 'Bedo Chat user';
    const noun = chat.type === 'channel' ? 'channel' : 'group';
    await this.send(
      recipients,
      (userId) => (noPreview.has(userId) ? { title: 'Bedo Chat', body: `You were added to a ${noun}` } : { title: chat.title ?? 'Bedo Chat', body: `${actorName} added you to the ${noun}` }),
      `chat-${chatId}`,
      `/?chat=${chatId}`,
    );
  }
}
