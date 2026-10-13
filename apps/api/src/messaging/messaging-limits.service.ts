import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { CHANNEL_RULES, GROUP_RULES, MEDIA_RULES, MESSAGING_RULES } from '@bedo/contracts';
import { AppError } from '../common/app-error.js';
import { RateLimitService } from '../state/rate-limit.service.js';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Phase 3 rate limits (D-30): messages 30 per minute per user, with edits and every forwarded copy counted
 * as messages; reports 20 per day per user. Guards for screenshot intake, actions that notify the other
 * person, and people search are implementation limits (docs/PHASE-3-REPORT.md).
 */
@Injectable()
export class MessagingLimitsService {
  constructor(@Inject(RateLimitService) private readonly rateLimit: RateLimitService) {}

  private async take(name: string, userId: string, units: number, limit: number, windowMs: number): Promise<void> {
    if (units > limit) {
      // More than a whole window allows (e.g. forwarding 40 copies at once): waiting would never help.
      throw new AppError(HttpStatus.CONFLICT, 'LIMIT_REACHED');
    }
    let result: { allowed: boolean; retryAfterMs: number };
    try {
      result = await this.rateLimit.take(`rl:${name}:${userId}`, units, limit, windowMs);
    } catch {
      // Without the database the limits cannot be enforced; refuse rather than let the action through unlimited.
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE');
    }
    if (!result.allowed) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', Math.max(1, Math.ceil(Math.max(result.retryAfterMs, 0) / 1000)));
    }
  }

  /** Sending, editing and forwarding (`units` = destination chats). */
  messages(userId: string, units = 1): Promise<void> {
    return this.take('messages', userId, units, MESSAGING_RULES.messagesPerMinute, MINUTE_MS);
  }

  reports(userId: string): Promise<void> {
    return this.take('reports', userId, 1, MESSAGING_RULES.reportsPerDay, DAY_MS);
  }

  screenshotEvents(userId: string): Promise<void> {
    return this.take('screenshots', userId, 1, MESSAGING_RULES.screenshotEventsPerHour, HOUR_MS);
  }

  /** Pin, unpin, block and unblock: each notifies the other person's devices. */
  peerActions(userId: string): Promise<void> {
    return this.take('peer-actions', userId, 1, MESSAGING_RULES.peerActionsPerMinute, MINUTE_MS);
  }

  /** Phase 4: upload slots per hour (each slot is a file the person may then send). */
  uploads(userId: string): Promise<void> {
    return this.take('uploads', userId, 1, MEDIA_RULES.uploadsPerHour, HOUR_MS);
  }

  /** Phase 4: GIF searches go to GIPHY with the academy's key, which has its own limits. */
  gifSearches(userId: string): Promise<void> {
    return this.take('gif-search', userId, 1, MEDIA_RULES.gifSearchesPerMinute, MINUTE_MS);
  }

  /** Phase 4: reactions notify the other person's devices. */
  reactions(userId: string): Promise<void> {
    return this.take('reactions', userId, 1, MEDIA_RULES.reactionsPerMinute, MINUTE_MS);
  }

  /** Phase 5: groups created per user per day (blueprint rate limit). */
  groupsCreated(userId: string): Promise<void> {
    return this.take('groups-created', userId, 1, GROUP_RULES.groupsPerDay, DAY_MS);
  }

  /** Phase 5: group changes, invite-link previews and joins (each notifies members' devices). */
  groupActions(userId: string): Promise<void> {
    return this.take('group-actions', userId, 1, GROUP_RULES.groupActionsPerMinute, MINUTE_MS);
  }

  /** Phase 6: channels created per user per day. */
  channelsCreated(userId: string): Promise<void> {
    return this.take('channels-created', userId, 1, CHANNEL_RULES.channelsPerDay, DAY_MS);
  }

  /** Phase 6: public channel search (the same budget as people search). */
  channelSearches(userId: string): Promise<void> {
    return this.take('channel-search', userId, 1, MESSAGING_RULES.userSearchesPerMinute, MINUTE_MS);
  }

  /** Phase 8: global message search (the same budget as people search). */
  searches(userId: string): Promise<void> {
    return this.take('global-search', userId, 1, MESSAGING_RULES.userSearchesPerMinute, MINUTE_MS);
  }

  /** Phase 9: a device saying which chat it shows (on open, on page visibility, every 45 seconds). */
  viewing(userId: string): Promise<void> {
    return this.take('viewing', userId, 1, 120, MINUTE_MS);
  }

  /** Phase 9: short-lived file links (each one signs a URL with the storage service). */
  fileLinks(userId: string): Promise<void> {
    return this.take('file-links', userId, 1, MEDIA_RULES.fileLinksPerMinute, MINUTE_MS);
  }

  /** Phase 9: looking up a profile by id. */
  profiles(userId: string): Promise<void> {
    return this.take('profiles', userId, 1, MESSAGING_RULES.userSearchesPerMinute * 2, MINUTE_MS);
  }

  /** People search (P-25), so the academy directory cannot be listed quickly. */
  userSearches(userId: string): Promise<void> {
    return this.take('user-search', userId, 1, MESSAGING_RULES.userSearchesPerMinute, MINUTE_MS);
  }
}
