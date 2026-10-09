import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { OTP_DELIVERY_ERRORS } from '@bedo/contracts';
import { decryptWaabekApiKey, parseAes256Key } from '@bedo/server-crypto';
import { API_ENV } from '../config/tokens.js';
import { DatabaseService } from '../database/database.service.js';

/**
 * The Waabek settings cannot be used (no key stored, or it cannot be decrypted). Retrying cannot help. The
 * message is one of OTP_DELIVERY_ERRORS: it never contains the key or the stored value.
 */
export class OtpConfigurationError extends Error {
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
 * The key lives only in Postgres (app.otp_settings, encrypted with SETTINGS_ENCRYPTION_KEY). Before EVERY
 * message this reads the settings row's `version` and stored value (one single-row query by primary key) and
 * decrypts only when they changed since the last message; the decrypted key is kept in this instance's
 * memory only. So a change made in the Admin Dashboard applies to the next message on every server
 * instance, without a restart; a cached key is never used without first confirming it is still the current
 * one; and nothing about the key is ever logged. It fails closed: no key, an unreadable key, or an
 * unreachable database means the message is not sent.
 */
@Injectable()
export class WaabekKeyProvider {
  private readonly settingsKey: Buffer;
  private cached: CachedKey | null = null;

  constructor(
    @Inject(API_ENV) env: Pick<ApiEnv, 'SETTINGS_ENCRYPTION_KEY'>,
    @Inject(DatabaseService) private readonly database: Pick<DatabaseService, 'db'>,
  ) {
    this.settingsKey = parseAes256Key(env.SETTINGS_ENCRYPTION_KEY);
  }

  async currentKey(): Promise<string> {
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
