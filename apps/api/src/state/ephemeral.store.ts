import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';

/** `ms` milliseconds from the database's clock, as SQL. */
export const inMs = (ms: number) => sql<Date>`now() + make_interval(secs => ${Math.max(0, Math.trunc(ms)) / 1000})`;

/**
 * Short-lived server state with an expiry (D-36), in Postgres (app.ephemeral): pending sign-ins, authenticator
 * setup secrets (stored encrypted by the caller), photo-upload tickets. The website's server functions keep
 * nothing between requests, so this is the shared place every request sees. A row past its expiry is treated
 * as absent by every read and removed by the hourly housekeeping.
 */
@Injectable()
export class EphemeralStore {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /** Stores (or replaces) a value for `ttlMs`. */
  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.database.db
      .insertInto('app.ephemeral')
      .values({ key, value, expires_at: inMs(ttlMs) })
      .onConflict((conflict) => conflict.column('key').doUpdateSet({ value: (eb) => eb.ref('excluded.value'), expires_at: (eb) => eb.ref('excluded.expires_at') }))
      .execute();
  }

  /** Stores the value only when the key is absent (or expired); true when it was stored. */
  async setIfAbsent(key: string, value: string, ttlMs: number): Promise<boolean> {
    const row = await this.database.db
      .insertInto('app.ephemeral')
      .values({ key, value, expires_at: inMs(ttlMs) })
      .onConflict((conflict) =>
        conflict
          .column('key')
          .doUpdateSet({ value: (eb) => eb.ref('excluded.value'), expires_at: (eb) => eb.ref('excluded.expires_at') })
          .where('app.ephemeral.expires_at', '<=', sql<Date>`now()`),
      )
      .returning('key')
      .executeTakeFirst();
    return row !== undefined;
  }

  async get(key: string): Promise<string | null> {
    const row = await this.database.db
      .selectFrom('app.ephemeral')
      .select('value')
      .where('key', '=', key)
      .where('expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
    return row?.value ?? null;
  }

  /** Milliseconds the value has left, or null when absent or expired. */
  async ttlMs(key: string): Promise<number | null> {
    const row = await this.database.db
      .selectFrom('app.ephemeral')
      .select(sql<string>`ceil(extract(epoch from (expires_at - now())) * 1000)`.as('ms'))
      .where('key', '=', key)
      .where('expires_at', '>', sql<Date>`now()`)
      .executeTakeFirst();
    return row ? Math.max(1, Number(row.ms)) : null;
  }

  /** Removes the keys; returns how many of them held an unexpired value. */
  async delete(...keys: string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    const rows = await this.database.db
      .deleteFrom('app.ephemeral')
      .where('key', 'in', keys)
      .returning(sql<boolean>`expires_at > now()`.as('live'))
      .execute();
    return rows.filter((row) => row.live).length;
  }

  /** Reads and removes the value in one step (only one caller can ever take it). */
  async take(key: string): Promise<string | null> {
    const row = await this.database.db
      .deleteFrom('app.ephemeral')
      .where('key', '=', key)
      .returning(['value', sql<boolean>`expires_at > now()`.as('live')])
      .executeTakeFirst();
    return row?.live ? row.value : null;
  }
}
