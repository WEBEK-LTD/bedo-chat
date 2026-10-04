'use client';

import { listSecurityNotices, markSecurityNoticesRead, type SecurityNoticesResponseNoticesItem as SecurityNotice } from '@bedo/api-client';
import { Icon } from '@bedo/ui';
import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../../_lib/api';
import { disablePush, enablePush, type PushState, pushState } from '../../_lib/push';
import { Button, FormError, formatDateTime, Notice } from '../ui';

/** The sentence shown for a security notice (D-13). */
export function noticeText(notice: SecurityNotice): string {
  switch (notice.kind) {
    case 'new_login': {
      const device = notice.details.deviceName ?? 'a new device';
      const where = notice.details.ip ? ` (${notice.details.ip})` : '';
      return `New sign-in to your account on ${device}${where}, ${formatDateTime(notice.createdAt)}. If this wasn't you, end that session in Devices.`;
    }
    case 'deletion_requested':
      return 'You asked for your account to be deleted. An administrator will review the request.';
    case 'deletion_rejected':
      return 'Your request to delete your account was rejected. Your account remains active.';
    case 'two_step_reset':
      return 'An administrator reset your 2-Step Verification password at your request.';
  }
}

const PUSH_TEXT: Record<PushState, string> = {
  unsupported:
    'This browser does not support notifications. On iPhone and iPad, add Bedo Chat to your Home Screen first (iOS 16.4 or later).',
  unavailable: 'Notifications are not available yet.',
  denied: 'Notifications are blocked for this site. Allow them in your browser settings, then come back here.',
  off: 'Get a notification on this device when someone signs in to your account.',
  on: 'Notifications are on for this device.',
};

/** Security notices and this browser's notification permission (D-13, D-21). */
export function NotificationsPanel() {
  const [notices, setNotices] = useState<SecurityNotice[] | null>(null);
  const [push, setPush] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await listSecurityNotices();
    setNotices(response.notices);
  }, []);

  useEffect(() => {
    load().catch((caught: unknown) => setError(errorMessage(caught)));
    pushState()
      .then(setPush)
      .catch(() => setPush('unavailable'));
  }, [load]);

  async function togglePush() {
    setBusy(true);
    setError(null);
    try {
      setPush(push === 'on' ? await disablePush() : await enablePush());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function markAllRead() {
    try {
      await markSecurityNoticesRead({});
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Notifications on this device</h3>
        {push ? (
          <>
            <Notice tone={push === 'denied' ? 'warning' : 'info'}>{PUSH_TEXT[push]}</Notice>
            {push === 'off' || push === 'on' ? (
              <Button variant={push === 'on' ? 'secondary' : 'primary'} busy={busy} onClick={() => void togglePush()}>
                {push === 'on' ? 'Turn off notifications' : 'Turn on notifications'}
              </Button>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-ink-secondary">Checking…</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Security notices</h3>
          {notices?.some((notice) => !notice.read) ? (
            <Button variant="ghost" className="h-8 px-2" onClick={() => void markAllRead()}>
              Mark all as read
            </Button>
          ) : null}
        </div>
        {notices === null ? (
          <p className="text-sm text-ink-secondary">Loading…</p>
        ) : notices.length === 0 ? (
          <p className="text-sm text-ink-secondary">No notices.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {notices.map((notice) => (
              <li key={notice.id} className="flex items-start gap-3 py-3">
                <Icon name="shield" size={20} className={`mt-0.5 shrink-0 ${notice.read ? 'text-ink-secondary' : 'text-accent'}`} />
                <div className="min-w-0 flex-1">
                  <p className={`text-sm ${notice.read ? 'text-ink-secondary' : ''}`}>{noticeText(notice)}</p>
                  <p className="text-xs text-ink-secondary">{formatDateTime(notice.createdAt)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <FormError message={error} />
    </div>
  );
}
