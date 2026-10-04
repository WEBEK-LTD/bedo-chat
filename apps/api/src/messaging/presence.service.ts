import { Inject, Injectable, Logger } from '@nestjs/common';
import { MESSAGING_RULES } from '@bedo/contracts';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { RedisService } from '../redis/redis.service.js';

const ONLINE_TTL_MS = MESSAGING_RULES.onlineTtlSeconds * 1000;

/**
 * Adds or refreshes one connection; returns 1 when the user had no live connection before (came online).
 * KEYS: presence set, last-seen key. ARGV: now, ttl, connection id.
 */
const TOUCH_SCRIPT = `
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local before = redis.call('ZCARD', KEYS[1])
redis.call('ZADD', KEYS[1], now + ttl, ARGV[3])
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('SET', KEYS[2], ARGV[1], 'PX', 2592000000)
if before == 0 then return 1 end
return 0
`;

/** Removes one connection; returns 1 when no live connection is left (went offline). */
const REMOVE_SCRIPT = `
local now = tonumber(ARGV[1])
redis.call('ZREM', KEYS[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('SET', KEYS[2], ARGV[1], 'PX', 2592000000)
if redis.call('ZCARD', KEYS[1]) == 0 then return 1 end
return 0
`;

export interface PresenceState {
  online: boolean;
  /** Milliseconds since the epoch, or null if never seen. */
  lastSeenMs: number | null;
}

/**
 * Online state and last seen (P-18, blueprint: Presence). A user is online while at least one of their
 * devices keeps its realtime connection alive (heartbeat every 25 s, each lasting 60 s). Last seen is kept
 * in Redis while connected and written to Postgres when the last device disconnects. Typing is never
 * stored. Who may see any of this is decided by the permission service, never here.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  private setKey(userId: string): string {
    return `${this.redis.prefix}:presence:${userId}`;
  }

  private lastSeenKey(userId: string): string {
    return `${this.redis.prefix}:lastseen:${userId}`;
  }

  /** Returns true when the user just came online. */
  async touch(userId: string, connectionId: string): Promise<boolean> {
    const result = await this.redis.client.eval(
      TOUCH_SCRIPT,
      2,
      this.setKey(userId),
      this.lastSeenKey(userId),
      String(Date.now()),
      String(ONLINE_TTL_MS),
      connectionId,
    );
    return result === 1;
  }

  /** Returns true when the user just went offline; their last seen is then stored in Postgres. */
  async remove(userId: string, connectionId: string): Promise<boolean> {
    const now = Date.now();
    let offline = true;
    try {
      offline = (await this.redis.client.eval(REMOVE_SCRIPT, 2, this.setKey(userId), this.lastSeenKey(userId), String(now), connectionId)) === 1;
    } catch (error) {
      this.logger.warn(`Presence update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (offline) {
      await this.database.db
        .insertInto('app.user_presence')
        .values({ user_id: userId, last_seen_at: new Date(now) })
        .onConflict((conflict) => conflict.column('user_id').doUpdateSet({ last_seen_at: sql`greatest(app.user_presence.last_seen_at, excluded.last_seen_at)` }))
        .execute();
    }
    return offline;
  }

  /** Raw presence for several users (no privacy applied). */
  async states(userIds: readonly string[]): Promise<Map<string, PresenceState>> {
    const ids = [...new Set(userIds)];
    const result = new Map<string, PresenceState>();
    if (ids.length === 0) {
      return result;
    }
    const now = Date.now();
    const redisState = new Map<string, { online: boolean; lastSeenMs: number | null }>();
    try {
      const pipeline = this.redis.client.pipeline();
      for (const id of ids) {
        pipeline.zcount(this.setKey(id), String(now), '+inf');
        pipeline.get(this.lastSeenKey(id));
      }
      const replies = (await pipeline.exec()) ?? [];
      ids.forEach((id, index) => {
        const count = replies[index * 2]?.[1];
        const lastSeen = replies[index * 2 + 1]?.[1];
        redisState.set(id, {
          online: typeof count === 'number' && count > 0,
          lastSeenMs: typeof lastSeen === 'string' ? Number(lastSeen) : null,
        });
      });
    } catch (error) {
      // Without Redis nobody shows as online; last seen still comes from Postgres.
      this.logger.warn(`Presence read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const stored = await this.database.db.selectFrom('app.user_presence').select(['user_id', 'last_seen_at']).where('user_id', 'in', ids).execute();
    const storedMs = new Map(stored.map((row) => [row.user_id, new Date(row.last_seen_at).getTime()]));
    for (const id of ids) {
      const live = redisState.get(id);
      const candidates = [live?.lastSeenMs ?? null, storedMs.get(id) ?? null].filter((value): value is number => value !== null && Number.isFinite(value));
      result.set(id, { online: live?.online ?? false, lastSeenMs: candidates.length > 0 ? Math.max(...candidates) : null });
    }
    return result;
  }
}

/** Last seen to the minute (P-18): seconds and milliseconds are dropped before anything leaves the API. */
export function lastSeenToMinute(ms: number | null): string | null {
  if (ms === null) {
    return null;
  }
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}
