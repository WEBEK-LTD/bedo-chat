'use client';

import { adminListBroadcasts, adminListChats, adminSendBroadcast, type AdminChatsResponseChatsItem as ChatItem } from '@bedo/api-client';
import { ADMIN_CONSOLE_RULES } from '@bedo/contracts';
import { type FormEvent, useState } from 'react';
import { errorMessage, formatDateTime } from '../_lib/api';
import { Button, FormError, Notice, TextArea, TextField } from './ui';
import { SectionTitle, Tabs, useLoader } from './console-ui';

/**
 * Broadcast notifications (O-20), Super Admins only: a notification to every user, or to the members of one group
 * or channel, on every signed-in device that allows notifications. It is not a chat message; large audiences are
 * reached in batches over the next minutes.
 */
export function Broadcasts({ onSessionError }: { onSessionError: (error: unknown) => void }) {
  const history = useLoader(async () => (await adminListBroadcasts()).broadcasts, onSessionError, []);
  const [audience, setAudience] = useState<'all' | 'chat'>('all');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [chat, setChat] = useState<ChatItem | null>(null);
  const [chatQuery, setChatQuery] = useState('');
  const [chatResults, setChatResults] = useState<ChatItem[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const ready = title.trim().length > 0 && body.trim().length > 0 && (audience === 'all' || chat !== null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await adminSendBroadcast({ title: title.trim(), body: body.trim(), audience, ...(audience === 'chat' && chat ? { chatId: chat.id } : {}) });
      setDone('The notification is being sent.');
      setTitle('');
      setBody('');
      setConfirming(false);
      history.reload();
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
      setChatResults((await adminListChats({ q: chatQuery.trim() })).chats.filter((item) => !item.deleted));
    } catch (caught) {
      onSessionError(caught);
      setError(errorMessage(caught));
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <SectionTitle note="A notification on people's devices, not a chat message. Only devices that allow notifications receive it.">Broadcast notifications</SectionTitle>
      <section className="flex flex-col gap-3 rounded-md border border-line bg-surface shadow-sm p-4" aria-label="New notification">
        <Tabs
          label="Send to"
          value={audience}
          onChange={(value) => {
            setAudience(value);
            setConfirming(false);
          }}
          options={[
            { id: 'all', label: 'Everyone' },
            { id: 'chat', label: 'One group or channel' },
          ]}
        />
        {audience === 'chat' ? (
          chat ? (
            <p className="flex items-center gap-2 text-sm">
              <span className="text-ink-secondary">Members of:</span> {chat.title} ({chat.memberCount})
              <button type="button" className="text-accent" onClick={() => setChat(null)}>
                Change
              </button>
            </p>
          ) : (
            <form className="flex flex-col gap-2" onSubmit={(event) => void findChats(event)}>
              <div className="flex items-end gap-2">
                <div className="flex flex-1 flex-col gap-1.5">
                  <label htmlFor="broadcast-chat" className="text-sm font-medium">
                    Group or channel
                  </label>
                  <input id="broadcast-chat" value={chatQuery} onChange={(event) => setChatQuery(event.target.value)} className="h-[var(--bedo-control-height)] rounded-sm border border-line bg-surface px-3 text-sm outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-3 focus:ring-accent/15" />
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
                        {item.title} · {item.type} · {item.memberCount}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </form>
          )
        ) : null}
        <TextField id="broadcast-title" label="Title" maxLength={ADMIN_CONSOLE_RULES.broadcastTitleMaxLength} value={title} onChange={(event) => setTitle(event.target.value)} />
        <TextArea id="broadcast-body" label="Text" maxLength={ADMIN_CONSOLE_RULES.broadcastBodyMaxLength} value={body} onChange={(event) => setBody(event.target.value)} />
        {confirming ? (
          <Notice tone="warning">
            <p>{audience === 'all' ? 'Send this notification to every user now? It cannot be taken back.' : `Send this notification to the members of “${chat?.title ?? ''}” now? It cannot be taken back.`}</p>
            <div className="mt-3 flex gap-2">
              <Button busy={busy} onClick={() => void send()}>
                Send now
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </Notice>
        ) : (
          <Button className="self-start" disabled={!ready} onClick={() => setConfirming(true)}>
            Send notification
          </Button>
        )}
        <FormError message={error} />
        {done ? <Notice>{done}</Notice> : null}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Sent</h2>
          <Button variant="ghost" onClick={history.reload}>
            Refresh
          </Button>
        </div>
        <FormError message={history.error} />
        {!history.data ? (
          <p className="text-sm text-ink-secondary">Loading…</p>
        ) : history.data.length === 0 ? (
          <p className="text-sm text-ink-secondary">No notifications sent yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface shadow-sm text-sm" aria-label="Sent notifications">
            {history.data.map((item) => (
              <li key={item.id} className="flex flex-col gap-0.5 px-3 py-2">
                <p className="font-medium">{item.title}</p>
                <p className="whitespace-pre-wrap">{item.body}</p>
                <p className="text-xs text-ink-secondary">
                  {item.audience === 'all' ? 'Everyone' : `Members of ${item.chat?.title ?? 'a deleted chat'}`} · {item.status === 'sent' ? `Sent to ${item.devices} devices` : `Sending… ${item.devices} devices so far`} · by{' '}
                  {item.admin}, {formatDateTime(item.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
