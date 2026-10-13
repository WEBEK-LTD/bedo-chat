import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import { Logger } from '@nestjs/common';

/**
 * D-58: Android app notifications through Firebase Cloud Messaging (FCM HTTP v1). The Android app shows the website
 * in its own web view, which cannot receive Web Push; it registers with Firebase and gives the page its device token,
 * which the page saves with the same request as a browser, as `https://fcm.googleapis.com/v1/bedochat-android/<token>`
 * (no table changes). Chrome's own Web Push addresses on the same host use other paths (/fcm/send/, /wp/), so the two
 * never mix. The API recognises these addresses and sends to them here.
 */

const FCM_HOST = 'fcm.googleapis.com';
const DEVICE_PATH = /^\/v1\/bedochat-android\/[A-Za-z0-9_:-]{20,4096}$/;
const DEVICE_PREFIX = '/v1/bedochat-android/';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/** Whether a saved push address belongs to the Android app (Firebase) rather than a browser (Web Push). */
export function isFcmDeviceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && url.hostname === FCM_HOST && DEVICE_PATH.test(url.pathname) && !url.search && !url.hash;
  } catch {
    return false;
  }
}

interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: KeyObject;
  tokenUri: string;
}

/**
 * Reads the Firebase service account key (the JSON file from Firebase → Project settings → Service accounts →
 * Generate new private key) however it was pasted into the variable.
 */
export function readServiceAccount(text: string): ServiceAccount {
  const json = JSON.parse(text.trim()) as Record<string, unknown>;
  const projectId = json.project_id;
  const clientEmail = json.client_email;
  const key = json.private_key;
  if (json.type !== 'service_account' || typeof projectId !== 'string' || typeof clientEmail !== 'string' || typeof key !== 'string') {
    throw new Error('not a Google service account key (expected the JSON file with type "service_account")');
  }
  const privateKey = createPrivateKey(key.replace(/\\n/g, '\n'));
  if (privateKey.asymmetricKeyType !== 'rsa') throw new Error('the service account key is not an RSA key');
  const tokenUri = typeof json.token_uri === 'string' && json.token_uri.startsWith('https://') ? json.token_uri : 'https://oauth2.googleapis.com/token';
  return { projectId, clientEmail, privateKey, tokenUri };
}

export interface FcmConfig {
  serviceAccount?: string | undefined;
  /** Tests only: the token endpoint and the FCM origin to use instead of Google's. */
  tokenUrl?: string;
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

/** A Firebase answer, shaped like a Web Push error so PushService removes tokens Firebase reports as gone. */
export class FcmError extends Error {
  constructor(
    readonly statusCode: number,
    readonly reason: string,
  ) {
    super(`FCM answered ${statusCode} ${reason}`);
  }
}

export class FcmClient {
  private readonly logger = new Logger('FcmClient');
  private readonly account: ServiceAccount | null = null;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: FcmConfig) {
    if (!config.serviceAccount) return;
    try {
      this.account = readServiceAccount(config.serviceAccount);
    } catch (error) {
      this.logger.error(`Android notifications are off: FCM_SERVICE_ACCOUNT cannot be read (${(error as Error).message}).`);
    }
  }

  get enabled(): boolean {
    return this.account !== null;
  }

  /** Sends one notification; throws FcmError (410 for a token to remove) when Firebase refuses it. */
  async send(endpoint: string, payload: string): Promise<void> {
    if (!this.account) return; // Not configured: nothing is sent and the address is kept.
    const deviceToken = decodeURIComponent(new URL(endpoint).pathname.slice(DEVICE_PREFIX.length));
    const message = fcmMessage(deviceToken, JSON.parse(payload) as Notification);
    const origin = this.config.origin ?? `https://${FCM_HOST}`;
    const response = await fetch(`${origin}/v1/projects/${encodeURIComponent(this.account.projectId)}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) return;
    const text = await response.text();
    let status = '';
    let code = '';
    let detail = '';
    try {
      const error = (JSON.parse(text) as { error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> } }).error;
      status = error?.status ?? '';
      detail = error?.message ?? '';
      code = error?.details?.find((item) => item.errorCode)?.errorCode ?? '';
    } catch {
      // not JSON
    }
    if (response.status === 401) this.token = null;
    const gone = code === 'UNREGISTERED' || status === 'NOT_FOUND' || (status === 'INVALID_ARGUMENT' && /registration token/i.test(detail));
    throw new FcmError(gone ? 410 : response.status, code || status || 'Unknown');
  }

  /** An OAuth access token for the service account (signed JWT grant), kept until five minutes before it expires. */
  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.token.expiresAt) return this.token.value;
    const account = this.account!;
    const tokenUrl = this.config.tokenUrl ?? account.tokenUri;
    const seconds = Math.floor(now / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: account.clientEmail, scope: SCOPE, aud: account.tokenUri, iat: seconds, exp: seconds + 3600 })).toString('base64url');
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), account.privateKey).toString('base64url');
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }).toString(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new FcmError(response.status, `token request refused (${response.status})`);
    const answer = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!answer.access_token) throw new FcmError(500, 'no access token');
    const lifetime = Math.max(60, (answer.expires_in ?? 3600) - 300) * 1000;
    this.token = { value: answer.access_token, expiresAt: now + lifetime };
    return this.token.value;
  }
}

/**
 * The Web Push notification as an FCM message for one device. A data message (no "notification" block): the app
 * builds the notification itself in every state (open, in the background or closed), with the chat's tag so a new
 * message in the same chat replaces the previous one, and opens the link when it is tapped.
 */
export function fcmMessage(token: string, notification: Notification): Record<string, unknown> {
  const data: Record<string, string> = {
    title: typeof notification.title === 'string' ? notification.title : 'Bedo Chat',
    body: typeof notification.body === 'string' ? notification.body : '',
    url: typeof notification.url === 'string' ? notification.url : '/',
  };
  if (typeof notification.tag === 'string' && notification.tag.length > 0) data.tag = notification.tag;
  if (typeof notification.badge === 'number') data.badge = String(notification.badge);
  return { token, data, android: { priority: 'HIGH', ttl: '3600s' } };
}
