'use client';

import { adminStats } from '@bedo/api-client';
import { Icon, type IconName } from '@bedo/ui';
import { FormError } from './ui';
import { SectionTitle, useLoader } from './console-ui';
import { SpeedCheck } from './speed-check';

function Tile({ icon, label, value, note }: { icon: IconName; label: string; value: number; note?: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface p-4 shadow-sm">
      <span className="flex items-center gap-2.5 text-sm text-ink-secondary">
        <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-accent-soft text-accent">
          <Icon name={icon} size={18} />
        </span>
        {label}
      </span>
      <span className="text-[1.75rem] font-bold leading-none tracking-tight tabular-nums" aria-label={label}>
        {value.toLocaleString()}
      </span>
      {note ? <span className="text-xs text-ink-secondary">{note}</span> : null}
    </div>
  );
}

/** Statistics (spec §22): accounts, activity, chats and what is waiting for an admin. Counts only, no content. */
export function Overview({ onSessionError }: { onSessionError: (error: unknown) => void }) {
  const { data: stats, error, reload } = useLoader(() => adminStats(), onSessionError, []);

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <SectionTitle note="Counts only. Nothing here shows what anyone wrote.">Overview</SectionTitle>
        <button type="button" onClick={reload} className="flex h-9 items-center gap-1.5 rounded-full px-3 text-sm text-ink-secondary transition-colors hover:bg-surface hover:text-ink">
          <Icon name="refresh" size={20} />
          Refresh
        </button>
      </div>
      <SpeedCheck onSessionError={onSessionError} />
      <FormError message={error} />
      {!stats ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Accounts">
            <Tile icon="group" label="Accounts" value={stats.users.total} note={`${stats.users.active} active`} />
            <Tile icon="fiber_manual_record" label="Online now" value={stats.onlineNow} />
            <Tile icon="history" label="Active in the last 24 hours" value={stats.activeLast24h} />
            <Tile icon="block" label="Suspended or banned" value={stats.users.suspended + stats.users.banned} note={`${stats.users.suspended} suspended · ${stats.users.banned} banned`} />
          </section>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Activity">
            <Tile icon="chat" label="Messages in the last 24 hours" value={stats.messages.last24h} note={`${stats.messages.last7Days.toLocaleString()} in 7 days`} />
            <Tile icon="groups" label="Groups" value={stats.groups} />
            <Tile icon="campaign" label="Channels" value={stats.channels} />
            <Tile icon="schedule_send" label="Scheduled messages waiting" value={stats.pendingScheduledMessages} />
          </section>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Waiting for an admin">
            <Tile icon="flag" label="Open reports" value={stats.openReports} />
            <Tile icon="person_remove" label="Deletion requests" value={stats.pendingDeletionRequests} />
            <Tile icon="devices" label="Signed-in devices" value={stats.activeSessions} />
            <Tile icon="notifications" label="Devices with notifications" value={stats.pushDevices} />
          </section>
        </>
      )}
    </div>
  );
}
