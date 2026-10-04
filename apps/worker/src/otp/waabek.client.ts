import { Inject, Injectable } from '@nestjs/common';
import type { WorkerEnv } from '@bedo/config';
import { WORKER_ENV } from '../tokens.js';

/** Failure talking to Waabek. Carries the HTTP status only: never the key, the number or the message. */
export class WaabekError extends Error {
  constructor(readonly status: number | null, reason: string) {
    super(`Waabek send failed: ${reason}`);
    this.name = 'WaabekError';
  }
}

const TIMEOUT_MS = 10_000;

/**
 * Waabek.com WhatsApp API client (spec §1, D-05). Server-side only: the key comes from WAABEK_API_KEY
 * and is sent in the X-API-Key header, never logged or included in errors.
 */
@Injectable()
export class WaabekClient {
  constructor(@Inject(WORKER_ENV) private readonly env: WorkerEnv) {}

  async send(phoneE164: string, message: string): Promise<void> {
    const key = this.env.WAABEK_API_KEY;
    if (!key) {
      throw new WaabekError(null, 'WAABEK_API_KEY is not configured');
    }
    let response: Response;
    try {
      response = await fetch(this.env.WAABEK_API_URL, {
        method: 'POST',
        headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
        // Waabek expects the number without the leading "+", e.g. "201234567890".
        body: JSON.stringify({ to: phoneE164.replace(/^\+/, ''), message }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'network error';
      throw new WaabekError(null, reason);
    }
    if (!response.ok) {
      // Drain without reading the body into logs or errors.
      await response.arrayBuffer().catch(() => undefined);
      throw new WaabekError(response.status, `HTTP ${response.status}`);
    }
    await response.arrayBuffer().catch(() => undefined);
  }
}
