import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dispatchToken } from '../src/messaging/scheduled.service.js';
import type { MediaBucket, ObjectHead } from '../src/storage/media-storage.js';
import { adminClient, createTestAdmin } from './admin-helpers.js';
import { FakeMediaStorage, type IntegrationEnv, query, setupIntegrationEnv, startApp } from './integration-env.js';

/** File storage that can be made to fail, like Supabase Storage being down. */
class FlakyStorage extends FakeMediaStorage {
  failing = false;

  override async head(bucket: MediaBucket, path: string, bytes: number): Promise<ObjectHead | null> {
    if (this.failing) throw new Error('storage answered 503');
    return super.head(bucket, path, bytes);
  }
}

/**
 * Phase 14.5: site monitoring inside the Admin Dashboard. The minute call of the site's scheduled function records a
 * check; a gap becomes an outage incident when checks return; file storage, WhatsApp codes and a slow database open and
 * close incidents; Super Admins are told on WhatsApp (unless turned off); history is kept 30 days.
 */
describe('Phase 14.5 site monitoring (real Postgres, runtime role)', () => {
  let ctx: IntegrationEnv;
  let app: NestFastifyApplication;
  const storage = new FlakyStorage();
  let superPhone: string;
  let superAdmin: Awaited<ReturnType<typeof adminClient>>;
  let moderator: Awaited<ReturnType<typeof adminClient>>;

  const minuteCall = async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/internal/dispatch', headers: { 'x-bedo-dispatch': dispatchToken(ctx.env.ACCESS_TOKEN_SECRET!) } });
    expect(response.statusCode, response.body).toBe(200);
  };
  /** A minute call that is due to try file storage again (the storage checks moved back, a newer check kept). */
  const storageCall = async () => {
    await minuteCall();
    await query(ctx.ownerUrl, "update app.site_checks set checked_at = checked_at - interval '6 minutes' where storage_ok is not null");
    await minuteCall();
  };
  const alerts = async () => (await ctx.waabek.to(superPhone)).filter((text) => text.startsWith('Bedo Chat:'));
  const incidents = async () =>
    (await query<{ kind: string; ended: boolean; alerted: boolean }>(ctx.ownerUrl, 'select kind, ended_at is not null as ended, alerted_at is not null as alerted from app.site_incidents order by id')).rows;

  beforeAll(async () => {
    ctx = await setupIntegrationEnv();
    app = await startApp(ctx.env, undefined, { storage });
    const admin = await createTestAdmin(ctx, app, 'super_admin');
    superPhone = admin.phone;
    superAdmin = await adminClient(app, admin);
    moderator = await adminClient(app, await createTestAdmin(ctx, app, 'moderator'));
  });

  afterAll(async () => {
    await app?.close();
    await ctx?.teardown();
  });

  beforeEach(async () => {
    storage.failing = false;
  });

  it('says monitoring has not started until the first minute call', async () => {
    const summary = await moderator.get('/v1/admin/monitoring');
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ status: 'not_started', lastCheckAt: null, uptime: { day: null, week: null, month: null }, whatsappAlerts: true });
    expect(summary.body.timeline).toHaveLength(144);
  });

  it('records a check on each minute call, with the database time and file storage', async () => {
    await minuteCall();
    const rows = await query<{ kind: string; ok: boolean; database_ms: number; storage_ok: boolean | null }>(ctx.ownerUrl, 'select kind, ok, database_ms, storage_ok from app.site_checks');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ kind: 'heartbeat', ok: true, storage_ok: true });
    expect(rows.rows[0]!.database_ms).toBeGreaterThanOrEqual(0);
    const summary = (await moderator.get('/v1/admin/monitoring')).body;
    expect(summary.status).toBe('up');
    expect(summary.uptime.day).toBeGreaterThan(0);
    expect(summary.storage.ok).toBe(true);
    expect(summary.timeline.at(-1).state).not.toBe('none');
  });

  it('turns a gap into an outage incident when the checks come back, and tells the Super Admins', async () => {
    await query(ctx.ownerUrl, "update app.site_checks set checked_at = checked_at - interval '12 minutes'");
    await minuteCall();
    expect(await incidents()).toEqual([{ kind: 'outage', ended: true, alerted: true }]);
    const sent = await alerts();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/could not be reached from .* to .*about 1\d minutes\. It is working again\./);
    const summary = (await moderator.get('/v1/admin/monitoring')).body;
    expect(summary.incidents[0]).toMatchObject({ kind: 'outage', alerted: true });
    expect(summary.incidents[0].endedAt).not.toBeNull();
    expect(summary.uptime.day).toBeLessThan(100);
    expect(summary.timeline.some((step: { state: string }) => step.state === 'missing' || step.state === 'problem')).toBe(true);
  });

  it('opens a storage incident after two failed storage checks and closes it when storage answers', async () => {
    storage.failing = true;
    await storageCall();
    expect((await incidents()).filter((incident) => incident.kind === 'storage')).toEqual([]);
    await storageCall();
    expect((await incidents()).filter((incident) => incident.kind === 'storage')).toEqual([{ kind: 'storage', ended: false, alerted: true }]);
    expect((await moderator.get('/v1/admin/monitoring')).body.status).toBe('problem');
    expect((await alerts()).at(-1)).toMatch(/file storage is not answering/);

    storage.failing = false;
    await storageCall();
    expect((await incidents()).filter((incident) => incident.kind === 'storage')).toEqual([{ kind: 'storage', ended: true, alerted: true }]);
    expect((await alerts()).at(-1)).toMatch(/file storage is working again/);
    expect((await moderator.get('/v1/admin/monitoring')).body.status).toBe('up');
  });

  it('opens a WhatsApp incident when sign-in codes keep failing', async () => {
    for (let index = 0; index < 3; index += 1) {
      await query(ctx.ownerUrl, "insert into audit.security_events (subject_type, phone, event, details) values ('phone', '+201000099999', 'otp_delivery_failed', '{}')");
    }
    await minuteCall();
    expect((await incidents()).filter((incident) => incident.kind === 'whatsapp')).toHaveLength(1);
    expect((await moderator.get('/v1/admin/monitoring')).body.whatsappFailuresDay).toBe(3);
    await query(ctx.ownerUrl, "delete from audit.security_events where event = 'otp_delivery_failed'").catch(() => undefined);
  });

  it('lets every admin check now, and only a Super Admin turn the WhatsApp alerts off', async () => {
    const check = await moderator.post('/v1/admin/monitoring/check', {});
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ ok: true, storageOk: true });
    expect((await moderator.put('/v1/admin/monitoring/settings', { whatsappAlerts: false })).status).toBe(403);
    expect((await superAdmin.put('/v1/admin/monitoring/settings', { whatsappAlerts: false })).status).toBe(200);
    expect((await moderator.get('/v1/admin/monitoring')).body.whatsappAlerts).toBe(false);

    // With alerts off, an outage is still recorded but nobody is messaged.
    const before = (await alerts()).length;
    await query(ctx.ownerUrl, "update app.site_checks set checked_at = checked_at - interval '30 minutes'");
    await minuteCall();
    expect((await incidents()).filter((incident) => incident.kind === 'outage')).toHaveLength(2);
    expect((await alerts()).length).toBe(before);
    expect((await superAdmin.put('/v1/admin/monitoring/settings', { whatsappAlerts: true })).status).toBe(200);
  });

  it('refuses the minute call without the scheduler token and keeps 30 days of checks', async () => {
    expect((await app.inject({ method: 'POST', url: '/v1/internal/dispatch' })).statusCode).toBe(404);
    await query(ctx.ownerUrl, "insert into app.site_checks (kind, ok, database_ms, checked_at) values ('heartbeat', true, 1, now() - interval '31 days')");
    const { MonitoringService } = await import('../src/runtime/monitoring.service.js');
    const removed = await app.get(MonitoringService).prune();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect((await query(ctx.ownerUrl, "select 1 from app.site_checks where checked_at < now() - interval '30 days'")).rowCount).toBe(0);
  });
});
