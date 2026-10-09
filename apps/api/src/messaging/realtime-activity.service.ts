import { Inject, Injectable, Logger } from '@nestjs/common';
import { MESSAGING_RULES, type RealtimeChannelResponse, REALTIME_SIGNAL_EVENT } from '@bedo/contracts';
import { DatabaseService } from '../database/database.service.js';
import { DeferredTasks } from '../runtime/deferred-tasks.service.js';
import { RateLimitService } from '../state/rate-limit.service.js';
import { PermissionService } from './permissions.service.js';
import { lastSeenToMinute, PresenceService } from './presence.service.js';
import { RealtimeService } from './realtime.service.js';
import { SyncService } from './sync.service.js';

/** Typing indicators are relayed at most every 2 seconds per chat and device; each lasts 6 seconds (P-18). */
const TYPING_RELAY_INTERVAL_MS = 2_000;
/** Typing notices a device may send per minute, across all its chats; more are answered but not relayed. */
const TYPING_PER_DEVICE_PER_MINUTE = 60;
/** Heartbeats a device may send per minute (the client sends one every 25 s); more are answered but ignored. */
const HEARTBEATS_PER_MINUTE = 10;

/**
 * What a signed-in device does to be "connected" (D-36): it listens on its channel (GET channel), sends a
 * heartbeat every 25 s (online for 60 s each, P-18), says when the user types, and says when it goes away.
 * Changes of online state are announced to chat partners who may see them (P-31, blocks).
 */
@Injectable()
export class RealtimeActivityService {
  private readonly logger = new Logger(RealtimeActivityService.name);

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(RealtimeService) private readonly realtime: RealtimeService,
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(PermissionService) private readonly permissions: PermissionService,
    @Inject(SyncService) private readonly sync: SyncService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
    @Inject(DeferredTasks) private readonly deferred: DeferredTasks,
  ) {}

  channel(userId: string, sessionId: string): RealtimeChannelResponse {
    const client = this.realtime.client;
    const channel = client ? this.realtime.channelFor(sessionId) : null;
    const accessToken = channel ? this.realtime.deviceToken(userId, channel) : null;
    return {
      enabled: client !== null && accessToken !== null,
      url: client?.url ?? null,
      apiKey: client?.apiKey ?? null,
      accessToken,
      topic: channel?.topic ?? null,
      expiresAt: channel?.expiresAt.toISOString() ?? null,
      expiresInSeconds: channel ? Math.max(0, Math.floor((channel.expiresAt.getTime() - Date.now()) / 1000)) : null,
      event: REALTIME_SIGNAL_EVENT,
      heartbeatSeconds: MESSAGING_RULES.heartbeatSeconds,
    };
  }

  /** P-18 heartbeat. Returns the user's current update seq, so a device that missed a signal catches up. */
  async heartbeat(userId: string, sessionId: string): Promise<{ seq: number }> {
    const allowed = await this.rateLimit.take(`rl:heartbeat:${sessionId}`, 1, HEARTBEATS_PER_MINUTE, 60_000);
    if (allowed.allowed) {
      if (await this.presence.touch(userId, sessionId)) {
        this.deferred.defer('presence', () => this.announcePresence(userId));
      }
      // Devices that stopped sending heartbeats (closed without saying so) go offline here.
      this.deferred.defer('presence-sweep', () => this.sweep());
    }
    return { seq: await this.sync.currentSeq(userId) };
  }

  async offline(userId: string, sessionId: string): Promise<void> {
    if (await this.presence.remove(userId, sessionId)) {
      this.deferred.defer('presence', () => this.announcePresence(userId));
    }
  }

  async typing(userId: string, sessionId: string, chatId: string): Promise<void> {
    // A device sends at most one typing notice every 3 seconds per chat (the client); this caps a device's total.
    const device = await this.rateLimit.take(`rl:typing-device:${sessionId}`, 1, TYPING_PER_DEVICE_PER_MINUTE, 60_000);
    if (!device.allowed) {
      return;
    }
    const db = this.database.db;
    const access = await this.permissions.findChatAccess(db, userId, chatId);
    // Typing is shown only where a message could be sent (no block either way, messaging allowed).
    if (!access || !(await this.permissions.canSend(db, userId, access.peerId))) {
      return;
    }
    const relay = await this.rateLimit.take(`rl:typing:${sessionId}:${chatId}`, 1, 1, TYPING_RELAY_INTERVAL_MS);
    if (relay.allowed) {
      this.realtime.sendEvent(access.peerId, { type: 'typing', chatId, userId });
    }
  }

  private async sweep(): Promise<void> {
    for (const userId of await this.presence.sweep()) {
      await this.announcePresence(userId);
    }
  }

  /** Tells the user's chat partners about a change of online state, where they may see it (P-31, blocks). */
  async announcePresence(userId: string): Promise<void> {
    if (!this.realtime.enabled) {
      return;
    }
    const db = this.database.db;
    const chats = await db
      .selectFrom('app.conversations')
      .select(['private_low', 'private_high'])
      .where('type', '=', 'private')
      .where((eb) => eb.or([eb('private_low', '=', userId), eb('private_high', '=', userId)]))
      .execute();
    const partners = chats.map((chat) => (chat.private_low === userId ? chat.private_high : chat.private_low)).filter((id): id is string => id !== null);
    if (partners.length === 0) {
      return;
    }
    const relations = await this.permissions.relationsToward(db, userId, partners);
    const state = (await this.presence.states([userId])).get(userId);
    if (!state) {
      return;
    }
    const presence = { online: state.online, lastSeenAt: state.online ? null : lastSeenToMinute(state.lastSeenMs) };
    for (const [partnerId, relation] of relations) {
      if (this.permissions.visibilities(relation).presence) {
        this.realtime.sendEvent(partnerId, { type: 'presence', userId, presence });
      }
    }
  }
}
