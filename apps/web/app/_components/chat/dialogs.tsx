'use client';

import { type Chat, MESSAGING_RULES, REPORT_REASONS } from '@bedo/contracts';
import { Icon } from '@bedo/ui';
import { useState } from 'react';
import { errorMessage } from '../../_lib/api';
import { useMessaging, useMessagingStore } from '../../_lib/messaging/context';
import { Avatar, Button, FormError, TextField } from '../ui';
import { canPost, chatPhoto, chatTitle } from './format';
import { Dialog } from './menu';

/** Folders (P-21): up to 10, names of 1-12 characters, chats chosen by hand. */
export function FoldersDialog({ chats, onClose, onNotice }: { chats: Chat[]; onClose: () => void; onNotice: (message: string) => void }) {
  const state = useMessaging();
  const store = useMessagingStore();
  const [editing, setEditing] = useState<{ id: string | null; name: string; chatIds: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      const name = editing.name.trim();
      if (editing.id) await store.updateFolder(editing.id, { name, chatIds: editing.chatIds });
      else await store.createFolder(name, editing.chatIds);
      setEditing(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <Dialog title={editing.id ? 'Edit folder' : 'New folder'} onClose={onClose}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <TextField
            id="folder-name"
            label="Folder name"
            value={editing.name}
            maxLength={MESSAGING_RULES.folderNameMaxLength}
            onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            hint={`Up to ${MESSAGING_RULES.folderNameMaxLength} characters.`}
            autoFocus
          />
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm font-medium">Chats</legend>
            {chats.length === 0 ? <p className="text-sm text-ink-secondary">No chats yet.</p> : null}
            {chats.map((chat) => {
              const checked = editing.chatIds.includes(chat.id);
              return (
                <label key={chat.id} className="flex items-center gap-3 rounded-sm px-1 py-1 hover:bg-surface-hover">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => setEditing({ ...editing, chatIds: checked ? editing.chatIds.filter((id) => id !== chat.id) : [...editing.chatIds, chat.id] })}
                  />
                  <Avatar name={chatTitle(chat)} photoUrl={chatPhoto(chat)} size={32} />
                  <span className="truncate text-sm">{chatTitle(chat)}</span>
                </label>
              );
            })}
          </fieldset>
          <FormError message={error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(null)}>
              Back
            </Button>
            <Button type="submit" busy={busy} disabled={editing.name.trim().length === 0}>
              Save
            </Button>
          </div>
        </form>
      </Dialog>
    );
  }

  return (
    <Dialog title="Folders" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {state.folders.length === 0 ? <p className="text-sm text-ink-secondary">No folders yet.</p> : null}
        <ul className="flex flex-col">
          {state.folders.map((folder) => (
            <li key={folder.id} className="flex items-center gap-2 border-b border-line py-2">
              <Icon name="folder" size={20} className="text-ink-secondary" />
              <span className="min-w-0 flex-1 truncate">{folder.name}</span>
              <span className="text-xs text-ink-secondary">{folder.chatIds.length}</span>
              <button type="button" aria-label={`Edit ${folder.name}`} onClick={() => setEditing({ id: folder.id, name: folder.name, chatIds: folder.chatIds })} className="grid size-8 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink">
                <Icon name="edit" size={18} />
              </button>
              <button
                type="button"
                aria-label={`Delete ${folder.name}`}
                onClick={() => void store.deleteFolder(folder.id).catch((caught: unknown) => onNotice(errorMessage(caught)))}
                className="grid size-8 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink"
              >
                <Icon name="delete" size={18} />
              </button>
            </li>
          ))}
        </ul>
        <Button variant="secondary" disabled={state.folders.length >= MESSAGING_RULES.maxFolders} onClick={() => setEditing({ id: null, name: '', chatIds: [] })}>
          New folder
        </Button>
        {state.folders.length >= MESSAGING_RULES.maxFolders ? <p className="text-sm text-ink-secondary">You can have up to {MESSAGING_RULES.maxFolders} folders.</p> : null}
      </div>
    </Dialog>
  );
}

/** Forward selected messages to up to 10 chats (P-23). */
export function ForwardDialog({ fromChatId, messageIds, onClose, onDone }: { fromChatId: string; messageIds: string[]; onClose: () => void; onDone: (message: string) => void }) {
  const state = useMessaging();
  const store = useMessagingStore();
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chats = Object.values(state.chats).filter((chat) => canPost(chat));
  // D-30: every forwarded copy counts towards 30 messages per minute.
  const maxChats = Math.min(MESSAGING_RULES.maxForwardTargets, Math.floor(MESSAGING_RULES.messagesPerMinute / messageIds.length));

  async function forward() {
    setBusy(true);
    setError(null);
    try {
      await store.forward(fromChatId, messageIds, selected);
      onDone(selected.length === 1 ? 'Forwarded.' : `Forwarded to ${selected.length} chats.`);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <Dialog title="Forward to" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {maxChats === 0 ? (
          <p className="text-sm text-danger">
            You can send up to {MESSAGING_RULES.messagesPerMinute} messages a minute, including forwarded ones. Select fewer messages to forward.
          </p>
        ) : (
          <p className="text-sm text-ink-secondary">
            Choose up to {maxChats} {maxChats === 1 ? 'chat' : 'chats'}
            {maxChats < MESSAGING_RULES.maxForwardTargets ? ` (each chat gets ${messageIds.length} messages, and you can send up to ${MESSAGING_RULES.messagesPerMinute} a minute)` : ''}.
          </p>
        )}
        <ul className="flex flex-col">
          {chats.map((chat) => {
            const checked = selected.includes(chat.id);
            const full = !checked && selected.length >= maxChats;
            return (
              <li key={chat.id}>
                <label className={`flex items-center gap-3 rounded-sm px-1 py-1.5 ${full ? 'opacity-50' : 'hover:bg-surface-hover'}`}>
                  <input type="checkbox" checked={checked} disabled={full} onChange={() => setSelected(checked ? selected.filter((id) => id !== chat.id) : [...selected, chat.id])} />
                  <Avatar name={chatTitle(chat)} photoUrl={chatPhoto(chat)} size={32} />
                  <span className="truncate text-sm">{chatTitle(chat)}</span>
                </label>
              </li>
            );
          })}
        </ul>
        <FormError message={error} />
        <Button busy={busy} disabled={selected.length === 0} onClick={() => void forward()}>
          Forward
        </Button>
      </div>
    </Dialog>
  );
}

const REASON_LABELS: Record<(typeof REPORT_REASONS)[number], string> = {
  spam: 'Spam',
  harassment: 'Harassment',
  inappropriate_content: 'Inappropriate content',
  other: 'Other',
};

/** Report a user or one of their messages (P-27). */
export function ReportDialog({ userId, messageId, onClose, onDone }: { userId: string; messageId?: string; onClose: () => void; onDone: (message: string) => void }) {
  const store = useMessagingStore();
  const [reason, setReason] = useState<(typeof REPORT_REASONS)[number] | null>(null);
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!reason) return;
    setBusy(true);
    setError(null);
    try {
      await store.report({ userId, reason, ...(messageId ? { messageId } : {}), ...(details.trim() ? { details: details.trim() } : {}) });
      onDone('Report sent. Thank you.');
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }

  return (
    <Dialog title={messageId ? 'Report message' : 'Report user'} onClose={onClose}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">Reason</legend>
          {REPORT_REASONS.map((value) => (
            <label key={value} className="flex items-center gap-3 rounded-sm px-1 py-1.5 hover:bg-surface-hover">
              <input type="radio" name="reason" value={value} checked={reason === value} onChange={() => setReason(value)} />
              <span className="text-sm">{REASON_LABELS[value]}</span>
            </label>
          ))}
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="report-details" className="text-sm font-medium">
            Details (optional)
          </label>
          <textarea
            id="report-details"
            value={details}
            maxLength={MESSAGING_RULES.reportDetailsMaxLength}
            onChange={(event) => setDetails(event.target.value)}
            rows={3}
            className="rounded-sm border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
          />
          <p className="text-xs text-ink-secondary">
            {details.length}/{MESSAGING_RULES.reportDetailsMaxLength}
          </p>
        </div>
        <FormError message={error} />
        <Button type="submit" busy={busy} disabled={!reason}>
          Send report
        </Button>
      </form>
    </Dialog>
  );
}

/** Delete selected messages: for me (always), or for both sides (only one's own messages, P-29). */
export function DeleteDialog({ count, canDeleteForBoth, onDelete, onClose }: { count: number; canDeleteForBoth: boolean; onDelete: (scope: 'me' | 'both') => Promise<void>; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(scope: 'me' | 'both') {
    setBusy(true);
    setError(null);
    try {
      await onDelete(scope);
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
    }
  }
  return (
    <Dialog title={count === 1 ? 'Delete message' : `Delete ${count} messages`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink-secondary">{canDeleteForBoth ? 'Delete for you only, or for both of you?' : 'This deletes the messages for you only.'}</p>
        <FormError message={error} />
        <Button variant="danger" busy={busy} onClick={() => void run('me')}>
          Delete for me
        </Button>
        {canDeleteForBoth ? (
          <Button variant="danger" busy={busy} onClick={() => void run('both')}>
            Delete for both
          </Button>
        ) : null}
      </div>
    </Dialog>
  );
}
