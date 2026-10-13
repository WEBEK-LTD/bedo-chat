'use client';

import { adminListUsers, type AdminUsersResponseUsersItem as UserItem } from '@bedo/api-client';
import { ADMIN_CONSOLE_RULES, type AdminRight, type MemberPermission } from '@bedo/contracts';
import { Icon } from '@bedo/ui';
import { type ReactNode, useEffect, useState } from 'react';
import { errorMessage } from '../_lib/api';
import { Button, FormError, Notice, TextArea } from './ui';

/** Shared pieces of the Phase 10 sections (D-44). */

export const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  suspended: 'Suspended',
  banned: 'Banned',
  deletion_requested: 'Deletion requested',
  deleted: 'Deleted',
};

export const RIGHT_LABELS: Record<AdminRight, string> = {
  change_info: 'Change info',
  delete_messages: 'Delete messages',
  restrict_members: 'Restrict and remove members',
  invite_users: 'Add members and invite links',
  approve_requests: 'Approve join requests',
  pin_messages: 'Pin messages',
  manage_admins: 'Add admins',
  change_privacy: 'Member privacy',
  post_messages: 'Post in the channel',
};

export const PERMISSION_LABELS: Record<MemberPermission, string> = {
  send_messages: 'Send messages',
  send_media: 'Send photos, videos and files',
  send_stickers: 'Send stickers and GIFs',
  send_polls: 'Send polls',
  add_members: 'Add members',
  pin_messages: 'Pin messages',
  change_info: 'Change group info',
};

export function SectionTitle({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-[length:var(--bedo-font-size-xl)] font-semibold">{children}</h1>
      {note ? <p className="text-sm text-ink-secondary">{note}</p> : null}
    </div>
  );
}

export function Tabs<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ id: T; label: string }>; onChange: (value: T) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-1" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={value === option.id}
          onClick={() => onChange(option.id)}
          className="h-9 shrink-0 rounded-full px-3.5 text-sm text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink aria-selected:bg-accent-soft aria-selected:font-semibold aria-selected:text-accent"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone = status === 'active' ? 'text-accent' : status === 'deleted' ? 'text-ink-secondary' : 'text-danger';
  return <span className={`text-xs font-medium ${tone}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-9 items-center gap-1 self-start rounded-full pl-2 pr-3.5 text-sm text-ink-secondary transition-colors hover:bg-surface hover:text-ink">
      <Icon name="arrow_back" size={20} />
      {label}
    </button>
  );
}

export function personLabel(person: { name: string | null; phone: string | null; username?: string | null } | null): string {
  if (!person) return '—';
  return [person.name ?? 'No name', person.phone, person.username ? `@${person.username}` : null].filter(Boolean).join(' · ');
}

/**
 * An action that needs a reason (kept in the admin history) and a second click. `danger` actions are styled as such.
 */
export function ReasonAction({
  id,
  label,
  confirmText,
  confirmLabel,
  danger = false,
  disabled = false,
  onConfirm,
}: {
  id: string;
  label: string;
  confirmText: string;
  confirmLabel?: string;
  danger?: boolean;
  disabled?: boolean;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) {
    return (
      <Button variant={danger ? 'danger' : 'secondary'} disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  }
  const ready = reason.trim().length >= ADMIN_CONSOLE_RULES.reasonMinLength;
  return (
    <div className="w-full">
      <Notice tone={danger ? 'warning' : 'info'}>
        <p>{confirmText}</p>
        <div className="mt-3">
          <TextArea id={`${id}-reason`} label="Reason (kept in the admin history)" maxLength={ADMIN_CONSOLE_RULES.reasonMaxLength} value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
        <div className="mt-3 flex gap-2">
          <Button
            variant={danger ? 'danger' : 'primary'}
            busy={busy}
            disabled={!ready}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm(reason.trim());
                setOpen(false);
                setReason('');
              } catch (caught) {
                setError(errorMessage(caught));
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel ?? label}
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
        <div className="mt-2">
          <FormError message={error} />
        </div>
      </Notice>
    </div>
  );
}

/** Finds a user by phone, name or username and picks them. */
export function UserPicker({ id, label, onPick, exclude = [] }: { id: string; label: string; onPick: (user: UserItem) => void; exclude?: string[] }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<UserItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      adminListUsers({ q: text })
        .then((response) => setResults(response.users.filter((user) => user.status === 'active' || user.status === 'deletion_requested')))
        .catch((caught: unknown) => setError(errorMessage(caught)));
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        value={q}
        placeholder="Phone, name or username"
        onChange={(event) => setQ(event.target.value)}
        className="h-[var(--bedo-control-height)] rounded-sm border border-line bg-surface px-3 text-sm outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-3 focus:ring-accent/15"
      />
      <FormError message={error} />
      {results.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface shadow-sm text-sm" aria-label={`${label} results`}>
          {results
            .filter((user) => !exclude.includes(user.id))
            .slice(0, 8)
            .map((user) => (
              <li key={user.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-hover"
                  onClick={() => {
                    onPick(user);
                    setQ('');
                    setResults([]);
                  }}
                >
                  <Icon name="person_add" size={18} className="text-ink-secondary" />
                  {personLabel(user)}
                </button>
              </li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p>
      <span className="text-ink-secondary">{label}: </span>
      {children}
    </p>
  );
}

export function useLoader<T>(load: () => Promise<T>, onSessionError: (error: unknown) => void, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let live = true;
    setError(null);
    load()
      .then((value) => {
        if (live) setData(value);
      })
      .catch((caught: unknown) => {
        onSessionError(caught);
        if (live) setError(errorMessage(caught));
      });
    return () => {
      live = false;
    };
  }, [...deps, version]);
  return { data, setData, error, reload: () => setVersion((value) => value + 1) };
}
