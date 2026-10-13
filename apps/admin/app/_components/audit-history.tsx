'use client';

import { adminAuditHistory, type AdminAuditResponseEntriesItem as Entry, type AdminChatsResponseChatsItem as ChatItem, adminListChats, type AdminUsersResponseUsersItem as UserItem } from '@bedo/api-client';
import { ADMIN_CONSOLE_RULES, type AuditKind } from '@bedo/contracts';
import { type FormEvent, useState } from 'react';
import { errorMessage, formatDateTime } from '../_lib/api';
import { Button, FormError, Notice, TextArea } from './ui';
import { personLabel, SectionTitle, UserPicker } from './console-ui';

const KINDS: Array<{ id: AuditKind; label: string; needs: 'user' | 'user-or-chat' | 'optional' }> = [
  { id: 'messages', label: 'Message edits and deletions', needs: 'user-or-chat' },
  { id: 'identity', label: 'Name, username, phone and photo changes', needs: 'user' },
  { id: 'membership', label: 'Joins, removals and role changes', needs: 'user-or-chat' },
  { id: 'account', label: 'Account events', needs: 'user' },
  { id: 'security', label: 'Sign-ins and security events', needs: 'user' },
  { id: 'screenshots', label: 'Screenshot events', needs: 'user-or-chat' },
  { id: 'admin', label: 'Admin actions', needs: 'optional' },
];

/**
 * The permanent history for investigations (D-17, D-18), Super Admins only. A person or a chat is named and a
 * reason given; every view is itself recorded in the admin history with that reason.
 */
export function AuditHistory({ onSessionError }: { onSessionError: (error: unknown) => void }) {
  const [kind, setKind] = useState<AuditKind>('messages');
  const [user, setUser] = useState<UserItem | null>(null);
  const [chat, setChat] = useState<ChatItem | null>(null);
  const [chatQuery, setChatQuery] = useState('');
  const [chatResults, setChatResults] = useState<ChatItem[]>([]);
  const [reason, setReason] = useState('');
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needs = KINDS.find((item) => item.id === kind)!.needs;
  const ready = reason.trim().length >= ADMIN_CONSOLE_RULES.reasonMinLength && (needs === 'optional' || (needs === 'user' ? user !== null : user !== null || chat !== null));

  async function load(next: string | null) {
    setBusy(true);
    setError(null);
    try {
      const response = await adminAuditHistory({
        kind,
        reason: reason.trim(),
        ...(user ? { userId: user.id } : {}),
        ...(chat && needs !== 'user' ? { chatId: chat.id } : {}),
        ...(next ? { cursor: next } : {}),
      });
      setEntries((list) => (next && list ? [...list, ...response.entries] : response.entries));
      setCursor(response.nextCursor);
    } catch (caught) {
      onSessionError(caught);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function findChats(event: FormEvent) {
    event.preventDefault();
    try {
      setChatResults((await adminListChats({ q: chatQuery.trim() })).chats);
    } catch (caught) {
      onSessionError(caught);
      setError(errorMessage(caught));
    }
  }

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <SectionTitle note="For investigations. Every view is recorded in the admin history with your reason.">Audit history</SectionTitle>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="audit-kind" className="text-sm font-medium">
          History
        </label>
        <select
          id="audit-kind"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as AuditKind);
            setEntries(null);
          }}
          className="h-[var(--bedo-control-height)] rounded-sm border border-line bg-surface px-3 text-sm outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-3 focus:ring-accent/15"
        >
          {KINDS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </div>
      {user ? (
        <p className="flex items-center gap-2 text-sm">
          <span className="text-ink-secondary">Person:</span> {personLabel(user)}
          <button type="button" className="text-accent" onClick={() => setUser(null)}>
            Change
          </button>
        </p>
      ) : (
        <UserPicker id="audit-user" label={needs === 'user' ? 'Person' : 'Person (optional if a chat is chosen)'} onPick={setUser} />
      )}
      {needs !== 'user' ? (
        chat ? (
          <p className="flex items-center gap-2 text-sm">
            <span className="text-ink-secondary">Group or channel:</span> {chat.title}
            <button type="button" className="text-accent" onClick={() => setChat(null)}>
              Change
            </button>
          </p>
        ) : (
          <form className="flex flex-col gap-2" onSubmit={(event) => void findChats(event)}>
            <div className="flex items-end gap-2">
              <div className="flex flex-1 flex-col gap-1.5">
                <label htmlFor="audit-chat" className="text-sm font-medium">
                  Group or channel (optional)
                </label>
                <input id="audit-chat" value={chatQuery} onChange={(event) => setChatQuery(event.target.value)} className="h-[var(--bedo-control-height)] rounded-sm border border-line bg-surface px-3 text-sm outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-3 focus:ring-accent/15" />
              </div>
              <Button type="submit" variant="secondary">
                Find
              </Button>
            </div>
            {chatResults.length > 0 ? (
              <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface shadow-sm text-sm">
                {chatResults.slice(0, 8).map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left hover:bg-surface-hover"
                      onClick={() => {
                        setChat(item);
                        setChatResults([]);
                      }}
                    >
                      {item.title} · {item.type}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </form>
        )
      ) : null}
      <TextArea id="audit-reason" label="Reason for looking (recorded)" maxLength={ADMIN_CONSOLE_RULES.reasonMaxLength} value={reason} onChange={(event) => setReason(event.target.value)} />
      <Button className="self-start" busy={busy} disabled={!ready} onClick={() => void load(null)}>
        Show history
      </Button>
      <FormError message={error} />
      {entries === null ? null : entries.length === 0 ? (
        <Notice>Nothing recorded.</Notice>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface shadow-sm text-sm" aria-label="History entries">
          {entries.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className="grid gap-1 px-3 py-2 md:grid-cols-[170px_190px_1fr]">
              <span className="text-ink-secondary">{formatDateTime(entry.at)}</span>
              <span className="font-medium">{entry.event}</span>
              <span className="flex flex-col gap-0.5 break-words">
                {entry.actor ? <span className="text-xs text-ink-secondary">By {entry.actor}</span> : null}
                {entry.subject ? <span className="text-xs text-ink-secondary">About {entry.subject}</span> : null}
                {entry.detail ? <span className="whitespace-pre-wrap">{entry.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {cursor ? (
        <Button variant="secondary" className="self-start" busy={busy} onClick={() => void load(cursor)}>
          Show more
        </Button>
      ) : null}
    </div>
  );
}
