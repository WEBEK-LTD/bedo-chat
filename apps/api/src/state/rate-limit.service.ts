import { isIPv4, isIPv6 } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Database } from '@bedo/db';
import { DatabaseService } from '../database/database.service.js';
import { inMs } from './ephemeral.store.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * The address a per-IP limit counts against. IPv6 clients usually control a whole /64, so every address in
 * it shares one budget; IPv4-mapped IPv6 addresses count as their IPv4 address.
 */
export function ipBucket(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1] && isIPv4(mapped[1])) {
    return mapped[1];
  }
  if (!isIPv6(ip)) {
    return ip;
  }
  const [head = '', tail = ''] = ip.toLowerCase().split('%')[0]!.split('::') as [string, string?];
  const headGroups = head ? head.split(':') : [];
  const tailGroups = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups] : headGroups;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

export type OtpGateResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; reason: 'cooldown' | 'phone_limit' | 'ip_limit' };

export interface OtpGateLimits {
  perPhonePerHour: number;
  perIpPerHour: number;
  cooldownSeconds: number;
  /** D-59: test account numbers count against their own per-address allowance, never real students' ("otp-ip"). */
  ipScope?: 'otp-ip' | 'otp-ip-test';
}

/**
 * Rate limits (D-36), in Postgres so every server function sees the same counts:
 *  - fixed-window counters (app.rate_counters): one row per key, the window starts with the first attempt;
 *  - the one-time-code gate (app.rate_events): sliding one-hour windows per number and per address, plus the
 *    resend cooldown, checked and recorded in one transaction under advisory locks so parallel requests
 *    cannot both pass.
 */
@Injectable()
export class RateLimitService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * Reserve-first attempt counter: the attempt is counted before the (slow) check runs, so parallel
   * requests cannot all see the same old count. Callers refuse when `count` exceeds their limit.
   */
  async reserveAttempt(key: string, windowMs: number): Promise<{ count: number; retryAfterSeconds: number }> {
    const { rows } = await sql<{ count: number; ms: string }>`
      insert into app.rate_counters as c (key, count, expires_at) values (${key}, 1, ${inMs(windowMs)})
      on conflict (key) do update set
        count = case when c.expires_at <= now() then 1 else c.count + 1 end,
        expires_at = case when c.expires_at <= now() then excluded.expires_at else c.expires_at end
      returning c.count, ceil(extract(epoch from (c.expires_at - now())) * 1000)::text as ms
    `.execute(this.database.db);
    const row = rows[0]!;
    return { count: Number(row.count), retryAfterSeconds: Math.max(1, Math.ceil(Number(row.ms) / 1000)) };
  }

  /**
   * Adds `units` to a fixed-window counter only if the total stays within `limit`. Refused attempts are not
   * counted, so a client that waits is not punished further. Returns the time left in the window.
   */
  async take(key: string, units: number, limit: number, windowMs: number): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const { rows } = await sql<{ ms: string }>`
      insert into app.rate_counters as c (key, count, expires_at)
      select ${key}, ${units}::int, ${inMs(windowMs)} where ${units}::int <= ${limit}::int
      on conflict (key) do update set
        count = case when c.expires_at <= now() then excluded.count else c.count + excluded.count end,
        expires_at = case when c.expires_at <= now() then excluded.expires_at else c.expires_at end
      where (case when c.expires_at <= now() then excluded.count else c.count + excluded.count end) <= ${limit}::int
      returning ceil(extract(epoch from (c.expires_at - now())) * 1000)::text as ms
    `.execute(this.database.db);
    if (rows[0]) {
      return { allowed: true, retryAfterMs: Number(rows[0].ms) };
    }
    const current = await this.database.db
      .selectFrom('app.rate_counters')
      .select(sql<string>`ceil(extract(epoch from (expires_at - now())) * 1000)::text`.as('ms'))
      .where('key', '=', key)
      .where('expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
    return { allowed: false, retryAfterMs: current ? Number(current.ms) : windowMs };
  }

  /** Forgets a counter (after a success that should clear earlier failures). */
  async reset(...keys: string[]): Promise<void> {
    if (keys.length > 0) {
      await this.database.db.deleteFrom('app.rate_counters').where('key', 'in', keys).execute();
    }
  }

  async otpGate(scope: string, phone: string, ip: string, limits: OtpGateLimits): Promise<OtpGateResult> {
    const phoneBucket = `${scope}:phone:${phone}`;
    // One per-IP budget for every kind of code (sign-in, phone change, admin): 20 per hour in total.
    const ipKey = `${limits.ipScope ?? 'otp-ip'}:${ipBucket(ip)}`;
    const cooldownKey = `rl:${scope}:cooldown:${phone}`;
    return this.database.db.transaction().execute(async (trx) => {
      // Always the number first, then the address, so two requests can never wait for each other in a cycle.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`otp-gate:${phoneBucket}`}, 0))`.execute(trx);
      await sql`select pg_advisory_xact_lock(hashtextextended(${`otp-gate:${ipKey}`}, 0))`.execute(trx);
      await trx
        .deleteFrom('app.rate_events')
        .where('bucket', 'in', [phoneBucket, ipKey])
        .where('at', '<=', sql<Date>`now() - make_interval(secs => ${HOUR_MS / 1000})`)
        .execute();
      const cooldown = await trx
        .selectFrom('app.ephemeral')
        .select(sql<string>`ceil(extract(epoch from (expires_at - now())) * 1000)::text`.as('ms'))
        .where('key', '=', cooldownKey)
        .where('expires_at', '>', sql<Date>`now()`)
        .executeTakeFirst();
      if (cooldown) {
        return refuse(Number(cooldown.ms), 'cooldown');
      }
      const phoneWindow = await windowOf(trx, phoneBucket);
      if (phoneWindow.count >= limits.perPhonePerHour) {
        return refuse(phoneWindow.oldestAgeMs === null ? HOUR_MS : HOUR_MS - phoneWindow.oldestAgeMs, 'phone_limit');
      }
      const ipWindow = await windowOf(trx, ipKey);
      if (ipWindow.count >= limits.perIpPerHour) {
        return refuse(ipWindow.oldestAgeMs === null ? HOUR_MS : HOUR_MS - ipWindow.oldestAgeMs, 'ip_limit');
      }
      await trx
        .insertInto('app.rate_events')
        .values([
          { bucket: phoneBucket, at: sql<Date>`now()` },
          { bucket: ipKey, at: sql<Date>`now()` },
        ])
        .execute();
      await trx
        .insertInto('app.ephemeral')
        .values({ key: cooldownKey, value: '1', expires_at: inMs(limits.cooldownSeconds * 1000) })
        .onConflict((conflict) => conflict.column('key').doUpdateSet({ value: '1', expires_at: (eb) => eb.ref('excluded.expires_at') }))
        .execute();
      return { allowed: true } as const;
    });
  }
}

function refuse(ms: number, reason: 'cooldown' | 'phone_limit' | 'ip_limit'): OtpGateResult {
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(ms / 1000)), reason };
}

async function windowOf(trx: Transaction<Database> | Kysely<Database>, bucket: string): Promise<{ count: number; oldestAgeMs: number | null }> {
  const row = await trx
    .selectFrom('app.rate_events')
    .select([
      sql<string>`count(*)::text`.as('count'),
      sql<string | null>`(extract(epoch from (now() - min(at))) * 1000)::text`.as('age'),
    ])
    .where('bucket', '=', bucket)
    .where('at', '>', sql<Date>`now() - make_interval(secs => ${HOUR_MS / 1000})`)
    .executeTakeFirstOrThrow();
  return { count: Number(row.count), oldestAgeMs: row.age === null ? null : Number(row.age) };
}
