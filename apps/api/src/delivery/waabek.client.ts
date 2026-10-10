import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { OTP_DELIVERY_ERRORS } from '@bedo/contracts';
import { API_ENV } from '../config/tokens.js';

/** Failure talking to Waabek. Carries the HTTP status only: never the key, the number or the message. */
export class WaabekError extends Error {
  constructor(
    readonly status: number | null,
    reason: string,
    /** Worth one more try (network error, timeout, 429 or 5xx). */
    readonly retryable: boolean,
  ) {
    super(`${OTP_DELIVERY_ERRORS.waabekPrefix}: ${reason}`);
    this.name = 'WaabekError';
  }
}

/** Sends one WhatsApp message. Replaced by a recording fake in automated tests. */
export abstract class WaabekSender {
  abstract send(apiKey: string, phoneE164: string, message: string, timeoutMs: number): Promise<void>;
}

/**
 * Waabek.com WhatsApp API client (spec §1, D-05). Server-side only: the caller passes the key (the
 * Admin Dashboard-managed setting, D-32, see WaabekKeyProvider); it is sent in the X-API-Key header and
 * never logged or included in errors.
 */
@Injectable()
export class WaabekClient extends WaabekSender {
  constructor(@Inject(API_ENV) private readonly env: Pick<ApiEnv, 'WAABEK_API_URL'>) {
    super();
  }

  async send(apiKey: string, phoneE164: string, message: string, timeoutMs: number): Promise<void> {
    if (!apiKey) {
      throw new WaabekError(null, 'no API key', false);
    }
    let response: Response;
    try {
      response = await fetch(this.env.WAABEK_API_URL, {
        method: 'POST',
        headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
        // Waabek expects the number without the leading "+", e.g. "201234567890".
        body: JSON.stringify({ to: phoneE164.replace(/^\+/, ''), message }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new WaabekError(null, timedOut ? 'timed out' : 'network error', true);
    }
    // Drain without reading the body into logs or errors.
    await response.arrayBuffer().catch(() => undefined);
    if (!response.ok) {
      throw new WaabekError(response.status, `HTTP ${response.status}`, response.status === 429 || response.status >= 500);
    }
  }
}
