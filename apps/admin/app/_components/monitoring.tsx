'use client';

import { adminMonitoring, adminMonitoringCheck, adminMonitoringSettings, type AdminMonitoring, type AdminMonitoringCheck } from '@bedo/api-client';
import { Icon, type IconName } from '@bedo/ui';
import { useEffect, useState } from 'react';
import { errorMessage, formatDateTime } from '../_lib/api';
import { SectionTitle, useLoader } from './console-ui';
import { Button, FormError } from './ui';

type Incident = AdminMonitoring['incidents'][number];

const INCIDENT_LABELS: Record<Incident['kind'], { label: string; icon: IconName }> = {
  outage: { label: 'Site not reachable', icon: 'cloud_off' },
  storage: { label: 'File storage failing', icon: 'sync_problem' },
  whatsapp: { label: 'WhatsApp codes failing', icon: 'error' },
  database_slow: { label: 'Database slow', icon: 'database' },
};

const STATE_STYLES: Record<AdminMonitoring['timeline'][number]['state'], { className: string; label: string }> = {
  ok: { className: 'bg-success', label: 'Working' },
  problem: { className: 'bg-[#e8a33d]', label: 'Problem or some checks missing' },
  missing: { className: 'bg-danger', label: 'Not reachable' },
  none: { className: 'bg-line', label: 'Before monitoring started' },
};

function duration(startedAt: string, endedAt: string | null): string {
  const minutes = Math.max(1, Math.round(((endedAt ? new Date(endedAt).getTime() : Date.now()) - new Date(startedAt).getTime()) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const percent = (value: number | null) => (value === null ? '—' : `${value.toFixed(value === 100 ? 0 : 2)}%`);
const ms = (value: number | null) => (value === null ? '—' : value < 10 ? `${value.toFixed(1)} ms` : `${Math.round(value).toLocaleString()} ms`);

function Tile({ icon, label, value, note }: { icon: IconName; label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4 shadow-sm">
      <span className="flex items-center gap-2.5 text-sm text-ink-secondary">
        <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-accent-soft text-accent">
          <Icon name={icon} size={18} />
        </span>
        {label}
      </span>
      <span className="text-[1.5rem] font-bold leading-none tracking-tight tabular-nums">{value}</span>
      {note ? <span className="text-xs text-ink-secondary">{note}</span> : null}
    </div>
  );
}

function StatusBanner({ data }: { data: AdminMonitoring }) {
  const open = data.incidents.filter((incident) => incident.endedAt === null);
  const minutesSince = data.lastCheckAt ? Math.round((Date.now() - new Date(data.lastCheckAt).getTime()) / 60_000) : null;
  const view =
    data.status === 'up'
      ? { tone: 'border-success/30 bg-success/10', icon: 'check_circle' as const, iconTone: 'text-success', title: 'Bedo Chat is up', text: `Last check ${formatDateTime(data.lastCheckAt)}.` }
      : data.status === 'problem'
        ? {
            tone: 'border-danger/25 bg-danger/5',
            icon: 'warning' as const,
            iconTone: 'text-danger',
            title: open.map((incident) => INCIDENT_LABELS[incident.kind].label).join(', '),
            text: open.map((incident) => incident.detail).filter(Boolean).join(' · ') || 'See the incidents below.',
          }
        : data.status === 'not_reporting'
          ? {
              tone: 'border-[#e8a33d]/40 bg-[#e8a33d]/10',
              icon: 'schedule' as const,
              iconTone: 'text-[#b9741a]',
              title: `No check for ${minutesSince} minutes`,
              text: 'Either the site cannot be reached right now, or the minute check is not running. When checks come back, the gap is recorded as an incident and Super Admins are told.',
            }
          : {
              tone: 'border-line bg-surface',
              icon: 'schedule' as const,
              iconTone: 'text-ink-secondary',
              title: 'Monitoring starts soon',
              text: 'The first check runs within a minute of publishing this version of the site (checks run only on the published site).',
            };
  return (
    <section aria-label="Site status" className={`flex items-start gap-3 rounded-md border p-4 shadow-sm ${view.tone}`}>
      <Icon name={view.icon} size={26} className={`shrink-0 ${view.iconTone}`} />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-lg font-semibold" data-testid="monitoring-status">
          {view.title}
        </p>
        <p className="text-sm text-ink-secondary">{view.text}</p>
      </div>
    </section>
  );
}

function Timeline({ data }: { data: AdminMonitoring }) {
  return (
    <section aria-label="Last 24 hours" className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4 shadow-sm">
      <div className="flex items-center justify-between text-sm">
        <span className="font-semibold">Last 24 hours</span>
        <span className="text-ink-secondary">each bar is 10 minutes</span>
      </div>
      <div className="flex h-10 items-stretch gap-px" role="img" aria-label={`${data.timeline.filter((step) => step.state === 'missing').length} ten-minute periods without a check`}>
        {data.timeline.map((step) => (
          <span key={step.start} title={`${formatDateTime(step.start)}: ${STATE_STYLES[step.state].label}`} className={`min-w-0 flex-1 rounded-[2px] ${STATE_STYLES[step.state].className}`} />
        ))}
      </div>
      <div className="flex justify-between text-xs text-ink-secondary">
        <span>24 hours ago</span>
        <span>now</span>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-secondary">
        {(['ok', 'problem', 'missing'] as const).map((state) => (
          <li key={state} className="flex items-center gap-1.5">
            <span className={`size-2.5 rounded-[2px] ${STATE_STYLES[state].className}`} />
            {STATE_STYLES[state].label}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Phase 14.5: site monitoring inside the dashboard, with no outside service. The site's own minute check records how
 * it is doing; gaps become incidents, and Super Admins are told on WhatsApp.
 */
export function Monitoring({ canChange, onSessionError }: { canChange: boolean; onSessionError: (error: unknown) => void }) {
  const { data, setData, error, reload } = useLoader(() => adminMonitoring(), onSessionError, []);
  const [check, setCheck] = useState<AdminMonitoringCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Fresh numbers every minute while the page is open.
  useEffect(() => {
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, []);

  async function checkNow() {
    setBusy(true);
    setActionError(null);
    try {
      setCheck(await adminMonitoringCheck());
      reload();
    } catch (caught) {
      onSessionError(caught);
      setActionError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function setAlerts(on: boolean) {
    if (!data) return;
    setBusy(true);
    setActionError(null);
    try {
      await adminMonitoringSettings({ whatsappAlerts: on });
      setData({ ...data, whatsappAlerts: on });
    } catch (caught) {
      onSessionError(caught);
      setActionError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <SectionTitle note="Checked every minute by the site itself. No outside service.">Site monitoring</SectionTitle>
        <Button variant="secondary" busy={busy} onClick={() => void checkNow()}>
          Check now
        </Button>
      </div>
      <FormError message={error ?? actionError} />
      {check ? (
        <p className="text-sm" role="status" data-testid="check-result">
          {check.ok ? 'Working.' : 'A problem was found.'} Database step {ms(check.databaseMs)}
          {check.storageOk === null ? '' : `, file storage ${check.storageOk ? `answered in ${ms(check.storageMs)}` : 'did not answer'}`}.
        </p>
      ) : null}
      {data === null ? <p className="text-sm text-ink-secondary">Loading…</p> : null}
      {data ? (
        <>
          <StatusBanner data={data} />
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Uptime">
            <Tile icon="monitor_heart" label="Up, last 24 hours" value={percent(data.uptime.day)} note={`7 days ${percent(data.uptime.week)} · 30 days ${percent(data.uptime.month)}`} />
            <Tile icon="database" label="Database step" value={ms(data.databaseMs.last)} note={`24-hour average ${ms(data.databaseMs.average)}`} />
            <Tile
              icon={data.storage.ok === false ? 'cloud_off' : 'cloud_done'}
              label="File storage"
              value={data.storage.ok === null ? '—' : data.storage.ok ? 'Working' : 'Failing'}
              note={data.storage.checkedAt ? `${ms(data.storage.ms)}, ${formatDateTime(data.storage.checkedAt)}` : 'Checked every 5 minutes'}
            />
            <Tile icon="key" label="WhatsApp codes not delivered" value={String(data.whatsappFailuresDay)} note="Last 24 hours" />
          </section>
          <Timeline data={data} />
          <section aria-labelledby="incidents-title" className="flex flex-col gap-3">
            <h2 id="incidents-title" className="font-semibold">
              Incidents
            </h2>
            {data.incidents.length === 0 ? (
              <p className="text-sm text-ink-secondary">No incidents.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface text-sm shadow-sm" aria-label="Incidents">
                {data.incidents.map((incident) => (
                  <li key={incident.id} className="flex items-start gap-3 p-3">
                    <Icon name={INCIDENT_LABELS[incident.kind].icon} size={20} className={`mt-0.5 shrink-0 ${incident.endedAt ? 'text-ink-secondary' : 'text-danger'}`} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {INCIDENT_LABELS[incident.kind].label}
                        {incident.endedAt ? null : <span className="ml-2 rounded-full bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">Ongoing</span>}
                      </p>
                      <p className="text-ink-secondary">
                        {formatDateTime(incident.startedAt)} {incident.endedAt ? `to ${formatDateTime(incident.endedAt)}` : 'until now'} · {duration(incident.startedAt, incident.endedAt)}
                        {incident.detail ? ` · ${incident.detail}` : ''}
                      </p>
                    </div>
                    {incident.alerted ? <span className="shrink-0 text-xs text-ink-secondary">Told on WhatsApp</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="alerts-title" className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4 shadow-sm">
            <h2 id="alerts-title" className="font-semibold">
              WhatsApp alerts
            </h2>
            <p className="text-sm text-ink-secondary">
              Super Admins get a WhatsApp message (through the academy&apos;s Waabek key) when file storage, WhatsApp codes or the database have a
              problem, and when it is fixed. While the whole site is down nothing can send a message, so that alert comes the moment the site is back,
              with how long it was down.
            </p>
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={data.whatsappAlerts}
                disabled={!canChange || busy}
                onChange={(event) => void setAlerts(event.target.checked)}
              />
              Tell Super Admins on WhatsApp
            </label>
            {!canChange ? <p className="text-xs text-ink-secondary">Only a Super Admin can change this.</p> : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
