import { Inject, Injectable } from '@nestjs/common';
import type { WorkerEnv } from '@bedo/config';
import { OTP_DELIVERY_ERRORS } from '@bedo/contracts';
import type { DbHandle } from '@bedo/db';
import { decryptWaabekApiKey, parseAes256Key } from '@bedo/server-crypto';
import { UnrecoverableError } from 'bullmq';
import { WORKER_DB } from '../database.js';
import { WORKER_ENV } from '../tokens.js';

/**
 * The Waabek settings cannot be used (no key stored, or it cannot be decrypted). Retrying cannot help, so
 * the job fails at once (BullMQ UnrecoverableError). The message is one of OTP_DELIVERY_ERRORS: it never
 * contains the key or the stored value.
 */
export class OtpConfigurationError extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = 'OtpConfigurationError';
  }
}

interface CachedKey {
  version: string;
  stored: string;
  apiKey: string;
}

/**
 * The Waabek API key for sending, from the Admin Dashboard-managed settings (D-32).
 *
 * Refresh mechanism: the key lives only in Postgres (app.otp_settings, encrypted with SETTINGS_ENCRYPTION_KEY).
 * Before EVERY message this reads the settings row's `version` and stored value (one single-row query by
 * primary key) and decrypts only when they changed since the last message; the decrypted key is kept in this
 * process's memory only. So a change made in the Admin Dashboard applies to the next message on every worker
 * instance, without a restart and without any message between instances that could be missed; a cached key
 * is never used without first confirming it is still the current one; and nothing about the key is ever put
 * in Redis or the logs. It fails closed: no key, an unreadable key, or an unreachable database means the
 * message is not sent.
 */
@Injectable()
export class WaabekKeyProvider {
  private readonly settingsKey: Buffer;
  private cached: CachedKey | null = null;

  constructor(
    @Inject(WORKER_ENV) env: WorkerEnv,
    @Inject(WORKER_DB) private readonly database: DbHandle,
  ) {
    this.settingsKey = parseAes256Key(env.SETTINGS_ENCRYPTION_KEY);
  }

  async currentKey(): Promise<string> {
    // A database error propagates: the job is retried later with the normal backoff, never sent with a key
    // that could be out of date.
    const row = await this.database.db
      .selectFrom('app.otp_settings')
      .select(['version', 'waabek_api_key_enc'])
      .where('id', '=', true)
      .executeTakeFirst();
    if (!row?.waabek_api_key_enc) {
      this.cached = null;
      throw new OtpConfigurationError(OTP_DELIVERY_ERRORS.notConfigured);
    }
    const version = String(row.version);
    if (this.cached && this.cached.version === version && this.cached.stored === row.waabek_api_key_enc) {
      return this.cached.apiKey;
    }
    this.cached = null;
    let apiKey: string;
    try {
      apiKey = decryptWaabekApiKey(this.settingsKey, row.waabek_api_key_enc);
    } catch {
      throw new OtpConfigurationError(OTP_DELIVERY_ERRORS.keyUnreadable);
    }
    this.cached = { version, stored: row.waabek_api_key_enc, apiKey };
    return apiKey;
  }

  /** Settings version of the key in memory (tests and diagnostics; never the key). */
  get cachedVersion(): string | null {
    return this.cached?.version ?? null;
  }
}
