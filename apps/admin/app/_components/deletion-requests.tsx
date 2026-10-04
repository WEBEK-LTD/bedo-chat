'use client';

import { adminApproveDeletion, adminDeletionRequest, adminListDeletionRequests, adminRejectDeletion, type DeletionRequestDetail, type DeletionRequestListResponseItemsItem as Item } from '@bedo/api-client';
import { Icon } from '@bedo/ui';
import { useCallback, useEffect, useState } from 'react';
import { errorMessage, formatDateTime } from '../_lib/api';
import { Button, FormError, Notice, TextArea } from './ui';

type Status = 'pending' | 'approved' | 'rejected';

const STATUS_TABS: Array<{ id: Status; label: string }> = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
];

/** Account deletion requests (D-14): review the account and its history, then approve or reject. */
export function DeletionRequests({ canDecide, onSessionError }: { canDecide: boolean; onSessionError: (error: unknown) => void }) {
  const [status, setStatus] = useState<Status>('pending');
  const [items, setItems] = useState<Item[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await adminListDeletionRequests({ status });
      setItems(response.items);
    } catch (caught) {
      onSessionError(caught);
      setError(errorMessage(caught));
    }
  }, [status, onSessionError]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  if (selected) {
    return (
      <RequestDetail
        id={selected}
        canDecide={canDecide}
        onSessionError={onSessionError}
        onBack={() => {
          setSelected(null);
          void load();
        }}
      />
    );
  }

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <h1 className="text-[length:var(--bedo-font-size-xl)] font-semibold">Deletion requests</h1>
      <div className="flex gap-1" role="tablist">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={status === tab.id}
            onClick={() => setStatus(tab.id)}
            className="h-9 rounded-sm px-3 text-sm hover:bg-surface-hover aria-selected:bg-surface-selected aria-selected:font-medium"
          >
            {tab.label}
          </button>
        ))}
      </div>
      <FormError message={error} />
      {items === null ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-ink-secondary">No {status} requests.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
          {items.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => setSelected(item.id)} className="flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-surface-hover">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{item.user.name ?? 'No name'}</p>
                  <p className="truncate text-sm text-ink-secondary">
                    {item.user.phone ?? '—'}
                    {item.user.username ? ` · @${item.user.username}` : ''}
                  </p>
                </div>
                <div className="text-right text-sm text-ink-secondary">
                  <p>Requested {formatDateTime(item.requestedAt)}</p>
                  {item.decidedAt ? <p>Decided {formatDateTime(item.decidedAt)}</p> : null}
                </div>
                <Icon name="chevron_right" size={20} className="text-ink-secondary" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function History({ title, entries }: { title: string; entries: Array<{ at: string; event: string; detail: string | null }> }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-semibold">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-ink-secondary">Nothing recorded.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line text-sm">
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="grid gap-1 px-3 py-2 md:grid-cols-[180px_200px_1fr]">
              <span className="text-ink-secondary">{formatDateTime(entry.at)}</span>
              <span className="font-medium">{entry.event.replaceAll('_', ' ')}</span>
              <span className="break-words text-ink-secondary">{entry.detail ?? ''}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RequestDetail({
  id,
  canDecide,
  onBack,
  onSessionError,
}: {
  id: string;
  canDecide: boolean;
  onBack: () => void;
  onSessionError: (error: unknown) => void;
}) {
  const [detail, setDetail] = useState<DeletionRequestDetail | null>(null);
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminDeletionRequest(id)
      .then(setDetail)
      .catch((caught: unknown) => {
        onSessionError(caught);
        setError(errorMessage(caught));
      });
  }, [id, onSessionError]);

  async function decide(decision: 'approve' | 'reject') {
    setBusy(true);
    setError(null);
    try {
      const body = reason.trim() ? { reason: reason.trim() } : {};
      setDetail(decision === 'approve' ? await adminApproveDeletion(id, body) : await adminRejectDeletion(id, body));
      setConfirming(null);
    } catch (caught) {
      onSessionError(caught);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <button type="button" onClick={onBack} className="flex items-center gap-1 self-start rounded-sm px-2 py-1 text-sm text-ink-secondary hover:bg-surface-hover">
        <Icon name="arrow_back" size={20} />
        All requests
      </button>
      <FormError message={error} />
      {!detail ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : (
        <>
          <header className="flex flex-col gap-1">
            <h1 className="text-[length:var(--bedo-font-size-xl)] font-semibold">{detail.request.user.name ?? 'No name'}</h1>
            <p className="text-sm text-ink-secondary">
              {detail.request.user.phone ?? '—'}
              {detail.request.user.username ? ` · @${detail.request.user.username}` : ''}
            </p>
          </header>

          <section className="grid gap-x-6 gap-y-2 rounded-md border border-line p-4 text-sm md:grid-cols-2">
            <p>
              <span className="text-ink-secondary">Request: </span>
              <span className="font-medium capitalize">{detail.request.status}</span>, sent {formatDateTime(detail.request.requestedAt)}
            </p>
            {detail.request.decidedAt ? (
              <p>
                <span className="text-ink-secondary">Decided: </span>
                {formatDateTime(detail.request.decidedAt)} by {detail.request.decidedBy ?? '—'}
                {detail.request.decisionReason ? ` — “${detail.request.decisionReason}”` : ''}
              </p>
            ) : null}
            <p>
              <span className="text-ink-secondary">Account: </span>
              {detail.account.status.replaceAll('_', ' ')}, created {formatDateTime(detail.account.createdAt)}
            </p>
            <p>
              <span className="text-ink-secondary">2-Step Verification: </span>
              {detail.account.twoStepEnabled ? 'On' : 'Off'}
            </p>
            {detail.account.bio ? (
              <p className="md:col-span-2">
                <span className="text-ink-secondary">Bio: </span>
                {detail.account.bio}
              </p>
            ) : null}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="font-semibold">Active sessions</h3>
            {detail.account.activeSessions.length === 0 ? (
              <p className="text-sm text-ink-secondary">None.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line text-sm">
                {detail.account.activeSessions.map((session, index) => (
                  <li key={index} className="px-3 py-2">
                    {session.deviceName ?? 'Unknown device'} ({session.platform}) · {session.ip ?? 'unknown IP'} · last active{' '}
                    {formatDateTime(session.lastUsedAt)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <History title="Identity history" entries={detail.identityHistory} />
          <History title="Account events" entries={detail.accountEvents} />
          <History title="Security events" entries={detail.securityEvents} />

          {detail.request.status === 'pending' ? (
            canDecide ? (
              <section className="flex flex-col gap-3 border-t border-line pt-6">
                <h2 className="font-semibold">Decision</h2>
                <TextArea id="decision-reason" label="Reason (optional, kept in the audit history)" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
                {confirming ? (
                  <Notice tone="warning">
                    <p>
                      {confirming === 'approve'
                        ? 'Approve and delete this account? The user is signed out everywhere and other users will see "Deleted account". The history is kept.'
                        : 'Reject this request? The account returns to active and the user is informed.'}
                    </p>
                    <div className="mt-3 flex gap-2">
                      <Button variant={confirming === 'approve' ? 'danger' : 'primary'} busy={busy} onClick={() => void decide(confirming)}>
                        {confirming === 'approve' ? 'Approve and delete' : 'Reject request'}
                      </Button>
                      <Button variant="secondary" onClick={() => setConfirming(null)}>
                        Cancel
                      </Button>
                    </div>
                  </Notice>
                ) : (
                  <div className="flex gap-2">
                    <Button variant="danger" onClick={() => setConfirming('approve')}>
                      Approve
                    </Button>
                    <Button variant="secondary" onClick={() => setConfirming('reject')}>
                      Reject
                    </Button>
                  </div>
                )}
              </section>
            ) : (
              <Notice>Your Moderator role can review requests. Approving or rejecting needs a Super Admin.</Notice>
            )
          ) : null}
        </>
      )}
    </div>
  );
}
