import { Inject, Injectable } from '@nestjs/common';
import { MESSAGING_RULES } from '@bedo/contracts';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { inMs } from '../state/ephemeral.store.js';

const ONLINE_TTL_MS = MESSAGING_RULES.onlineTtlSeconds * 1000;
/** Expired devices removed per sweep, so one request never does unbounded work. */
const SWEEP_BATCH = 500;

export interface PresenceState {
  online: boolean;
  /** Milliseconds since the epoch, or null if never seen. */
  lastSeenMs: number | null;
}

/**
 * Online state and last seen (P-18, blueprint: Presence). A user is online while at least one of their
 * signed-in devices keeps sending its heartbeat (every 25 s, each lasting 60 s). D-36: devices are rows in
 * app.presence_devices and last seen is app.user_presence, updated with every heartbeat, so every server
 * function sees the same state. Typing is never stored. Who may see any of this is decided by the
 * permission service, never here.
 */
@Injectable()
export class PresenceService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Marks one device online for the next 60 s. Returns true when the user just came online. */
  async touch(userId: string, sessionId: string): Promise<boolean> {
    const { rows } = await sql<{ live: number }>`
      with live as (
        select count(*)::int as n from app.presence_devices where user_id = ${userId} and expires_at > now()
      ), device as (
        insert into app.presence_devices (user_id, session_id, expires_at) values (${userId}, ${sessionId}, ${inMs(ONLINE_TTL_MS)})
        on conflict (user_id, session_id) do update set expires_at = excluded.expires_at
      ), seen as (
        insert into app.user_presence (user_id, last_seen_at) values (${userId}, now())
        on conflict (user_id) do update set last_seen_at = greatest(app.user_presence.last_seen_at, excluded.last_seen_at)
      )
      select n as live from live
    `.execute(this.database.db);
    return Number(rows[0]?.live ?? 0) === 0;
  }

  /** Marks one device offline (sign-out, page closed). Returns true when the user just went offline. */
  async remove(userId: string, sessionId: string): Promise<boolean> {
    const removed = await this.database.db
      .deleteFrom('app.presence_devices')
      .where('user_id', '=', userId)
      .where('session_id', '=', sessionId)
      .returning(sql<boolean>`expires_at > now()`.as('live'))
      .executeTakeFirst();
    if (!removed?.live) {
      return false;
    }
    await this.database.db
      .insertInto('app.user_presence')
      .values({ user_id: userId, last_seen_at: sql<Date>`now()` })
      .onConflict((conflict) => conflict.column('user_id').doUpdateSet({ last_seen_at: sql`greatest(app.user_presence.last_seen_at, excluded.last_seen_at)` }))
      .execute();
    return !(await this.hasLiveDevice(userId));
  }

  /**
   * Removes devices whose heartbeat stopped (closed without saying so, lost network) and returns the users
   * who went offline because of it. Each expired row is removed by exactly one request.
   */
  async sweep(): Promise<string[]> {
    const { rows } = await sql<{ user_id: string }>`
      with doomed as (
        select user_id, session_id from app.presence_devices where expires_at <= now()
        order by expires_at limit ${SWEEP_BATCH} for update skip locked
      ), removed as (
        delete from app.presence_devices p using doomed d
        where p.user_id = d.user_id and p.session_id = d.session_id and p.expires_at <= now()
        returning p.user_id
      )
      select distinct r.user_id from removed r
      where not exists (select 1 from app.presence_devices l where l.user_id = r.user_id and l.expires_at > now())
    `.execute(this.database.db);
    return rows.map((row) => row.user_id);
  }

  private async hasLiveDevice(userId: string): Promise<boolean> {
    const row = await this.database.db
      .selectFrom('app.presence_devices')
      .select(sql<number>`1`.as('one'))
      .where('user_id', '=', userId)
      .where('expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** Raw presence for several users (no privacy applied). */
  async states(userIds: readonly string[]): Promise<Map<string, PresenceState>> {
    const ids = [...new Set(userIds)];
    const result = new Map<string, PresenceState>();
    if (ids.length === 0) {
      return result;
    }
    const live = await this.database.db
      .selectFrom('app.presence_devices')
      .select('user_id')
      .distinct()
      .where('user_id', 'in', ids)
      .where('expires_at', '>', sql<Date>`now()`)
      .execute();
    const online = new Set(live.map((row) => row.user_id));
    const stored = await this.database.db.selectFrom('app.user_presence').select(['user_id', 'last_seen_at']).where('user_id', 'in', ids).execute();
    const storedMs = new Map(stored.map((row) => [row.user_id, new Date(row.last_seen_at).getTime()]));
    for (const id of ids) {
      const seen = storedMs.get(id);
      result.set(id, { online: online.has(id), lastSeenMs: seen !== undefined && Number.isFinite(seen) ? seen : null });
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
