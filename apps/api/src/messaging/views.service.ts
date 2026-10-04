import { Inject, Injectable } from '@nestjs/common';
import { type Message, MESSAGING_RULES, type Peer } from '@bedo/contracts';
import type { MessagesTable } from '@bedo/db';
import type { Selectable } from 'kysely';
import type { Executor } from '../audit/audit.service.js';
import { AccountsService } from '../auth/accounts.service.js';
import { PermissionService, type Relation } from './permissions.service.js';
import { lastSeenToMinute, PresenceService } from './presence.service.js';

export type MessageRow = Pick<
  Selectable<MessagesTable>,
  'id' | 'conversation_id' | 'seq' | 'sender_id' | 'client_id' | 'text' | 'reply_to_id' | 'forward_from_user_id' | 'created_at' | 'edited_at' | 'deleted_at'
>;

export const MESSAGE_COLUMNS = [
  'id',
  'conversation_id',
  'seq',
  'sender_id',
  'client_id',
  'text',
  'reply_to_id',
  'forward_from_user_id',
  'created_at',
  'edited_at',
  'deleted_at',
] as const;

/** Signed photo URLs last an hour; they are reused for 50 minutes. */
const PHOTO_CACHE_MS = 50 * 60 * 1000;
const PHOTO_CACHE_MAX = 5000;

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

/**
 * Builds everything about messages and other users that leaves the API. Every view of another user goes
 * through `peers`, which applies the permission service's visibility rules and toPublicUser (deleted
 * accounts appear as "Deleted account").
 */
@Injectable()
export class ViewsService {
  private readonly photoCache = new Map<string, { url: string | null; expires: number }>();

  constructor(
    @Inject(PermissionService) private readonly permissions: PermissionService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(PresenceService) private readonly presence: PresenceService,
  ) {}

  private async photoUrl(key: string | null): Promise<string | null> {
    if (!key) {
      return null;
    }
    const cached = this.photoCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.url;
    }
    const url = await this.accounts.photoUrl(key);
    if (this.photoCache.size >= PHOTO_CACHE_MAX) {
      this.photoCache.clear();
    }
    this.photoCache.set(key, { url, expires: Date.now() + PHOTO_CACHE_MS });
    return url;
  }

  async peers(db: Executor, viewerId: string, userIds: readonly string[]): Promise<Map<string, Peer>> {
    const [relations, viewerStatus] = await Promise.all([
      this.permissions.relations(db, viewerId, userIds),
      this.permissions.userStatus(db, viewerId),
    ]);
    const presenceIds = [...relations.values()].filter((relation) => this.permissions.visibilities(relation).presence).map((relation) => relation.user.id);
    const presence = await this.presence.states(presenceIds);
    const result = new Map<string, Peer>();
    await Promise.all(
      [...relations.values()].map(async (relation) => {
        result.set(relation.user.id, await this.peerView(relation, viewerStatus, presence));
      }),
    );
    return result;
  }

  async peer(db: Executor, viewerId: string, userId: string): Promise<Peer | null> {
    return (await this.peers(db, viewerId, [userId])).get(userId) ?? null;
  }

  private async peerView(relation: Relation, viewerStatus: Parameters<PermissionService['sendDecision']>[0] | null, presence: Map<string, { online: boolean; lastSeenMs: number | null }>): Promise<Peer> {
    const visible = this.permissions.visibilities(relation);
    const base = await this.accounts.toPublicUser(relation.user, { photoVisible: false });
    const state = presence.get(relation.user.id);
    return {
      ...base,
      photoUrl: visible.photo && !base.deleted ? await this.photoUrl(relation.user.photo_key) : null,
      phone: visible.phone ? relation.user.phone : null,
      presence: visible.presence && state ? { online: state.online, lastSeenAt: state.online ? null : lastSeenToMinute(state.lastSeenMs) } : null,
      blockedByMe: relation.blockedByViewer,
      canMessage: viewerStatus !== null && this.permissions.sendDecision(viewerStatus, relation).allowed,
    };
  }

  /**
   * Message views for one viewer. Rows the viewer has hidden must already be filtered out; replies to a
   * message that is deleted or hidden for the viewer show no text.
   */
  async messages(db: Executor, viewerId: string, rows: readonly MessageRow[]): Promise<Message[]> {
    if (rows.length === 0) {
      return [];
    }
    const replyIds = [...new Set(rows.map((row) => row.reply_to_id).filter((id): id is string => id !== null))];
    const forwardIds = [...new Set(rows.map((row) => row.forward_from_user_id).filter((id): id is string => id !== null))];
    const [replies, hiddenReplies, origins] = await Promise.all([
      replyIds.length > 0
        ? db.selectFrom('app.messages').select(['id', 'sender_id', 'text']).where('id', 'in', replyIds).execute()
        : Promise.resolve([]),
      replyIds.length > 0
        ? db.selectFrom('app.message_hidden').select('message_id').where('user_id', '=', viewerId).where('message_id', 'in', replyIds).execute()
        : Promise.resolve([]),
      forwardIds.length > 0
        ? db.selectFrom('app.users').select(['id', 'status', 'name', 'username', 'bio', 'photo_key']).where('id', 'in', forwardIds).execute()
        : Promise.resolve([]),
    ]);
    const hidden = new Set(hiddenReplies.map((row) => row.message_id));
    const replyById = new Map(replies.map((reply) => [reply.id, reply]));
    const originById = new Map<string, { id: string; displayName: string; deleted: boolean }>();
    for (const user of origins) {
      // Only the name is shown with a forward, so the photo is never signed here.
      const view = await this.accounts.toPublicUser(user, { photoVisible: false });
      originById.set(user.id, { id: view.id, displayName: view.displayName, deleted: view.deleted });
    }
    return rows.map((row) => {
      const reply = row.reply_to_id ? replyById.get(row.reply_to_id) : undefined;
      return {
        id: row.id,
        chatId: row.conversation_id,
        seq: Number(row.seq),
        senderId: row.sender_id,
        clientId: row.client_id,
        kind: 'text' as const,
        text: row.deleted_at ? null : row.text,
        deleted: row.deleted_at !== null,
        replyTo: reply
          ? {
              id: reply.id,
              senderId: reply.sender_id,
              text: hidden.has(reply.id) || reply.text === null ? null : Array.from(reply.text).slice(0, MESSAGING_RULES.replyPreviewLength).join(''),
            }
          : null,
        forwardedFrom: row.forward_from_user_id ? (originById.get(row.forward_from_user_id) ?? null) : null,
        createdAt: new Date(row.created_at).toISOString(),
        editedAt: iso(row.edited_at),
      };
    });
  }
}
