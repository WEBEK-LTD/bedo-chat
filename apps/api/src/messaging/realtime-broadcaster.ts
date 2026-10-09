import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@bedo/config';
import { API_ENV } from '../config/tokens.js';
import { signRealtimeToken } from './realtime-token.js';

export interface BroadcastMessage {
  topic: string;
  event: string;
  payload: Record<string, unknown>;
}

/** Sends broadcast messages to Supabase Realtime channels. Replaced by a recording fake in automated tests. */
export abstract class RealtimeBroadcaster {
  /** Whether devices can listen at all (project URL, service key, public key and JWT secret configured). */
  abstract readonly enabled: boolean;
  /** The project URL and public key devices connect with (null when disabled). */
  abstract readonly client: { url: string; apiKey: string } | null;
  /** The token a device joins its private channel with (see realtime-token.ts); null when disabled. */
  abstract deviceToken(input: { userId: string; topic: string; expiresAt: Date }): string | null;
  /** Sends to private channels: only a device holding that channel's token receives. */
  abstract send(messages: BroadcastMessage[]): Promise<void>;
}

const TIMEOUT_MS = 5_000;
/** Messages per request to the broadcast endpoint. */
const BATCH = 100;

/**
 * Supabase Realtime broadcast over HTTP (D-36): POST {SUPABASE_URL}/realtime/v1/api/broadcast with the service
 * key, which never leaves the server. The API keeps no connection open, so this works from server functions.
 * Every message goes to a private channel (`private: true`): Supabase delivers it only to devices whose token the
 * realtime.messages policy allows on that channel (Realtime Authorization; public access is turned off).
 */
@Injectable()
export class SupabaseBroadcaster extends RealtimeBroadcaster {
  readonly enabled: boolean;
  readonly client: { url: string; apiKey: string } | null;
  private readonly endpoint: string | null;
  private readonly serviceKey: string | null;
  private readonly jwtSecret: string | null;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    super();
    const url = env.SUPABASE_URL?.replace(/\/$/, '') ?? null;
    this.enabled = Boolean(url && env.SUPABASE_SERVICE_ROLE_KEY && env.SUPABASE_ANON_KEY && env.SUPABASE_JWT_SECRET);
    this.jwtSecret = this.enabled ? env.SUPABASE_JWT_SECRET! : null;
    this.client = this.enabled ? { url: url!, apiKey: env.SUPABASE_ANON_KEY! } : null;
    this.endpoint = this.enabled ? `${url!}/realtime/v1/api/broadcast` : null;
    this.serviceKey = this.enabled ? env.SUPABASE_SERVICE_ROLE_KEY! : null;
  }

  deviceToken(input: { userId: string; topic: string; expiresAt: Date }): string | null {
    return this.jwtSecret ? signRealtimeToken(this.jwtSecret, input) : null;
  }

  async send(messages: BroadcastMessage[]): Promise<void> {
    if (!this.endpoint || !this.serviceKey || messages.length === 0) {
      return;
    }
    for (let start = 0; start < messages.length; start += BATCH) {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { apikey: this.serviceKey, authorization: `Bearer ${this.serviceKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ messages: messages.slice(start, start + BATCH).map((message) => ({ ...message, private: true })) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await response.arrayBuffer().catch(() => undefined);
      if (!response.ok) {
        throw new Error(`Realtime broadcast failed: HTTP ${response.status}`);
      }
    }
  }
}
