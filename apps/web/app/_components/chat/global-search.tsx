'use client';

import { type Message, type Peer, SEARCH_KINDS, type SearchKind } from '@bedo/contracts';
import { Icon } from '@bedo/ui';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../_lib/api';
import { useMessaging, useMessagingStore } from '../../_lib/messaging/context';
import { MEDIA_LABEL } from '../../_lib/messaging/media';
import { Avatar } from '../ui';
import { chatPhoto, chatTitle, displayName, listTime } from './format';

const KIND_LABELS: Record<SearchKind, string> = { messages: 'Messages', media: 'Photos and videos', files: 'Files', voice: 'Voice' };
const PERIODS = [
  { label: 'Any time', days: null },
  { label: 'Past week', days: 7 },
  { label: 'Past month', days: 31 },
  { label: 'Past year', days: 366 },
] as const;

/** The words of a message, or what it carries. */
function snippet(message: Message): string {
  const media = message.poll ? `📊 ${message.poll.question}` : message.sticker ? `${message.sticker.emoji} Sticker` : message.attachment ? (message.attachment.fileName ?? MEDIA_LABEL[message.attachment.kind]) : null;
  const text = message.text?.replace(/\s+/g, ' ') ?? null;
  return media ? (text ? `${media}, ${text}` : media) : (text ?? '');
}

/**
 * Phase 8: messages, files, images and voice messages in every chat the user is in (D-42), under the chat list's
 * search: the kind, a time period and, when chosen from People, one sender. A result opens its chat at that message.
 */
export function GlobalMessageSearch({
  text,
  from,
  onClearFrom,
  onOpen,
  onNotice,
}: {
  text: string;
  from: Peer | null;
  onClearFrom: () => void;
  onOpen: (message: Message) => void;
  onNotice: (message: string) => void;
}) {
  const store = useMessagingStore();
  const state = useMessaging();
  const [kind, setKind] = useState<SearchKind>('messages');
  const [period, setPeriod] = useState(0);
  const [results, setResults] = useState<Message[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const q = text.trim().replace(/^@/, '');
  const searchable = q.length >= 2 || from !== null || kind !== 'messages';
  const days = PERIODS[period]!.days;

  useEffect(() => {
    if (!searchable) {
      setResults(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      store
        .searchEverywhere({
          ...(q ? { q } : {}),
          kind,
          ...(from ? { fromUserId: from.id } : {}),
          ...(days ? { after: new Date(Date.now() - days * 86_400_000).toISOString() } : {}),
        })
        .then((page) => {
          if (cancelled) return;
          setResults(page.messages);
          setCursor(page.nextCursor);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setResults([]);
          onNotice(errorMessage(error));
        })
        .finally(() => !cancelled && setLoading(false));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, kind, from, days, searchable, store, onNotice]);

  async function more() {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await store.searchEverywhere({
        ...(q ? { q } : {}),
        kind,
        ...(from ? { fromUserId: from.id } : {}),
        ...(days ? { after: new Date(Date.now() - days * 86_400_000).toISOString() } : {}),
        cursor,
      });
      setResults([...(results ?? []), ...page.messages]);
      setCursor(page.nextCursor);
    } catch (error) {
      onNotice(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section aria-label="Messages found" className="border-t border-line">
      <h3 className="px-4 pb-1 pt-3 text-xs font-medium uppercase text-ink-secondary">Messages</h3>
      <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2" role="group" aria-label="Search filters">
        {SEARCH_KINDS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={kind === option}
            onClick={() => setKind(option)}
            className={`h-7 rounded-full border px-2.5 text-xs ${kind === option ? 'border-accent bg-surface-selected text-accent' : 'border-line text-ink-secondary hover:bg-surface-hover'}`}
          >
            {KIND_LABELS[option]}
          </button>
        ))}
        <label className="sr-only" htmlFor="search-period">
          When
        </label>
        <select
          id="search-period"
          value={period}
          onChange={(event) => setPeriod(Number(event.target.value))}
          className="h-7 rounded-full border border-line bg-surface px-2 text-xs text-ink-secondary"
        >
          {PERIODS.map((option, index) => (
            <option key={option.label} value={index}>
              {option.label}
            </option>
          ))}
        </select>
        {from ? (
          <span className="flex h-7 items-center gap-1 rounded-full bg-surface-selected pl-2.5 pr-1 text-xs text-accent">
            From {displayName(from)}
            <button type="button" aria-label="Any sender" onClick={onClearFrom} className="grid size-5 place-items-center rounded-full hover:bg-surface-hover">
              <Icon name="close" size={14} />
            </button>
          </span>
        ) : null}
      </div>
      {!searchable ? <p className="px-4 pb-3 text-sm text-ink-secondary">Type at least 2 characters to search messages.</p> : null}
      {searchable && loading && results === null ? <p className="px-4 pb-3 text-sm text-ink-secondary">Searching…</p> : null}
      {searchable && results?.length === 0 ? <p className="px-4 pb-3 text-sm text-ink-secondary">No messages found.</p> : null}
      <ul>
        {(results ?? []).map((message) => {
          const chat = state.chats[message.chatId];
          if (!chat) return null;
          const who = message.sender && chat.type !== 'private' ? `${message.sender.displayName.split(' ')[0]}: ` : '';
          return (
            <li key={message.id}>
              <button type="button" onClick={() => onOpen(message)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-hover">
                <Avatar name={chatTitle(chat)} photoUrl={chatPhoto(chat)} size={44} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{chatTitle(chat)}</span>
                    <span className="shrink-0 text-xs text-ink-secondary">{listTime(message.createdAt)}</span>
                  </span>
                  <span className="block truncate text-sm text-ink-secondary">
                    {who}
                    {snippet(message)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {cursor ? (
        <button type="button" disabled={loading} onClick={() => void more()} className="w-full px-4 py-2 text-left text-sm text-accent disabled:opacity-50">
          Show more
        </button>
      ) : null}
    </section>
  );
}
