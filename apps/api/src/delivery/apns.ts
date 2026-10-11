import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import http2 from 'node:http2';
import { Logger } from '@nestjs/common';

/**
 * D-53: iPhone app notifications through Apple Push Notifications (APNs). The app saves its device address with the
 * same request as a browser: `https://api.push.apple.com/3/device/<token>` (or `api.sandbox.push.apple.com` for a
 * development build), so no table changes; the API recognises these addresses and sends to them here.
 */

const APNS_HOSTS = new Set(['api.push.apple.com', 'api.sandbox.push.apple.com']);
const DEVICE_PATH = /^\/3\/device\/[0-9a-f]{64,200}$/;

/** Whether a saved push address belongs to the iPhone app (APNs) rather than a browser (Web Push). */
export function isApnsDeviceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && APNS_HOSTS.has(url.hostname) && DEVICE_PATH.test(url.pathname) && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export interface ApnsConfig {
  key?: string | undefined;
  keyId?: string | undefined;
  teamId?: string | undefined;
  bundleId: string;
  /** Tests only: send to this origin (plain HTTP/2) instead of the address's own host. */
  origin?: string;
}

/** The notification the API sends to every device (the same fields as the Web Push payload). */
interface Notification {
  title?: unknown;
  body?: unknown;
  tag?: unknown;
  url?: unknown;
  badge?: unknown;
}

/** An APNs answer, shaped like a Web Push error so PushService removes addresses Apple reports as gone. */
export class ApnsError extends Error {
  constructor(
    readonly statusCode: number,
    readonly reason: string,
  ) {
    super(`APNs answered ${statusCode} ${reason}`);
  }
}

/** Reads the .p8 key however it was pasted: with or without its BEGIN/END lines, line breaks or "\n" escapes. */
export function readApnsKey(text: string): KeyObject {
  const body = text
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  const lines = body.match(/.{1,64}/g) ?? [];
  const key = createPrivateKey(`-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`);
  if (key.asymmetricKeyType !== 'ec') throw new Error('not an Apple push key (expected an EC P-256 .p8 key)');
  return key;
}

const TOKEN_LIFETIME_MS = 45 * 60_000; // Apple accepts a token for an hour and refuses one renewed too often.
const REMOVE_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

export class ApnsClient {
  private readonly logger = new Logger('ApnsClient');
  private readonly key: KeyObject | null;
  private token: { value: string; madeAt: number } | null = null;
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();

  constructor(private readonly config: ApnsConfig) {
    this.key = null;
    const parts = [config.key, config.keyId, config.teamId].filter(Boolean).length;
    if (parts === 0) return;
    if (parts !== 3) {
      this.logger.error('iPhone notifications are off: APNS_KEY, APNS_KEY_ID and APNS_TEAM_ID must be set together.');
      return;
    }
    if (!/^[A-Z0-9]{10}$/.test(config.keyId!) || !/^[A-Z0-9]{10}$/.test(config.teamId!)) {
      this.logger.error('iPhone notifications are off: APNS_KEY_ID and APNS_TEAM_ID must be the 10-character IDs from Apple.');
      return;
    }
    try {
      this.key = readApnsKey(config.key!);
    } catch (error) {
      this.logger.error(`iPhone notifications are off: APNS_KEY cannot be read (${(error as Error).message}).`);
    }
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  /** Sends one notification; throws ApnsError (404/410 for an address to remove) when Apple refuses it. */
  async send(endpoint: string, payload: string): Promise<void> {
    if (!this.key) return; // Not configured: nothing is sent and the address is kept.
    const url = new URL(endpoint);
    const notification = JSON.parse(payload) as Notification;
    const body = JSON.stringify(apnsPayload(notification));
    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': url.pathname,
      authorization: `bearer ${this.bearer()}`,
      'apns-topic': this.config.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 60 * 60),
      'content-type': 'application/json',
    };
    // A new message in the same chat replaces the previous notification, as on the website (Apple allows 64 bytes).
    if (typeof notification.tag === 'string' && notification.tag.length > 0 && Buffer.byteLength(notification.tag) <= 64) {
      headers['apns-collapse-id'] = notification.tag;
    }
    const origin = this.config.origin ?? `https://${url.hostname}`;
    const { status, text } = await this.request(origin, headers, body);
    if (status === 200) return;
    let reason = 'Unknown';
    try {
      reason = (JSON.parse(text) as { reason?: string }).reason ?? reason;
    } catch {
      // not JSON
    }
    if (reason === 'ExpiredProviderToken') this.token = null;
    throw new ApnsError(status === 410 || REMOVE_REASONS.has(reason) ? 410 : status, reason);
  }

  private bearer(): string {
    const now = Date.now();
    if (this.token && now - this.token.madeAt < TOKEN_LIFETIME_MS) return this.token.value;
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: this.config.keyId })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: this.config.teamId, iat: Math.floor(now / 1000) })).toString('base64url');
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: this.key!, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    this.token = { value: `${header}.${claims}.${signature}`, madeAt: now };
    return this.token.value;
  }

  private session(origin: string): http2.ClientHttp2Session {
    const open = this.sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const session = http2.connect(origin);
    session.on('error', () => this.sessions.delete(origin));
    session.on('close', () => this.sessions.delete(origin));
    // A server function may be frozen between requests: an idle connection is closed rather than kept.
    session.setTimeout(30_000, () => session.close());
    session.unref();
    this.sessions.set(origin, session);
    return session;
  }

  private request(origin: string, headers: http2.OutgoingHttpHeaders, body: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const stream = this.session(origin).request(headers);
      let status = 0;
      let text = '';
      stream.setEncoding('utf8');
      stream.setTimeout(5_000, () => stream.close(http2.constants.NGHTTP2_CANCEL));
      stream.on('response', (response) => {
        status = Number(response[':status']);
      });
      stream.on('data', (chunk: string) => {
        text += chunk;
      });
      stream.on('end', () => resolve({ status, text }));
      stream.on('close', () => {
        if (status === 0) reject(new Error('APNs request ended without an answer'));
      });
      stream.on('error', reject);
      stream.end(body);
    });
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

/** The Web Push notification as an APNs payload: title and text, sound, badge, grouping by chat, and the link. */
export function apnsPayload(notification: Notification): Record<string, unknown> {
  const aps: Record<string, unknown> = {
    alert: {
      title: typeof notification.title === 'string' ? notification.title : 'Bedo Chat',
      body: typeof notification.body === 'string' ? notification.body : '',
    },
    sound: 'default',
  };
  if (typeof notification.badge === 'number') aps.badge = notification.badge;
  if (typeof notification.tag === 'string') aps['thread-id'] = notification.tag;
  return { aps, url: typeof notification.url === 'string' ? notification.url : '/' };
}
