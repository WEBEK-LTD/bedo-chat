import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { MESSAGING_RULES } from '@bedo/contracts';
import { AppError } from '../common/app-error.js';
import { RedisService } from '../redis/redis.service.js';

/**
 * Adds `units` to a fixed-window counter only if the total stays within the limit; returns
 * {allowed, ttlMs}. Refused attempts are not counted, so a client that waits is not punished further.
 */
const LIMIT_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local units = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if current + units > limit then
  return {0, redis.call('PTTL', KEYS[1])}
end
local count = redis.call('INCRBY', KEYS[1], units)
if count == units then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
return {1, redis.call('PTTL', KEYS[1])}
`;

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
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  private async take(name: string, userId: string, units: number, limit: number, windowMs: number): Promise<void> {
    if (units > limit) {
      // More than a whole window allows (e.g. forwarding 40 copies at once): waiting would never help.
      throw new AppError(HttpStatus.CONFLICT, 'LIMIT_REACHED');
    }
    let reply: [number, number];
    try {
      reply = (await this.redis.client.eval(LIMIT_SCRIPT, 1, `${this.redis.prefix}:rl:${name}:${userId}`, String(units), String(limit), String(windowMs))) as [number, number];
    } catch {
      // Without Redis the limits cannot be enforced; refuse rather than let the action through unlimited.
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'SERVICE_UNAVAILABLE');
    }
    if (reply[0] !== 1) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', Math.max(1, Math.ceil(Math.max(reply[1], 0) / 1000)));
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

  /** People search (P-25), so the academy directory cannot be listed quickly. */
  userSearches(userId: string): Promise<void> {
    return this.take('user-search', userId, 1, MESSAGING_RULES.userSearchesPerMinute, MINUTE_MS);
  }
}
