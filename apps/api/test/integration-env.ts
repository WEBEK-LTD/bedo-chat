import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { type ApiEnv, apiEnvSchema, loadEnv } from '@bedo/config';
import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@bedo/contracts';
import { defaultMigrationsDir, runMigrations } from '@bedo/db';
import { encryptWaabekApiKey } from '@bedo/server-crypto';
import pg from 'pg';
import { AppModule } from '../src/app.module.js';
import { buildFastifyAdapter, configureApp } from '../src/app.js';
import { PushSender, type PushTarget } from '../src/delivery/push.service.js';
import { WaabekSender } from '../src/delivery/waabek.client.js';
import { type BroadcastMessage, RealtimeBroadcaster } from '../src/messaging/realtime-broadcaster.js';
import { signRealtimeToken } from '../src/messaging/realtime-token.js';
import { DeferredTasks } from '../src/runtime/deferred-tasks.service.js';
import { GifProvider, GifProviderError, type GifItem } from '../src/media/gif-provider.js';
import { type MediaBucket, MediaStorage, type ObjectHead } from '../src/storage/media-storage.js';
import { ProfilePhotoStorage } from '../src/storage/profile-photo-storage.js';

/**
 * D-36: one origin for everything. app.inject() sends "host: localhost:80", so a browser page on the site has
 * this origin.
 */
export const SITE_ORIGIN = 'http://localhost';
/** Kept as names for readability: the web app and the Admin Dashboard are the same site. */
export const WEB_ORIGIN = SITE_ORIGIN;
export const ADMIN_ORIGIN = SITE_ORIGIN;
export const TOTP_KEY = Buffer.alloc(32, 5);
/** SETTINGS_ENCRYPTION_KEY for tests (D-32): random per run, never a real key. */
export const SETTINGS_KEY = randomBytes(32);
/** The Waabek key tests store in the settings (fake: a real key never appears in tests). */
export const TEST_WAABEK_KEY = 'fake-waabek-key-integration-tests-0001';

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(url: string, sql: string, params: unknown[] = []) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query<T>(sql, params);
  } finally {
    await client.end();
  }
}

/** Waits for the work every started app runs after its responses (code delivery, push, realtime signals). */
class Background {
  readonly apps = new Set<DeferredTasks>();

  async settle(): Promise<void> {
    await Promise.all([...this.apps].map((tasks) => tasks.drain()));
  }
}

/**
 * Stands in for Waabek's HTTP API (the real client is tested in waabek.test.ts): records every WhatsApp message
 * with the key it was sent with, or fails like Waabek would when told to.
 */
export class FakeWaabek extends WaabekSender {
  readonly messages: Array<{ apiKey: string; phone: string; text: string }> = [];
  failWith: Error | null = null;

  constructor(readonly background: Background) {
    super();
  }

  async send(apiKey: string, phone: string, text: string): Promise<void> {
    if (this.failWith) {
      throw this.failWith;
    }
    this.messages.push({ apiKey, phone, text });
  }

  /** Every message sent to this number so far (after waiting for deliveries in progress). */
  async to(phone: string): Promise<string[]> {
    await this.background.settle();
    return this.messages.filter((message) => message.phone === phone).map((message) => message.text);
  }
}

/** Records Web Push deliveries instead of contacting browser push services. */
export class FakePush extends PushSender {
  readonly enabled = true;
  readonly sent: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
  /** Push service answers to simulate, by endpoint (e.g. 410 for an expired subscription). */
  readonly statusFor = new Map<string, number>();

  constructor(readonly background: Background) {
    super();
  }

  async publicKey(): Promise<string> {
    return 'BPublicKeyForTests';
  }

  async send(target: PushTarget, payload: string): Promise<void> {
    const status = this.statusFor.get(target.endpoint);
    if (status) {
      throw Object.assign(new Error(`push failed ${status}`), { statusCode: status });
    }
    this.sent.push({ endpoint: target.endpoint, payload: JSON.parse(payload) as Record<string, unknown> });
  }

  async all(): Promise<Array<{ endpoint: string; payload: Record<string, unknown> }>> {
    await this.background.settle();
    return this.sent;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/** The JWT secret the fake signs device tokens with (Supabase's project JWT secret in production). */
export const TEST_REALTIME_JWT_SECRET = 'test-realtime-jwt-secret-0123456789abcdef';

/** Records realtime signals instead of sending them to Supabase Realtime. */
export class FakeRealtime extends RealtimeBroadcaster {
  readonly enabled = true;
  readonly client = { url: 'https://realtime.bedo.test', apiKey: 'public-anon-key-for-tests' };
  readonly sent: BroadcastMessage[] = [];

  constructor(readonly background: Background) {
    super();
  }

  deviceToken(input: { userId: string; topic: string; expiresAt: Date }): string {
    return signRealtimeToken(TEST_REALTIME_JWT_SECRET, input);
  }

  async send(messages: BroadcastMessage[]): Promise<void> {
    this.sent.push(...messages);
  }

  /** Signals sent to one channel so far. */
  async on(topic: string): Promise<Array<Record<string, unknown>>> {
    await this.background.settle();
    return this.sent.filter((message) => message.topic === topic).map((message) => message.payload);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/**
 * Supabase Storage for chat files and stickers, in memory: signed upload URLs that refuse to overwrite (as
 * Supabase's do), signed download URLs that record their expiry and download name, public sticker URLs.
 */
export class FakeMediaStorage extends MediaStorage {
  readonly enabled = true;
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  readonly signed: Array<{ bucket: string; path: string; expiresInSeconds: number; download: string | true | undefined; url: string }> = [];
  readonly removed: string[] = [];
  private readonly uploads = new Map<string, { key: string }>();

  private key(bucket: MediaBucket, path: string): string {
    return `${bucket}/${path}`;
  }

  async createUpload(bucket: MediaBucket, path: string, contentType: string) {
    const token = randomBytes(12).toString('hex');
    const url = `https://storage.bedo.test/upload/${bucket}/${path}?token=${token}`;
    this.uploads.set(url, { key: this.key(bucket, path) });
    return { url, headers: { 'content-type': contentType, 'x-upsert': 'false' } };
  }

  /** What a browser does with an upload URL: PUT the bytes. False when the object already exists. */
  upload(url: string, body: Buffer, contentType = 'application/octet-stream'): boolean {
    const target = this.uploads.get(url);
    if (!target) throw new Error(`unknown upload URL ${url}`);
    if (this.objects.has(target.key)) return false;
    this.objects.set(target.key, { body, contentType });
    return true;
  }

  async head(bucket: MediaBucket, path: string, bytes: number): Promise<ObjectHead | null> {
    const object = this.objects.get(this.key(bucket, path));
    return object ? { size: object.body.length, head: object.body.subarray(0, bytes) } : null;
  }

  async put(bucket: MediaBucket, path: string, body: Buffer, contentType: string): Promise<void> {
    const key = this.key(bucket, path);
    if (this.objects.has(key)) throw new Error('exists');
    this.objects.set(key, { body, contentType });
  }

  async remove(bucket: MediaBucket, paths: string[]): Promise<void> {
    for (const path of paths) {
      this.objects.delete(this.key(bucket, path));
      this.removed.push(this.key(bucket, path));
    }
  }

  async signedUrls(bucket: MediaBucket, paths: string[], expiresInSeconds: number, download?: string | true): Promise<string[]> {
    return paths.map((path) => {
      const url = `https://storage.bedo.test/sign/${bucket}/${path}?token=${randomBytes(8).toString('hex')}${download === undefined ? '' : `&download=${download === true ? '' : encodeURIComponent(download)}`}`;
      this.signed.push({ bucket, path, expiresInSeconds, download, url });
      return url;
    });
  }

  publicUrl(bucket: MediaBucket, path: string): string {
    return `https://storage.bedo.test/public/${bucket}/${path}`;
  }

  /** The stored object behind a signed download URL (what the browser would receive). */
  objectFor(url: string): Buffer | null {
    const entry = this.signed.find((item) => item.url === url);
    return entry ? (this.objects.get(`${entry.bucket}/${entry.path}`)?.body ?? null) : null;
  }
}

/** GIPHY's API, recorded: a fixed catalogue of GIFs whose media live at fake GIPHY addresses. */
export class FakeGifProvider extends GifProvider {
  readonly catalogue = new Map<string, GifItem & { mp4: Buffer; preview: Buffer }>();
  readonly calls: Array<{ apiKey: string; kind: 'search' | 'get' | 'download'; value: string }> = [];

  add(id: string, mp4: Buffer, preview: Buffer): void {
    this.catalogue.set(id, {
      id,
      title: `GIF ${id}`,
      width: 200,
      height: 150,
      mp4Url: `https://media.giphy.com/media/${id}/200.mp4`,
      previewUrl: `https://media.giphy.com/media/${id}/100.webp`,
      stillUrl: `https://media.giphy.com/media/${id}/200_s.gif`,
      mp4,
      preview,
    });
  }

  isMediaUrl(url: string): boolean {
    return url.startsWith('https://media.giphy.com/');
  }

  /** Keys GIPHY answers 401 for (not accepted), and a key whose check finds GIPHY unreachable. */
  static readonly REJECTED_KEY = ['Rejected', 'Giphy', 'Key1'].join('');
  static readonly UNREACHABLE_KEY = ['Unreachable', 'Giphy', 'Key1'].join('');

  async search(apiKey: string, query: string | null, offset: number, limit: number) {
    this.calls.push({ apiKey, kind: 'search', value: query ?? '' });
    if (apiKey === FakeGifProvider.REJECTED_KEY) throw new GifProviderError('GIPHY answered 401', 401);
    if (apiKey === FakeGifProvider.UNREACHABLE_KEY) throw new GifProviderError('GIPHY could not be reached');
    const items = [...this.catalogue.values()].filter((item) => !query || item.title.toLowerCase().includes(query.toLowerCase()));
    return { items: items.slice(offset, offset + limit), total: items.length };
  }

  async get(apiKey: string, id: string) {
    this.calls.push({ apiKey, kind: 'get', value: id });
    return this.catalogue.get(id) ?? null;
  }

  async download(url: string, maxBytes: number) {
    this.calls.push({ apiKey: '', kind: 'download', value: url });
    for (const item of this.catalogue.values()) {
      const body = url === item.mp4Url ? item.mp4 : url === item.previewUrl ? item.preview : null;
      if (body) {
        if (body.length > maxBytes) throw new Error('too large');
        return { body, contentType: url.endsWith('.mp4') ? 'video/mp4' : 'image/webp' };
      }
    }
    throw new Error('not found');
  }
}

/**
 * A fresh, migrated database plus a least-privilege login (member of bedo_runtime) for the API. Waabek, Web Push
 * and Supabase Realtime are replaced by recording fakes inside the app. Everything is removed by `teardown`.
 */
export interface IntegrationEnv {
  ownerUrl: string;
  runtimeUrl: string;
  env: ApiEnv;
  waabek: FakeWaabek;
  push: FakePush;
  realtime: FakeRealtime;
  /** Waits until every started app has finished its work after responses. */
  settle(): Promise<void>;
  teardown(): Promise<void>;
}

const fakesByEnv = new WeakMap<ApiEnv, { waabek: FakeWaabek; push: FakePush; realtime: FakeRealtime; background: Background }>();

export async function setupIntegrationEnv(
  overrides: Record<string, string> = {},
  options: { waabekKey?: boolean; signupMode?: 'open' | 'academy_list' } = {},
): Promise<IntegrationEnv> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    throw new Error('TEST_DATABASE_URL is required for integration tests');
  }
  const suffix = randomBytes(5).toString('hex');
  const dbName = `bedo_api_test_${suffix}`;
  const login = `bedo_api_test_${suffix}`;
  const password = randomBytes(12).toString('hex');
  await query(adminUrl, `create database ${dbName}`);
  const ownerUrl = Object.assign(new URL(adminUrl), { pathname: `/${dbName}` }).toString();
  await runMigrations({ connectionString: ownerUrl, migrationsDir: defaultMigrationsDir() });
  await query(adminUrl, `create role ${login} login password '${password}' in role bedo_runtime`);
  const runtime = new URL(ownerUrl);
  runtime.username = login;
  runtime.password = password;
  // D-47: production starts open; most suites test the academy list (D-06), so it is their default here.
  await query(ownerUrl, 'update app.access_settings set signup_mode = $1', [options.signupMode ?? 'academy_list']);
  if (options.waabekKey !== false) {
    // As if a Super Admin had saved it in the Admin Dashboard (D-32): one-time codes can be delivered.
    await query(ownerUrl, 'update app.otp_settings set waabek_api_key_enc = $1', [encryptWaabekApiKey(SETTINGS_KEY, TEST_WAABEK_KEY)]);
  }

  const env = loadEnv(apiEnvSchema, {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: runtime.toString(),
    ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64'),
    OTP_HMAC_SECRET: randomBytes(32).toString('base64'),
    ADMIN_TOTP_KEY: TOTP_KEY.toString('base64'),
    SETTINGS_ENCRYPTION_KEY: SETTINGS_KEY.toString('base64'),
    VAPID_PUBLIC_KEY: 'BPublicKeyForTests',
    VAPID_PRIVATE_KEY: 'private-key-for-tests',
    VAPID_SUBJECT: 'mailto:tests@bedo.test',
    ...overrides,
  });
  const background = new Background();
  const fakes = { waabek: new FakeWaabek(background), push: new FakePush(background), realtime: new FakeRealtime(background), background };
  fakesByEnv.set(env, fakes);

  return {
    ownerUrl,
    runtimeUrl: runtime.toString(),
    env,
    waabek: fakes.waabek,
    push: fakes.push,
    realtime: fakes.realtime,
    settle: () => background.settle(),
    async teardown() {
      await background.settle();
      await query(adminUrl, `drop database if exists ${dbName} with (force)`);
      await query(adminUrl, `drop role if exists ${login}`);
    },
  };
}

/**
 * The real application (all modules), with the env's fakes for Waabek, Web Push and Realtime, and optionally a
 * fake profile-photo storage.
 */
export async function startApp(
  env: ApiEnv,
  storage?: ProfilePhotoStorage,
  media: { storage?: MediaStorage; gifs?: GifProvider } = {},
): Promise<NestFastifyApplication> {
  const fakes = fakesByEnv.get(env);
  let builder = Test.createTestingModule({ imports: [AppModule.forRoot(env)] });
  if (fakes) {
    builder = builder
      .overrideProvider(WaabekSender)
      .useValue(fakes.waabek)
      .overrideProvider(PushSender)
      .useValue(fakes.push)
      .overrideProvider(RealtimeBroadcaster)
      .useValue(fakes.realtime);
  }
  if (storage) {
    builder = builder.overrideProvider(ProfilePhotoStorage).useValue(storage);
  }
  if (media.storage) {
    builder = builder.overrideProvider(MediaStorage).useValue(media.storage);
  }
  if (media.gifs) {
    builder = builder.overrideProvider(GifProvider).useValue(media.gifs);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(buildFastifyAdapter(env), { logger: process.env.TEST_LOG ? ['error', 'warn'] : false });
  await configureApp(app, env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  fakes?.background.apps.add(app.get(DeferredTasks));
  return app;
}

/** Headers a browser page on the site sends with cookie-authenticated requests. */
export const webCsrf = { origin: WEB_ORIGIN, [CSRF_HEADER]: CSRF_HEADER_VALUE };
export const adminCsrf = { origin: ADMIN_ORIGIN, [CSRF_HEADER]: CSRF_HEADER_VALUE };

/** The newest code sent through Waabek to this number (what the person receives on WhatsApp), or null. */
export async function latestCode(waabek: FakeWaabek, phone: string): Promise<string | null> {
  const texts = await waabek.to(phone);
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const code = /verification code is: (\d{6})$/.exec(texts[index]!)?.[1];
    if (code) {
      return code;
    }
  }
  return null;
}

/** How many codes were sent through Waabek to this number. */
export async function jobCount(waabek: FakeWaabek, phone: string): Promise<number> {
  return (await waabek.to(phone)).filter((text) => /verification code is: \d{6}$/.test(text)).length;
}

/** Extracts a cookie value from a Set-Cookie response header. */
export function cookieValue(setCookie: string | string[] | undefined, name: string): string | null {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const header of headers) {
    const [pair] = header.split(';');
    const [key, ...rest] = (pair ?? '').split('=');
    if (key?.trim() === name) {
      return rest.join('=');
    }
  }
  return null;
}

/** Clears the resend cooldown so a test can request several codes for one number without waiting 60s. */
export async function clearCooldown(ctx: Pick<IntegrationEnv, 'ownerUrl'>, phone: string, scope = 'otp'): Promise<void> {
  await query(ctx.ownerUrl, 'delete from app.ephemeral where key = $1', [`rl:${scope}:cooldown:${phone}`]);
}

/** Forgets rate-limit counters and short-lived state by key (D-36: in Postgres). */
export async function clearState(ctx: Pick<IntegrationEnv, 'ownerUrl'>, ...keys: string[]): Promise<void> {
  await query(ctx.ownerUrl, 'delete from app.rate_counters where key = any($1)', [keys]);
  await query(ctx.ownerUrl, 'delete from app.ephemeral where key = any($1)', [keys]);
}

/** Everything short-lived the API holds (pending sign-ins, setup secrets, counters, presence), as text. */
export async function allShortLivedState(ctx: Pick<IntegrationEnv, 'ownerUrl'>): Promise<string> {
  const tables = ['app.ephemeral', 'app.rate_counters', 'app.rate_events', 'app.presence_devices', 'app.maintenance_runs'];
  const rows = await Promise.all(tables.map(async (table) => (await query(ctx.ownerUrl, `select * from ${table}`)).rows));
  return JSON.stringify(rows);
}

let adminIpCounter = 0;
/** A fresh client address per admin password request, so tests do not share the per-IP limit unless they mean to. */
export const nextAdminIp = () => `10.77.${Math.floor(++adminIpCounter / 250)}.${(adminIpCounter % 250) + 1}`;

/** The password test admins get (D-34): long enough, not a phone number, not on the common-password list. */
export const ADMIN_TEST_PASSWORD = ['tidal', 'quartz', 'lantern', '0471'].join('-');

/** What the owner runs in the SQL editor (D-34): a one-time password setup token for that admin. */
export async function issuePasswordSetup(ownerUrl: string, phone: string): Promise<string> {
  const result = await query<{ setup_token: string }>(ownerUrl, 'select setup_token from app.issue_admin_password_setup($1)', [phone]);
  return result.rows[0]!.setup_token;
}

/** Sets an admin's password the supported way: owner setup token, then the Set Password endpoint. */
export async function setAdminPassword(app: NestFastifyApplication, ownerUrl: string, phone: string, password = ADMIN_TEST_PASSWORD): Promise<void> {
  const setupToken = await issuePasswordSetup(ownerUrl, phone);
  const response = await app.inject({
    method: 'POST',
    url: '/v1/admin/auth/password/setup',
    headers: adminCsrf,
    payload: { phone, setupToken, password },
    remoteAddress: nextAdminIp(),
  });
  if (response.statusCode !== 200) {
    throw new Error(`Setting the admin password failed: ${response.statusCode} ${response.body}`);
  }
}

/** Admin sign-in step 1 (D-34): phone + password. Returns the response (pendingToken on success). */
export function adminPasswordLogin(app: NestFastifyApplication, phone: string, password = ADMIN_TEST_PASSWORD, remoteAddress = nextAdminIp()) {
  return app.inject({ method: 'POST', url: '/v1/admin/auth/password/login', headers: adminCsrf, payload: { phone, password }, remoteAddress });
}
