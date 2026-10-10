import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { decryptAtRest, parseAes256Key } from '@bedo/server-crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import webpush from 'web-push';
import { DatabaseService } from '../src/database/database.service.js';
import { WebPushSender } from '../src/delivery/push.service.js';
import { type IntegrationEnv, query, setupIntegrationEnv, startApp } from './integration-env.js';
import { createUser } from './messaging-helpers.js';

const enabled = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Phase 13 (D-46), launch as a website: the Web Push keys are made by the API itself and kept, and the runtime
 * role may change only the account and session columns the API changes.
 */
describe.runIf(enabled)('Phase 13 launch readiness (real Postgres, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    app = await startApp(ctx.env);
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  it('makes one Web Push key pair on first use, keeps it encrypted, and every instance uses the same one', async () => {
    const env = { ...ctx.env, VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined, VAPID_SUBJECT: undefined };
    const database = app.get(DatabaseService);
    expect((await query(ctx.ownerUrl, 'select count(*)::int as n from app.push_keys')).rows[0]!.n).toBe(0);
    // Two server instances starting at the same moment.
    const first = new WebPushSender(env, database);
    const second = new WebPushSender(env, database);
    const [a, b] = await Promise.all([first.publicKey(), second.publicKey()]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(await new WebPushSender(env, database).publicKey()).toBe(a);

    const row = (await query<{ public_key: string; private_key_enc: string }>(ctx.ownerUrl, 'select public_key, private_key_enc from app.push_keys')).rows;
    expect(row).toHaveLength(1);
    const privateKey = decryptAtRest(parseAes256Key(ctx.env.SETTINGS_ENCRYPTION_KEY), row[0]!.private_key_enc, 'bedo vapid private key v1').toString('utf8');
    expect(row[0]!.private_key_enc).not.toContain(privateKey);
    // A valid pair: a push service would accept messages signed with it.
    const headers = webpush.getVapidHeaders('https://fcm.googleapis.com', 'https://bedochat.com', row[0]!.public_key, privateKey, 'aes128gcm');
    expect(headers.Authorization).toMatch(/^vapid t=.+, k=/);

    // The pair never changes and cannot be removed by the application.
    await expect(query(ctx.runtimeUrl, `update app.push_keys set public_key = public_key`)).rejects.toThrow(/permission denied|cannot/);
    await expect(query(ctx.runtimeUrl, 'delete from app.push_keys')).rejects.toThrow(/permission denied|cannot/);
    await expect(query(ctx.ownerUrl, `update app.push_keys set public_key = public_key`)).rejects.toThrow();
  });

  it('uses the configured VAPID variables when all three are set', async () => {
    const keys = webpush.generateVAPIDKeys();
    const sender = new WebPushSender({ ...ctx.env, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'mailto:office@academy.test' }, app.get(DatabaseService));
    expect(await sender.publicKey()).toBe(keys.publicKey);
  });

  it('lets the runtime role change only the account and session columns the API changes', async () => {
    const user = await createUser(ctx, app, 'Grant Tester');
    await expect(query(ctx.runtimeUrl, 'update app.users set id = gen_random_uuid() where id = $1', [user.id])).rejects.toThrow(/permission denied/);
    await expect(query(ctx.runtimeUrl, 'update app.users set created_at = now() where id = $1', [user.id])).rejects.toThrow(/permission denied/);
    await expect(query(ctx.runtimeUrl, 'update app.sessions set user_id = user_id where id = $1', [user.sessionId])).rejects.toThrow(/permission denied/);
    await expect(query(ctx.runtimeUrl, 'update app.sessions set platform = platform where id = $1', [user.sessionId])).rejects.toThrow(/permission denied/);
    await expect(query(ctx.runtimeUrl, 'update app.sessions set created_at = now() where id = $1', [user.sessionId])).rejects.toThrow(/permission denied/);
    // What the API does still works.
    expect((await query(ctx.runtimeUrl, `update app.users set bio = 'Hello' where id = $1`, [user.id])).rowCount).toBe(1);
    expect((await query(ctx.runtimeUrl, 'update app.sessions set last_used_at = now() where id = $1', [user.sessionId])).rowCount).toBe(1);
  });
});
