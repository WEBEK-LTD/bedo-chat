'use client';

import { adminGetUser, adminListUsers, adminUserAction, type AdminUserDetail, type AdminUsersResponseUsersItem as UserItem } from '@bedo/api-client';
import { USER_STATUSES } from '@bedo/contracts';
import { Icon } from '@bedo/ui';
import { type FormEvent, useState } from 'react';
import { formatDateTime } from '../_lib/api';
import { Button, FormError, Notice } from './ui';
import { BackButton, Field, ReasonAction, SectionTitle, StatusBadge, STATUS_LABELS, Tabs, useLoader } from './console-ui';

type Filter = 'all' | (typeof USER_STATUSES)[number];

/**
 * Users (spec §22): find anyone by phone, name or username; see their account, devices and history; suspend,
 * reactivate or end their sessions (every admin), ban or delete (Super Admins). Every action needs a reason and is
 * recorded in the admin history.
 */
export function Users({ isSuperAdmin, onSessionError }: { isSuperAdmin: boolean; onSessionError: (error: unknown) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [more, setMore] = useState<UserItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, error, reload } = useLoader(
    async () => {
      const response = await adminListUsers({ ...(search ? { q: search } : {}), ...(filter !== 'all' ? { status: filter } : {}) });
      setMore([]);
      setCursor(response.nextCursor);
      return response.users;
    },
    onSessionError,
    [search, filter],
  );

  if (selected) {
    return (
      <UserDetail
        id={selected}
        isSuperAdmin={isSuperAdmin}
        onSessionError={onSessionError}
        onBack={() => {
          setSelected(null);
          reload();
        }}
      />
    );
  }

  async function loadMore() {
    if (!cursor) return;
    const response = await adminListUsers({ ...(search ? { q: search } : {}), ...(filter !== 'all' ? { status: filter } : {}), cursor });
    setMore((list) => [...list, ...response.users]);
    setCursor(response.nextCursor);
  }

  const users = data ? [...data, ...more] : null;
  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <SectionTitle note="Everyone who has signed in to Bedo Chat. Messages are never shown here.">Users</SectionTitle>
      <form
        className="flex items-end gap-2"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          setSearch(q.trim());
        }}
      >
        <div className="flex flex-1 flex-col gap-1.5">
          <label htmlFor="users-search" className="text-sm font-medium">
            Search users
          </label>
          <input
            id="users-search"
            value={q}
            placeholder="Phone, name or username"
            onChange={(event) => setQ(event.target.value)}
            className="h-[var(--bedo-control-height)] rounded-sm border border-line bg-surface px-3 text-sm outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-3 focus:ring-accent/15"
          />
        </div>
        <Button type="submit">Search</Button>
      </form>
      <Tabs label="Account status" value={filter} onChange={setFilter} options={[{ id: 'all', label: 'All' }, ...USER_STATUSES.map((status) => ({ id: status, label: STATUS_LABELS[status]! }))]} />
      <FormError message={error} />
      {users === null ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : users.length === 0 ? (
        <p className="text-sm text-ink-secondary">No users found.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface shadow-sm" aria-label="Users">
          {users.map((user) => (
            <li key={user.id}>
              <button type="button" onClick={() => setSelected(user.id)} className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-surface-hover">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{user.name ?? (user.status === 'deleted' ? 'Deleted account' : 'No name')}</p>
                  <p className="truncate text-sm text-ink-secondary">
                    {user.phone ?? '—'}
                    {user.username ? ` · @${user.username}` : ''}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-0.5 text-right text-xs text-ink-secondary">
                  <StatusBadge status={user.status} />
                  <span className="hidden sm:inline">Last seen {formatDateTime(user.lastSeenAt)}</span>
                </div>
                <Icon name="chevron_right" size={20} className="text-ink-secondary" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {cursor ? (
        <Button variant="secondary" className="self-start" onClick={() => void loadMore()}>
          Show more
        </Button>
      ) : null}
    </div>
  );
}

function UserDetail({ id, isSuperAdmin, onBack, onSessionError }: { id: string; isSuperAdmin: boolean; onBack: () => void; onSessionError: (error: unknown) => void }) {
  const { data: detail, setData, error } = useLoader(() => adminGetUser(id), onSessionError, [id]);
  const [done, setDone] = useState<string | null>(null);

  async function act(action: 'suspend' | 'ban' | 'reactivate' | 'end_sessions' | 'delete', reason: string, message: string) {
    try {
      setData(await adminUserAction(id, { action, reason }));
      setDone(message);
    } catch (caught) {
      onSessionError(caught);
      throw caught;
    }
  }

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <BackButton label="All users" onClick={onBack} />
      <FormError message={error} />
      {!detail ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : (
        <>
          <header className="flex flex-col gap-1">
            <h1 className="text-[length:var(--bedo-font-size-xl)] font-semibold">{detail.user.name ?? (detail.user.status === 'deleted' ? 'Deleted account' : 'No name')}</h1>
            <p className="flex items-center gap-2 text-sm text-ink-secondary">
              {detail.user.phone ?? '—'}
              {detail.user.username ? ` · @${detail.user.username}` : ''} · <StatusBadge status={detail.user.status} />
            </p>
          </header>
          {done ? <Notice>{done}</Notice> : null}
          <section className="grid gap-x-6 gap-y-2 rounded-md border border-line bg-surface shadow-sm p-4 text-sm md:grid-cols-2" aria-label="Account">
            <Field label="Joined">{formatDateTime(detail.user.createdAt)}</Field>
            <Field label="Last seen">{formatDateTime(detail.user.lastSeenAt)}</Field>
            <Field label="2-Step Verification">{detail.twoStepEnabled ? 'On' : 'Off'}</Field>
            <Field label="May create">
              {[detail.permissions.createGroups && 'groups', detail.permissions.createChannels && 'channels', detail.permissions.scheduleMessages && 'scheduled messages'].filter(Boolean).join(', ') || 'nothing'}
            </Field>
            <Field label="Groups and channels">
              {detail.counts.groups} groups · {detail.counts.channels} channels
            </Field>
            <Field label="Messages sent">{detail.counts.messagesSent.toLocaleString()}</Field>
            <Field label="Reports">
              {detail.counts.reportsAgainst} about this user · {detail.counts.reportsMade} made
            </Field>
            {detail.deletionRequest ? (
              <Field label="Deletion request">
                {detail.deletionRequest.status}, {formatDateTime(detail.deletionRequest.requestedAt)}
              </Field>
            ) : null}
            {detail.user.bio ? (
              <p className="md:col-span-2">
                <span className="text-ink-secondary">Bio: </span>
                {detail.user.bio}
              </p>
            ) : null}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="font-semibold">Signed-in devices</h2>
            {detail.sessions.length === 0 ? (
              <p className="text-sm text-ink-secondary">None.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface shadow-sm text-sm" aria-label="Signed-in devices">
                {detail.sessions.map((session) => (
                  <li key={session.id} className="px-3 py-2">
                    {session.deviceName ?? 'Unknown device'} ({session.platform}) · {session.ip ?? 'unknown IP'} · signed in {formatDateTime(session.createdAt)} · last active{' '}
                    {formatDateTime(session.lastUsedAt)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="font-semibold">Account history</h2>
            {detail.accountEvents.length === 0 ? (
              <p className="text-sm text-ink-secondary">Nothing recorded.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface shadow-sm text-sm">
                {detail.accountEvents.map((entry, index) => (
                  <li key={`${entry.at}-${index}`} className="grid gap-1 px-3 py-2 md:grid-cols-[180px_200px_1fr]">
                    <span className="text-ink-secondary">{formatDateTime(entry.at)}</span>
                    <span className="font-medium">{entry.event.replaceAll('_', ' ')}</span>
                    <span className="break-words text-ink-secondary">{entry.detail ?? ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {detail.user.status !== 'deleted' ? <UserActions detail={detail} isSuperAdmin={isSuperAdmin} act={act} /> : null}
        </>
      )}
    </div>
  );
}

function UserActions({
  detail,
  isSuperAdmin,
  act,
}: {
  detail: AdminUserDetail;
  isSuperAdmin: boolean;
  act: (action: 'suspend' | 'ban' | 'reactivate' | 'end_sessions' | 'delete', reason: string, message: string) => Promise<void>;
}) {
  const status = detail.user.status;
  const blocked = status === 'suspended' || status === 'banned';
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-6" aria-label="Actions">
      <h2 className="font-semibold">Actions</h2>
      <div className="flex flex-wrap gap-2">
        {!blocked ? (
          <ReasonAction
            id="suspend"
            label="Suspend"
            danger
            confirmText="Suspend this account? The user is signed out on every device and cannot sign in or send until you reactivate it."
            onConfirm={(reason) => act('suspend', reason, 'The account is suspended and every session has ended.')}
          />
        ) : null}
        {isSuperAdmin && status !== 'banned' ? (
          <ReasonAction
            id="ban"
            label="Ban"
            danger
            confirmText="Ban this account? The user is signed out everywhere and cannot sign in. Only a Super Admin can lift a ban."
            onConfirm={(reason) => act('ban', reason, 'The account is banned and every session has ended.')}
          />
        ) : null}
        {blocked && (status === 'suspended' || isSuperAdmin) ? (
          <ReasonAction
            id="reactivate"
            label="Reactivate"
            confirmText="Reactivate this account? The user can sign in again."
            onConfirm={(reason) => act('reactivate', reason, 'The account is active again. The user signs in again on their devices.')}
          />
        ) : null}
        {detail.sessions.length > 0 ? (
          <ReasonAction
            id="end-sessions"
            label="End all sessions"
            confirmText="Sign this user out on every device? They can sign in again with their phone number."
            onConfirm={(reason) => act('end_sessions', reason, 'Every session has ended.')}
          />
        ) : null}
        {isSuperAdmin ? (
          <ReasonAction
            id="delete"
            label="Delete account"
            danger
            confirmText='Delete this account now? It cannot be undone. The number is removed from the academy list, other users see "Deleted account", and the original identity stays in the history.'
            confirmLabel="Delete permanently"
            onConfirm={(reason) => act('delete', reason, 'The account is deleted.')}
          />
        ) : null}
      </div>
      {!isSuperAdmin ? <p className="text-xs text-ink-secondary">Banning and deleting accounts need a Super Admin.</p> : null}
    </section>
  );
}
