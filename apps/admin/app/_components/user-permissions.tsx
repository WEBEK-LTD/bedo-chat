'use client';

import { adminSetUserPermissions, adminUserPermissions, type AdminUserPermissionsResponse } from '@bedo/api-client';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '../_lib/api';
import { Button, FormError, Notice } from './ui';
import { PhoneField } from '@bedo/ui';

const LABELS = {
  createGroups: 'Create groups',
  createChannels: 'Create channels',
  scheduleMessages: 'Schedule messages',
} as const;

/**
 * System permissions of one user (O-21, Phase 5): creating groups (on by default), creating channels and scheduling
 * messages (off by default). Every admin can look a user up; Super Admins change them. Changes are in the admin history.
 */
export function UserPermissions({ canChange, onSessionError }: { canChange: boolean; onSessionError: (error: unknown) => void }) {
  const [phone, setPhone] = useState('');
  const [found, setFound] = useState<AdminUserPermissionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function lookUp(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      setFound(await adminUserPermissions({ phone: phone.trim() }));
    } catch (caught) {
      onSessionError(caught);
      setFound(null);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(key: keyof typeof LABELS) {
    if (!found) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const next = { ...found.permissions, [key]: !found.permissions[key] };
      setFound(await adminSetUserPermissions({ phone: found.user.phone, ...next }));
      setDone('Saved.');
    } catch (caught) {
      onSessionError(caught);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <h1 className="text-[length:var(--bedo-font-size-xl)] font-semibold">User permissions</h1>
      <p className="text-sm text-ink-secondary">What one student may create. Everyone may create groups unless you turn it off; channels and scheduled messages need your permission.</p>
      <form className="flex items-end gap-2" onSubmit={(event) => void lookUp(event)}>
        <div className="flex-1">
          <PhoneField id="permissions-phone" label="Phone number" value={phone} onChange={setPhone} autoComplete="off" />
        </div>
        <Button type="submit" disabled={busy || phone.trim().length < 5}>
          Look up
        </Button>
      </form>
      <FormError message={error} />
      {done ? <Notice>{done}</Notice> : null}
      {found ? (
        <section aria-label="Permissions" className="flex flex-col gap-3 rounded-md border border-line bg-surface shadow-sm p-4">
          <p className="text-sm">
            <span className="font-medium">{found.user.name ?? 'No name yet'}</span> · {found.user.phone} · {found.user.status}
          </p>
          {(Object.keys(LABELS) as Array<keyof typeof LABELS>).map((key) => (
            <label key={key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={found.permissions[key]} disabled={!canChange || busy} onChange={() => void toggle(key)} />
              {LABELS[key]}
            </label>
          ))}
          {canChange ? null : <p className="text-xs text-ink-secondary">Your Moderator role can view these permissions.</p>}
        </section>
      ) : null}
    </div>
  );
}
