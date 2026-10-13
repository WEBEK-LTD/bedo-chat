'use client';

import { type Chat, SCHEDULE_RULES, type ScheduledMessage } from '@bedo/contracts';
import { Icon } from '@bedo/ui';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../_lib/api';
import { useMessaging, useMessagingStore } from '../../_lib/messaging/context';
import { MEDIA_LABEL } from '../../_lib/messaging/media';
import { Button, FormError } from '../ui';
import { Dialog } from './menu';

/** "Tue 14 Oct, 09:00". */
export function scheduleLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The value of a datetime-local input for a time (local time, to the minute). */
function localInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function presets(now: Date): Array<{ label: string; at: Date }> {
  const inHour = new Date(now.getTime() + 3600_000);
  const tonight = new Date(now);
  tonight.setHours(20, 0, 0, 0);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return [
    { label: 'In 1 hour', at: inHour },
    ...(tonight.getTime() - now.getTime() > 3600_000 ? [{ label: 'This evening at 20:00', at: tonight }] : []),
    { label: 'Tomorrow at 09:00', at: tomorrow },
  ];
}

/** Choosing when a message is sent (Phase 6): a few common times, or any time up to a year ahead. */
export function ScheduleDialog({ title = 'Schedule message', initial, onClose, onPick }: { title?: string; initial?: string; onClose: () => void; onPick: (sendAt: string) => Promise<boolean> }) {
  const [now] = useState(() => new Date());
  const [custom, setCustom] = useState(() => localInput(initial ? new Date(initial) : new Date(now.getTime() + 3600_000)));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const min = localInput(new Date(now.getTime() + 60_000));
  const max = localInput(new Date(now.getTime() + SCHEDULE_RULES.maxAheadDays * 86_400_000));

  async function pick(at: Date) {
    if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() + SCHEDULE_RULES.minAheadSeconds * 1000) {
      setError('Choose a time in the future.');
      return;
    }
    setBusy(true);
    setError(null);
    const ok = await onPick(at.toISOString());
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <Dialog title={title} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col gap-1">
          {presets(now).map((preset) => (
            <li key={preset.label}>
              <button type="button" disabled={busy} onClick={() => void pick(preset.at)} className="flex w-full items-center gap-3 rounded-sm px-2 py-2 text-left text-sm hover:bg-surface-hover disabled:opacity-50">
                <Icon name="schedule" size={20} className="text-ink-secondary" />
                <span className="flex-1">{preset.label}</span>
                <span className="text-xs text-ink-secondary">{scheduleLabel(preset.at.toISOString())}</span>
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex flex-col gap-2 border-t border-line pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void pick(new Date(custom));
          }}
        >
          <label htmlFor="schedule-at" className="text-sm font-medium">
            Date and time
          </label>
          <input
            id="schedule-at"
            type="datetime-local"
            value={custom}
            min={min}
            max={max}
            onChange={(event) => setCustom(event.target.value)}
            className="h-[var(--bedo-control-height)] rounded-sm border border-line bg-surface px-3 outline-none focus:border-accent"
          />
          <FormError message={error} />
          <Button type="submit" disabled={busy || !custom}>
            Schedule
          </Button>
        </form>
      </div>
    </Dialog>
  );
}

function contentOf(item: ScheduledMessage): string {
  const media = item.pollQuestion ? `📊 ${item.pollQuestion}` : item.media ? (item.fileName ? `${MEDIA_LABEL[item.media]}: ${item.fileName}` : MEDIA_LABEL[item.media]) : null;
  return media ? (item.text ? `${media}, ${item.text}` : media) : (item.text ?? '');
}

const FAILURE: Record<string, string> = {
  NOT_ALLOWED: 'You can no longer post here.',
  NOT_FOUND: 'The chat or the message it replies to is gone.',
  CANNOT_MESSAGE: 'This person no longer accepts your messages.',
  USER_BLOCKED: 'You blocked this person.',
  ACCOUNT_BLOCKED: 'Your account cannot send messages.',
};

/** The signed-in user's scheduled messages in one chat: send now, change the time, or remove. */
export function ScheduledPanel({ chat, onClose, onNotice }: { chat: Chat; onClose: () => void; onNotice: (message: string) => void }) {
  const state = useMessaging();
  const store = useMessagingStore();
  const list = state.scheduled[chat.id];
  const [rescheduling, setRescheduling] = useState<ScheduledMessage | null>(null);
  useEffect(() => {
    void store.loadScheduled(chat.id).catch((error: unknown) => onNotice(errorMessage(error)));
  }, [store, chat.id, onNotice]);
  const act = (action: () => Promise<void>, done: string) =>
    void action()
      .then(() => onNotice(done))
      .catch((error: unknown) => onNotice(errorMessage(error)));
  return (
    <Dialog title="Scheduled messages" onClose={onClose}>
      {list === undefined ? <p className="text-sm text-ink-secondary">Loading…</p> : null}
      {list?.length === 0 ? <p className="text-sm text-ink-secondary">No scheduled messages.</p> : null}
      <ul className="flex flex-col gap-3" aria-label="Scheduled">
        {(list ?? []).map((item) => (
          <li key={item.id} className="flex flex-col gap-1 rounded-sm border border-line p-3">
            <span className="flex items-center gap-2 text-xs text-ink-secondary">
              <Icon name={item.status === 'failed' ? 'error' : 'schedule_send'} size={16} className={item.status === 'failed' ? 'text-danger' : 'text-accent'} />
              {item.status === 'failed' ? 'Not sent' : `Sends ${scheduleLabel(item.sendAt)}`}
            </span>
            <p className="whitespace-pre-wrap break-words text-sm">{contentOf(item)}</p>
            {item.status === 'failed' ? <p className="text-xs text-danger">{FAILURE[item.error ?? ''] ?? 'It could not be sent. Try again.'}</p> : null}
            <div className="flex flex-wrap gap-3 text-sm">
              <button type="button" className="text-accent" onClick={() => act(() => store.sendScheduledNow(item), 'Sent.')}>
                Send now
              </button>
              <button type="button" className="text-accent" onClick={() => setRescheduling(item)}>
                Change time
              </button>
              <button type="button" className="text-danger" onClick={() => act(() => store.cancelScheduled(item), 'Scheduled message removed.')}>
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {rescheduling ? (
        <ScheduleDialog
          title="Change time"
          initial={rescheduling.sendAt}
          onClose={() => setRescheduling(null)}
          onPick={(sendAt) =>
            store
              .reschedule(rescheduling, sendAt)
              .then(() => true)
              .catch((error: unknown) => {
                onNotice(errorMessage(error));
                return false;
              })
          }
        />
      ) : null}
    </Dialog>
  );
}
