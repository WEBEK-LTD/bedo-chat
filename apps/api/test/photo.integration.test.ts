import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProfilePhotoStorage, type StoredObject } from '../src/storage/profile-photo-storage.js';
import { clearCooldown, type IntegrationEnv, latestCode, query, setupIntegrationEnv, startApp } from './integration-env.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.REDIS_URL);

/** In-memory stand-in for the private Supabase bucket: the browser "uploads" by writing into `objects`. */
class FakeStorage extends ProfilePhotoStorage {
  readonly enabled = true;
  readonly objects = new Map<string, Buffer>();
  readonly removed: string[] = [];
  async createUpload(key: string, contentType: string) {
    return { url: `https://storage.test/upload/${key}?token=one-time`, headers: { 'content-type': contentType } };
  }
  async read(key: string): Promise<StoredObject | null> {
    const bytes = this.objects.get(key);
    return bytes ? { size: bytes.length, head: bytes.subarray(0, 16) } : null;
  }
  async remove(key: string) {
    this.removed.push(key);
    this.objects.delete(key);
  }
  async signedUrl(key: string, expiresInSeconds: number) {
    return `https://storage.test/sign/${key}?expires=${expiresInSeconds}`;
  }
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);

describe.runIf(enabled)('profile picture (P-07, P-15)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  const storage = new FakeStorage();
  let tokenA: string;
  let tokenB: string;
  let userA: string;

  async function signIn(phone: string, ip: string) {
    await query(ctx.ownerUrl, "insert into app.academy_phone_list (phone, added_by) values ($1, gen_random_uuid())", [phone]);
    await clearCooldown(ctx.redis, ctx.prefix, phone);
    await app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { phone }, remoteAddress: ip });
    const verified = await app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { phone, code: await latestCode(ctx.otpQueue, phone) },
      remoteAddress: ip,
    });
    return verified.json() as { accessToken: string; user: { id: string } };
  }

  const call = (token: string, method: 'POST' | 'DELETE' | 'GET', url: string, payload?: object) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    app = await startApp(ctx.env, storage);
    const a = await signIn('+201200000001', '10.70.0.1');
    const b = await signIn('+201200000002', '10.70.0.2');
    tokenA = a.accessToken;
    tokenB = b.accessToken;
    userA = a.user.id;
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  it('accepts a real image after upload, records the change and returns a short-lived signed URL', async () => {
    const start = await call(tokenA, 'POST', '/v1/me/photo/upload', { contentType: 'image/png', size: PNG.length });
    expect(start.statusCode, start.body).toBe(200);
    const { uploadId, uploadUrl, method } = start.json();
    expect(method).toBe('PUT');
    const key = decodeURIComponent(new URL(uploadUrl).pathname.replace('/upload/', ''));
    expect(key.startsWith(`${userA}/`)).toBe(true);
    storage.objects.set(key, PNG);

    const confirmed = await call(tokenA, 'POST', '/v1/me/photo/confirm', { uploadId });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const photoUrl = new URL(confirmed.json().photoUrl);
    expect(photoUrl.pathname).toBe(`/sign/${key}`);
    expect(Number(photoUrl.searchParams.get('expires'))).toBeGreaterThan(0);

    const history = await query(ctx.ownerUrl, "select old_value, new_value from audit.identity_history where user_id = $1 and field = 'photo'", [userA]);
    expect(history.rows).toEqual([{ old_value: null, new_value: key }]);

    // The upload ID is single-use.
    expect((await call(tokenA, 'POST', '/v1/me/photo/confirm', { uploadId })).statusCode).toBe(404);
  });

  it('rejects files that are not images regardless of the declared type, and deletes them', async () => {
    const start = (await call(tokenA, 'POST', '/v1/me/photo/upload', { contentType: 'image/jpeg', size: 20 })).json();
    const key = decodeURIComponent(new URL(start.uploadUrl).pathname.replace('/upload/', ''));
    storage.objects.set(key, Buffer.from('<html><script>alert(1)</script></html>'));
    const confirmed = await call(tokenA, 'POST', '/v1/me/photo/confirm', { uploadId: start.uploadId });
    expect(confirmed.statusCode).toBe(400);
    expect(storage.removed).toContain(key);
  });

  it('rejects oversized files and confirmations without an upload', async () => {
    expect((await call(tokenA, 'POST', '/v1/me/photo/upload', { contentType: 'image/png', size: 6 * 1024 * 1024 })).statusCode).toBe(400);
    const start = (await call(tokenA, 'POST', '/v1/me/photo/upload', { contentType: 'image/png', size: 100 })).json();
    expect((await call(tokenA, 'POST', '/v1/me/photo/confirm', { uploadId: start.uploadId })).statusCode).toBe(400);

    const big = (await call(tokenA, 'POST', '/v1/me/photo/upload', { contentType: 'image/png', size: 100 })).json();
    const key = decodeURIComponent(new URL(big.uploadUrl).pathname.replace('/upload/', ''));
    storage.objects.set(key, Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]));
    expect((await call(tokenA, 'POST', '/v1/me/photo/confirm', { uploadId: big.uploadId })).statusCode).toBe(400);
  });

  it('does not let another user confirm someone else\'s upload', async () => {
    const start = (await call(tokenA, 'POST', '/v1/me/photo/upload', { contentType: 'image/png', size: PNG.length })).json();
    const key = decodeURIComponent(new URL(start.uploadUrl).pathname.replace('/upload/', ''));
    storage.objects.set(key, PNG);
    expect((await call(tokenB, 'POST', '/v1/me/photo/confirm', { uploadId: start.uploadId })).statusCode).toBe(404);
  });

  it('removes the picture from the profile but keeps it in identity history', async () => {
    const removed = await call(tokenA, 'DELETE', '/v1/me/photo');
    expect(removed.json().photoUrl).toBeNull();
    const history = await query<{ new_value: string | null }>(
      ctx.ownerUrl,
      "select new_value from audit.identity_history where user_id = $1 and field = 'photo' order by id",
      [userA],
    );
    expect(history.rows.at(-1)?.new_value).toBeNull();
    expect(history.rows[0]?.new_value).not.toBeNull();
  });
});
