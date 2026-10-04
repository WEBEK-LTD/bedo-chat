'use client';

import { listSessions, terminateOtherSessions, terminateSession, type SessionsResponseSessionsItem as SessionInfo } from '@bedo/api-client';
import { Icon } from '@bedo/ui';
import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../../_lib/api';
import { Button, FormError, formatDateTime } from '../ui';

/** Signed-in devices; end one session or every other session. */
export function DevicesPanel() {
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await listSessions();
    setSessions(response.sessions);
  }, []);

  useEffect(() => {
    load().catch((caught: unknown) => setError(errorMessage(caught)));
  }, [load]);

  async function act(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
      setConfirmAll(false);
    }
  }

  if (!sessions) {
    return <div className="p-4">{error ? <FormError message={error} /> : <p className="text-sm text-ink-secondary">Loading…</p>}</div>;
  }
  const others = sessions.filter((session) => !session.current);

  return (
    <div className="flex flex-col gap-4 p-4">
      <ul className="flex flex-col divide-y divide-line">
        {sessions.map((session) => (
          <li key={session.id} className="flex items-center gap-3 py-3">
            <Icon name={session.platform === 'ios' || session.platform === 'android' ? 'mobile' : 'computer'} className="shrink-0 text-ink-secondary" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {session.deviceName ?? 'Unknown device'}
                {session.current ? <span className="ml-2 text-accent">This device</span> : null}
              </p>
              <p className="truncate text-sm text-ink-secondary">
                {session.ip ?? 'Unknown location'} · {session.current ? 'Online' : `Last active ${formatDateTime(session.lastUsedAt)}`}
              </p>
              <p className="truncate text-xs text-ink-secondary">Signed in {formatDateTime(session.createdAt)}</p>
            </div>
            {!session.current ? (
              <Button
                variant="danger"
                className="h-8 px-3"
                busy={busy === session.id}
                onClick={() => void act(session.id, () => terminateSession(session.id))}
              >
                End
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <FormError message={error} />
      {others.length > 0 ? (
        confirmAll ? (
          <div className="flex flex-col gap-2 rounded-md bg-surface-subtle p-3">
            <p className="text-sm">Sign out of every other device?</p>
            <div className="flex gap-2">
              <Button
                variant="danger"
                busy={busy === 'all'}
                onClick={() => void act('all', () => terminateOtherSessions())}
              >
                End all other sessions
              </Button>
              <Button variant="secondary" onClick={() => setConfirmAll(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirmAll(true)}>
            End all other sessions
          </Button>
        )
      ) : (
        <p className="text-sm text-ink-secondary">No other devices are signed in.</p>
      )}
    </div>
  );
}
