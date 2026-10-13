import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AdminMonitoring, AdminMonitoringCheck, MonitoringIncidentKind, MonitoringTimelineState } from '@bedo/contracts';
import type { SiteIncidentKind } from '@bedo/db';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service.js';
import { WaabekSender } from '../delivery/waabek.client.js';
import { WaabekKeyProvider } from '../delivery/waabek-key.provider.js';
import { CHAT_MEDIA_BUCKET, MediaStorage } from '../storage/media-storage.js';

/** Site monitoring rules (Phase 14.5). */
export const MONITORING_RULES = {
  /** No minute check for this long means the site could not be reached. */
  outageAfterMinutes: 3,
  /** File storage is tried at most this often. */
  storageEveryMinutes: 5,
  /** WhatsApp code deliveries failing this many times within the window opens an incident. */
  whatsappFailures: 3,
  whatsappWindowMinutes: 15,
  /** One database step slower than this opens an incident; faster than the second value closes it. */
  slowDatabaseMs: 1500,
  normalDatabaseMs: 500,
  keepChecksDays: 30,
  keepIncidentsDays: 180,
  timelineBuckets: 144,
  bucketMinutes: 10,
} as const;

const ALERT_TIME_ZONE = 'Africa/Cairo';

function clock(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: ALERT_TIME_ZONE, hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }).format(date);
}

function minutesBetween(from: Date, to: Date): number {
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / 60_000));
}

interface Measured {
  databaseMs: number;
  storageOk: boolean | null;
  storageMs: number | null;
  storageError: string | null;
}

/**
 * Site monitoring inside the Admin Dashboard (Phase 14.5), with no outside service: the site's scheduled function calls
 * the site through its public address every minute (POST /api/v1/internal/dispatch), and each call that gets through
 * records a check. A gap between checks means the site could not be reached; it becomes an incident when the checks come
 * back. Problems and recoveries are sent to the Super Admins on WhatsApp (through the academy's Waabek key), unless turned
 * off in the dashboard. Nothing here can tell anyone while the whole site is down — the alert comes as soon as it is back.
 */
@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(MediaStorage) private readonly storage: MediaStorage,
    @Inject(WaabekSender) private readonly waabek: WaabekSender,
    @Inject(WaabekKeyProvider) private readonly keys: WaabekKeyProvider,
  ) {}

  private get db() {
    return this.database.db;
  }

  private serverRegion(): string | null {
    const region = process.env.AWS_REGION?.trim();
    return region && /^[a-z0-9-]{1,32}$/.test(region) ? region : null;
  }

  private async measure(withStorage: boolean): Promise<Measured> {
    const started = performance.now();
    await sql`select 1`.execute(this.db);
    const databaseMs = Math.round((performance.now() - started) * 10) / 10;
    if (!withStorage || !this.storage.enabled) {
      return { databaseMs, storageOk: null, storageMs: null, storageError: null };
    }
    const storageStarted = performance.now();
    try {
      // Looks up an object that never exists: a full round trip to file storage, signed with the server key.
      await this.storage.head(CHAT_MEDIA_BUCKET, 'monitoring/probe', 1);
      return { databaseMs, storageOk: true, storageMs: Math.round(performance.now() - storageStarted), storageError: null };
    } catch (error) {
      return { databaseMs, storageOk: false, storageMs: Math.round(performance.now() - storageStarted), storageError: error instanceof Error ? error.message.slice(0, 200) : 'storage error' };
    }
  }

  /** The minute check, called by the scheduled function's request. Never throws. */
  async heartbeat(now = new Date()): Promise<void> {
    try {
      const last = await this.db.selectFrom('app.site_checks').select(sql<Date | null>`max(checked_at)`.as('at')).where('kind', '=', 'heartbeat').executeTakeFirst();
      const lastStorage = await this.db
        .selectFrom('app.site_checks')
        .select(['checked_at', 'storage_ok'])
        .where('storage_ok', 'is not', null)
        .orderBy('checked_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      const storageDue = !lastStorage || now.getTime() - new Date(lastStorage.checked_at).getTime() >= (MONITORING_RULES.storageEveryMinutes - 0.5) * 60_000;
      const measured = await this.measure(storageDue);
      await this.db
        .insertInto('app.site_checks')
        .values({
          kind: 'heartbeat',
          ok: measured.storageOk !== false,
          database_ms: measured.databaseMs,
          storage_ms: measured.storageMs,
          storage_ok: measured.storageOk,
          server_region: this.serverRegion(),
          detail: measured.storageError,
        })
        .execute();

      // The site was not reached between the last check and this one.
      const lastAt = last?.at ? new Date(last.at) : null;
      if (lastAt && now.getTime() - lastAt.getTime() > MONITORING_RULES.outageAfterMinutes * 60_000) {
        const startedAt = new Date(lastAt.getTime() + 60_000);
        const minutes = minutesBetween(startedAt, now);
        const id = await this.openIncident('outage', startedAt, `Not reached for about ${minutes} minutes`, now);
        if (id) {
          await this.alert(id, 'alerted_at', `Bedo Chat: the website could not be reached from ${clock(startedAt)} to ${clock(now)} (Cairo time), about ${minutes} minutes. It is working again.`);
        }
      }

      if (measured.storageOk === false && lastStorage?.storage_ok === false) {
        const id = await this.openIncident('storage', now, measured.storageError ?? 'File storage did not answer');
        if (id) await this.alert(id, 'alerted_at', 'Bedo Chat: file storage is not answering. Photos, files and voice messages cannot be sent or opened.');
      } else if (measured.storageOk === true) {
        await this.closeIncident('storage', now, 'Bedo Chat: file storage is working again.');
      }

      const failures = await this.db
        .selectFrom('audit.security_events')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('event', '=', 'otp_delivery_failed')
        .where('occurred_at', '>', sql<Date>`now() - make_interval(mins => ${MONITORING_RULES.whatsappWindowMinutes})`)
        .executeTakeFirstOrThrow();
      if (failures.n >= MONITORING_RULES.whatsappFailures) {
        const id = await this.openIncident('whatsapp', now, `${failures.n} sign-in codes were not delivered in ${MONITORING_RULES.whatsappWindowMinutes} minutes`);
        if (id) await this.alert(id, 'alerted_at', 'Bedo Chat: WhatsApp sign-in codes are failing. New sign-ins may not work. Check the Waabek key in the Admin Dashboard.');
      } else if (failures.n === 0) {
        await this.closeIncident('whatsapp', now, 'Bedo Chat: WhatsApp sign-in codes are being delivered again.');
      }

      if (measured.databaseMs > MONITORING_RULES.slowDatabaseMs) {
        const id = await this.openIncident('database_slow', now, `One database step took ${Math.round(measured.databaseMs)} ms`);
        if (id) await this.alert(id, 'alerted_at', `Bedo Chat: the database is answering slowly (${Math.round(measured.databaseMs)} ms per step). Messages will be slow.`);
      } else if (measured.databaseMs < MONITORING_RULES.normalDatabaseMs) {
        await this.closeIncident('database_slow', now, 'Bedo Chat: the database is answering at normal speed again.');
      }
    } catch (error) {
      this.logger.error(`Site check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** "Check now" in the dashboard. */
  async checkNow(): Promise<AdminMonitoringCheck> {
    const measured = await this.measure(true);
    const row = await this.db
      .insertInto('app.site_checks')
      .values({
        kind: 'manual',
        ok: measured.storageOk !== false,
        database_ms: measured.databaseMs,
        storage_ms: measured.storageMs,
        storage_ok: measured.storageOk,
        server_region: this.serverRegion(),
        detail: measured.storageError,
      })
      .returning('checked_at')
      .executeTakeFirstOrThrow();
    return {
      ok: measured.storageOk !== false,
      checkedAt: new Date(row.checked_at).toISOString(),
      databaseMs: measured.databaseMs,
      storageOk: measured.storageOk,
      storageMs: measured.storageMs,
      serverRegion: this.serverRegion(),
    };
  }

  /** Opens an incident of this kind unless one is open; returns the new incident's id. */
  private async openIncident(kind: SiteIncidentKind, startedAt: Date, detail: string, endedAt: Date | null = null): Promise<string | null> {
    const row = await this.db
      .insertInto('app.site_incidents')
      .values({ kind, started_at: startedAt, ended_at: endedAt, detail: detail.slice(0, 300) })
      .onConflict((conflict) => conflict.column('kind').where('ended_at', 'is', null).doNothing())
      .returning('id')
      .executeTakeFirst();
    return row?.id ?? null;
  }

  private async closeIncident(kind: SiteIncidentKind, now: Date, message: string): Promise<void> {
    const closed = await this.db
      .updateTable('app.site_incidents')
      .set({ ended_at: now })
      .where('kind', '=', kind)
      .where('ended_at', 'is', null)
      .returning(['id', 'alerted_at'])
      .executeTakeFirst();
    if (closed?.alerted_at) await this.alert(closed.id, 'recovery_alerted_at', message);
  }

  /** WhatsApp to every active Super Admin (when alerts are on and a Waabek key is saved). */
  private async alert(incidentId: string, column: 'alerted_at' | 'recovery_alerted_at', message: string): Promise<void> {
    try {
      const settings = await this.db.selectFrom('app.monitoring_settings').select('whatsapp_alerts').executeTakeFirst();
      if (settings && !settings.whatsapp_alerts) return;
      const admins = await this.db.selectFrom('app.admin_accounts').select('phone').where('role', '=', 'super_admin').where('status', '=', 'active').execute();
      if (admins.length === 0) return;
      const key = await this.keys.currentKey();
      let delivered = 0;
      for (const admin of admins) {
        try {
          await this.waabek.send(key, admin.phone, message, 8_000);
          delivered += 1;
        } catch (error) {
          this.logger.warn(`Monitoring alert not delivered: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (delivered > 0) {
        const at = new Date();
        await this.db
          .updateTable('app.site_incidents')
          .set(column === 'alerted_at' ? { alerted_at: at } : { recovery_alerted_at: at })
          .where('id', '=', incidentId)
          .execute();
      }
    } catch (error) {
      this.logger.warn(`Monitoring alert not sent: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The dashboard's view: status, uptime, a 24-hour timeline and the recent incidents. */
  async summary(now = new Date()): Promise<AdminMonitoring> {
    const db = this.db;
    const [first, latest, settings, incidents, failures, database] = await Promise.all([
      db.selectFrom('app.site_checks').select(sql<Date | null>`min(checked_at)`.as('at')).where('kind', '=', 'heartbeat').executeTakeFirst(),
      db.selectFrom('app.site_checks').selectAll().orderBy('checked_at', 'desc').limit(1).executeTakeFirst(),
      db.selectFrom('app.monitoring_settings').select('whatsapp_alerts').executeTakeFirst(),
      db.selectFrom('app.site_incidents').selectAll().orderBy('started_at', 'desc').limit(30).execute(),
      db
        .selectFrom('audit.security_events')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('event', '=', 'otp_delivery_failed')
        .where('occurred_at', '>', sql<Date>`now() - interval '24 hours'`)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom('app.site_checks')
        .select(sql<number | null>`avg(database_ms)`.as('average'))
        .where('checked_at', '>', sql<Date>`now() - interval '24 hours'`)
        .executeTakeFirstOrThrow(),
    ]);
    const lastHeartbeat = await db
      .selectFrom('app.site_checks')
      .select(['checked_at', 'database_ms'])
      .where('kind', '=', 'heartbeat')
      .orderBy('checked_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const lastStorage = await db
      .selectFrom('app.site_checks')
      .select(['checked_at', 'storage_ok', 'storage_ms'])
      .where('storage_ok', 'is not', null)
      .orderBy('checked_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const since = first?.at ? new Date(first.at) : null;

    const uptime = async (hours: number): Promise<number | null> => {
      if (!since) return null;
      const start = new Date(Math.max(since.getTime(), now.getTime() - hours * 3_600_000));
      const expected = Math.max(1, Math.floor((now.getTime() - start.getTime()) / 60_000));
      const row = await db
        .selectFrom('app.site_checks')
        .select(sql<number>`count(distinct date_trunc('minute', checked_at))::int`.as('n'))
        .where('kind', '=', 'heartbeat')
        .where('ok', '=', true)
        .where('checked_at', '>=', start)
        .executeTakeFirstOrThrow();
      return Math.round(Math.min(100, (row.n / expected) * 100) * 100) / 100;
    };
    const [day, week, month] = await Promise.all([uptime(24), uptime(24 * 7), uptime(24 * 30)]);

    // 24 hours in ten-minute steps.
    const bucketMs = MONITORING_RULES.bucketMinutes * 60_000;
    const end = Math.floor(now.getTime() / bucketMs) * bucketMs + bucketMs;
    const start = end - MONITORING_RULES.timelineBuckets * bucketMs;
    const rows = await db
      .selectFrom('app.site_checks')
      .select([sql<number>`floor(extract(epoch from checked_at) * 1000 / ${bucketMs})::bigint`.as('bucket'), sql<number>`count(*)::int`.as('checks'), sql<number>`count(*) filter (where not ok)::int`.as('failed')])
      .where('kind', '=', 'heartbeat')
      .where('checked_at', '>=', new Date(start))
      .groupBy('bucket')
      .execute();
    const byBucket = new Map(rows.map((row) => [Number(row.bucket), row]));
    const timeline: AdminMonitoring['timeline'] = [];
    for (let at = start; at < end; at += bucketMs) {
      const row = byBucket.get(at / bucketMs);
      const bucketEnd = Math.min(at + bucketMs, now.getTime());
      let state: MonitoringTimelineState;
      if (!since || bucketEnd <= since.getTime() || at > now.getTime()) state = 'none';
      else if (!row) state = 'missing';
      else {
        const expected = Math.max(1, Math.floor((bucketEnd - Math.max(at, since.getTime())) / 60_000));
        state = row.failed > 0 || row.checks < Math.min(expected, MONITORING_RULES.bucketMinutes) * 0.7 ? 'problem' : 'ok';
      }
      timeline.push({ start: new Date(at).toISOString(), state });
    }

    const open = incidents.filter((incident) => incident.ended_at === null);
    const lastAt = lastHeartbeat ? new Date(lastHeartbeat.checked_at) : null;
    const status: AdminMonitoring['status'] = !lastAt
      ? 'not_started'
      : now.getTime() - lastAt.getTime() > MONITORING_RULES.outageAfterMinutes * 60_000
        ? 'not_reporting'
        : open.length > 0
          ? 'problem'
          : 'up';
    return {
      status,
      monitoringSince: since ? since.toISOString() : null,
      lastCheckAt: lastAt ? lastAt.toISOString() : null,
      serverRegion: latest?.server_region ?? null,
      uptime: { day, week, month },
      databaseMs: { last: lastHeartbeat?.database_ms ?? null, average: database.average === null ? null : Math.round(Number(database.average) * 10) / 10 },
      storage: {
        ok: lastStorage ? lastStorage.storage_ok : null,
        ms: lastStorage?.storage_ms ?? null,
        checkedAt: lastStorage ? new Date(lastStorage.checked_at).toISOString() : null,
      },
      whatsappFailuresDay: failures.n,
      whatsappAlerts: settings?.whatsapp_alerts ?? true,
      timeline,
      incidents: incidents.map((incident) => ({
        id: String(incident.id),
        kind: incident.kind as MonitoringIncidentKind,
        startedAt: new Date(incident.started_at).toISOString(),
        endedAt: incident.ended_at ? new Date(incident.ended_at).toISOString() : null,
        detail: incident.detail,
        alerted: incident.alerted_at !== null,
      })),
    };
  }

  async setAlerts(adminId: string, whatsappAlerts: boolean): Promise<void> {
    await this.db.updateTable('app.monitoring_settings').set({ whatsapp_alerts: whatsappAlerts, updated_by: adminId, updated_at: new Date() }).execute();
  }

  /** Housekeeping: checks older than 30 days, incidents older than 180. */
  async prune(): Promise<number> {
    const checks = await this.db.deleteFrom('app.site_checks').where('checked_at', '<', sql<Date>`now() - make_interval(days => ${MONITORING_RULES.keepChecksDays})`).executeTakeFirst();
    const incidents = await this.db
      .deleteFrom('app.site_incidents')
      .where('started_at', '<', sql<Date>`now() - make_interval(days => ${MONITORING_RULES.keepIncidentsDays})`)
      .where('ended_at', 'is not', null)
      .executeTakeFirst();
    return Number(checks.numDeletedRows) + Number(incidents.numDeletedRows);
  }
}
