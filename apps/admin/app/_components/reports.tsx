'use client';

import { adminDecideReport, adminListReports, type AdminReport } from '@bedo/api-client';
import { ADMIN_CONSOLE_RULES } from '@bedo/contracts';
import { useState } from 'react';
import { errorMessage, formatDateTime } from '../_lib/api';
import { Button, FormError, Notice, TextArea } from './ui';
import { personLabel, SectionTitle, Tabs, useLoader } from './console-ui';

const REASON_LABELS: Record<string, string> = {
  spam: 'Spam',
  harassment: 'Harassment',
  inappropriate_content: 'Inappropriate content',
  other: 'Other',
};

const DECISION_LABELS = {
  dismissed: 'Dismissed',
  message_removed: 'Message removed',
  user_suspended: 'User suspended',
  user_banned: 'User banned',
} as const;
type Decision = keyof typeof DECISION_LABELS;

/**
 * Reported messages (spec §22, O-18): the reported message only (as it was reported and as it is now), never the
 * rest of the conversation. Every admin can dismiss, remove the message for everyone or suspend the user; banning
 * needs a Super Admin. A report is decided once, and the decision is kept.
 */
export function Reports({ isSuperAdmin, onSessionError }: { isSuperAdmin: boolean; onSessionError: (error: unknown) => void }) {
  const [status, setStatus] = useState<'open' | 'decided'>('open');
  const { data, setData, error } = useLoader(async () => (await adminListReports({ status })).reports, onSessionError, [status]);

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <SectionTitle note="Only the reported message is shown, never the rest of the conversation.">Reports</SectionTitle>
      <Tabs
        label="Report status"
        value={status}
        onChange={setStatus}
        options={[
          { id: 'open', label: 'Open' },
          { id: 'decided', label: 'Decided' },
        ]}
      />
      <FormError message={error} />
      {data === null ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : data.length === 0 ? (
        <p className="text-sm text-ink-secondary">{status === 'open' ? 'No open reports.' : 'No decided reports.'}</p>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Reports">
          {data.map((report) => (
            <ReportCard
              key={report.id}
              report={report}
              isSuperAdmin={isSuperAdmin}
              onSessionError={onSessionError}
              onDecided={(next) => setData((list) => (list ?? []).map((item) => (item.id === next.id ? next : item)))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ReportCard({ report, isSuperAdmin, onDecided, onSessionError }: { report: AdminReport; isSuperAdmin: boolean; onDecided: (report: AdminReport) => void; onSessionError: (error: unknown) => void }) {
  const [choice, setChoice] = useState<Decision | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const message = report.message;

  async function decide() {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      onDecided(await adminDecideReport(report.id, { decision: choice, ...(note.trim() ? { note: note.trim() } : {}) }));
      setChoice(null);
    } catch (caught) {
      onSessionError(caught);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const options: Decision[] = ['dismissed', ...(message && !message.deleted ? (['message_removed'] as const) : []), 'user_suspended', ...(isSuperAdmin ? (['user_banned'] as const) : [])];
  return (
    <li className="flex flex-col gap-3 rounded-md border border-line bg-surface shadow-sm p-4 text-sm" aria-label={`Report about ${report.reportedUser.name ?? report.reportedUser.phone ?? 'a user'}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">{REASON_LABELS[report.reason] ?? report.reason}</p>
        <p className="text-xs text-ink-secondary">{formatDateTime(report.createdAt)}</p>
      </div>
      <div className="grid gap-1 md:grid-cols-2">
        <p>
          <span className="text-ink-secondary">Reported user: </span>
          {personLabel(report.reportedUser)}
        </p>
        <p>
          <span className="text-ink-secondary">Reported by: </span>
          {personLabel(report.reporter)}
        </p>
        {report.chat ? (
          <p>
            <span className="text-ink-secondary">In: </span>
            {report.chat.type === 'private' ? 'a private chat' : `${report.chat.type} “${report.chat.title ?? ''}”`}
          </p>
        ) : null}
        {report.otherReports > 0 ? <p className="text-danger">{report.otherReports} other reports about this user</p> : null}
      </div>
      {report.details ? (
        <p>
          <span className="text-ink-secondary">Details: </span>
          {report.details}
        </p>
      ) : null}
      {message ? (
        <figure className="flex flex-col gap-1 rounded-sm bg-surface-subtle p-3">
          <figcaption className="text-xs text-ink-secondary">
            Reported message · sent {formatDateTime(message.sentAt)}
            {message.attachmentKind ? ` · with ${message.attachmentKind}` : ''}
            {message.deleted ? (message.removedByAdmin ? ' · removed by an admin' : ' · deleted by its sender') : ''}
          </figcaption>
          <blockquote className="whitespace-pre-wrap break-words">{message.reportedText ?? (message.kind === 'text' ? '—' : `(${message.kind})`)}</blockquote>
          {!message.deleted && message.currentText !== message.reportedText ? (
            <p className="text-xs text-ink-secondary">Edited since the report: “{message.currentText}”</p>
          ) : null}
        </figure>
      ) : (
        <p className="text-ink-secondary">The report is about the user, not a message.</p>
      )}
      {report.decision ? (
        <Notice>
          <p>
            <span className="font-medium">{DECISION_LABELS[report.decision.decision]}</span> by {report.decision.admin}, {formatDateTime(report.decision.decidedAt)}
            {report.decision.note ? ` — “${report.decision.note}”` : ''}
          </p>
        </Notice>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Decision">
            {options.map((option) => (
              <Button key={option} variant={choice === option ? 'primary' : option === 'dismissed' ? 'secondary' : 'danger'} aria-pressed={choice === option} onClick={() => setChoice(option)}>
                {option === 'dismissed' ? 'Dismiss' : option === 'message_removed' ? 'Remove message' : option === 'user_suspended' ? 'Suspend user' : 'Ban user'}
              </Button>
            ))}
          </div>
          {choice ? (
            <div className="flex flex-col gap-2">
              <p className="text-ink-secondary">
                {choice === 'dismissed'
                  ? 'Close the report without action.'
                  : choice === 'message_removed'
                    ? 'The message is deleted for everyone in the chat. The original stays in the history.'
                    : choice === 'user_suspended'
                      ? 'The user is signed out everywhere and cannot sign in until an admin reactivates the account.'
                      : 'The user is signed out everywhere and banned. Only a Super Admin can lift a ban.'}
              </p>
              <TextArea id={`note-${report.id}`} label="Note (optional, kept with the decision)" maxLength={ADMIN_CONSOLE_RULES.reasonMaxLength} value={note} onChange={(event) => setNote(event.target.value)} />
              <div className="flex gap-2">
                <Button busy={busy} onClick={() => void decide()}>
                  Confirm decision
                </Button>
                <Button variant="secondary" onClick={() => setChoice(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
          <FormError message={error} />
        </div>
      )}
    </li>
  );
}
