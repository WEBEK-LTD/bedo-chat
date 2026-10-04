'use client';

import { type Chat, MESSAGING_RULES, type Peer } from '@bedo/contracts';
import { Icon } from '@bedo/ui';
import { useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../../_lib/api';
import { useMessaging, useMessagingStore } from '../../_lib/messaging/context';
import { sortedChats } from '../../_lib/messaging/store';
import { Avatar } from '../ui';
import { FoldersDialog } from './dialogs';
import { displayName, listTime, preview } from './format';
import { ActionMenu, type MenuItem } from './menu';

type Tab = { kind: 'all' } | { kind: 'folder'; id: string } | { kind: 'archived' };

/**
 * The chat list (step 3.6): pinned chats first, archived chats in their own list (they stay archived when
 * new messages arrive, P-19), unread counts (P-20), folder tabs (P-21), and people search to start a chat
 * (P-25, at least 3 characters).
 */
export function ChatList({
  myId,
  query,
  selectedId,
  onSelect,
  onNotice,
}: {
  myId: string;
  query: string;
  selectedId: string | null;
  onSelect: (chatId: string) => void;
  onNotice: (message: string) => void;
}) {
  const state = useMessaging();
  const store = useMessagingStore();
  const [tab, setTab] = useState<Tab>({ kind: 'all' });
  const [editingFolders, setEditingFolders] = useState(false);
  const [people, setPeople] = useState<Peer[] | null>(null);
  const [searching, setSearching] = useState(false);

  const chats = useMemo(() => sortedChats(Object.values(state.chats)), [state.chats]);
  const archivedCount = chats.filter((chat) => chat.archived).length;
  const folder = tab.kind === 'folder' ? state.folders.find((item) => item.id === tab.id) : undefined;
  useEffect(() => {
    if (tab.kind === 'folder' && !folder) setTab({ kind: 'all' });
    if (tab.kind === 'archived' && archivedCount === 0) setTab({ kind: 'all' });
  }, [tab, folder, archivedCount]);

  const text = query.trim();
  const term = text.replace(/^@/, '').toLowerCase();
  useEffect(() => {
    if (text.replace(/^@/, '').length < MESSAGING_RULES.userSearchMinLength) {
      setPeople(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      store
        .searchPeople(text)
        .then((users) => !cancelled && setPeople(users))
        .catch(() => !cancelled && setPeople([]))
        .finally(() => !cancelled && setSearching(false));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, store]);

  async function startWith(peer: Peer) {
    try {
      const chat = await store.startChatWith(peer.id);
      onSelect(chat.id);
    } catch (error) {
      onNotice(errorMessage(error));
    }
  }

  if (text.length > 0) {
    const matches = chats.filter((chat) => {
      const name = displayName(chat.peer).toLowerCase();
      return name.includes(term) || (chat.peer.username ?? '').toLowerCase().includes(term);
    });
    const known = new Set(matches.map((chat) => chat.peer.id));
    const others = (people ?? []).filter((peer) => !known.has(peer.id));
    return (
      <div className="min-h-0 flex-1 overflow-y-auto" aria-label="Search results">
        {matches.length > 0 ? <SectionTitle>Chats</SectionTitle> : null}
        <ul>
          {matches.map((chat) => (
            <ChatRow key={chat.id} chat={chat} myId={myId} selected={chat.id === selectedId} onSelect={onSelect} onNotice={onNotice} />
          ))}
        </ul>
        {text.replace(/^@/, '').length < MESSAGING_RULES.userSearchMinLength ? (
          <p className="px-4 py-3 text-sm text-ink-secondary">Type at least 3 characters to find people.</p>
        ) : (
          <>
            <SectionTitle>People</SectionTitle>
            {searching && people === null ? <p className="px-4 py-2 text-sm text-ink-secondary">Searching…</p> : null}
            {people !== null && others.length === 0 ? <p className="px-4 py-2 text-sm text-ink-secondary">No people found.</p> : null}
            <ul>
              {others.map((peer) => (
                <li key={peer.id}>
                  <button type="button" onClick={() => void startWith(peer)} className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-hover">
                    <Avatar name={peer.displayName} photoUrl={peer.photoUrl} size={44} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{displayName(peer)}</span>
                      <span className="block truncate text-sm text-ink-secondary">{peer.username ? `@${peer.username}` : (peer.phone ?? '')}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  const visible = chats.filter((chat) => {
    if (tab.kind === 'archived') return chat.archived;
    if (chat.archived) return false;
    if (tab.kind === 'folder') return folder?.chatIds.includes(chat.id) ?? false;
    return true;
  });

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2" role="tablist" aria-label="Folders">
        <TabButton active={tab.kind === 'all'} onClick={() => setTab({ kind: 'all' })}>
          All chats
        </TabButton>
        {state.folders.map((item) => (
          <TabButton key={item.id} active={tab.kind === 'folder' && tab.id === item.id} onClick={() => setTab({ kind: 'folder', id: item.id })}>
            {item.name}
          </TabButton>
        ))}
        <button
          type="button"
          aria-label="Edit folders"
          onClick={() => setEditingFolders(true)}
          className="ml-auto grid size-8 shrink-0 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover"
        >
          <Icon name="create_new_folder" size={20} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab.kind === 'archived' ? (
          <button type="button" onClick={() => setTab({ kind: 'all' })} className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-accent hover:bg-surface-hover">
            <Icon name="arrow_back" size={20} />
            Archived chats
          </button>
        ) : archivedCount > 0 && tab.kind === 'all' ? (
          <button type="button" onClick={() => setTab({ kind: 'archived' })} className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-ink-secondary hover:bg-surface-hover">
            <Icon name="archive" size={20} />
            <span className="flex-1">Archived chats</span>
            <span>{archivedCount}</span>
          </button>
        ) : null}
        {state.status === 'loading' ? (
          <p className="px-6 py-8 text-center text-sm text-ink-secondary">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-ink-secondary">{tab.kind === 'folder' ? 'No chats in this folder.' : 'No chats yet.'}</p>
        ) : (
          <ul aria-label="Chats">
            {visible.map((chat) => (
              <ChatRow key={chat.id} chat={chat} myId={myId} selected={chat.id === selectedId} onSelect={onSelect} onNotice={onNotice} />
            ))}
          </ul>
        )}
      </div>
      {editingFolders ? <FoldersDialog chats={chats} onClose={() => setEditingFolders(false)} onNotice={onNotice} /> : null}
    </>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="px-4 pb-1 pt-3 text-xs font-medium uppercase text-ink-secondary">{children}</h3>;
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`shrink-0 border-b-2 px-3 py-2 text-sm ${active ? 'border-accent font-medium text-accent' : 'border-transparent text-ink-secondary hover:text-ink'}`}
    >
      {children}
    </button>
  );
}

function ChatRow({ chat, myId, selected, onSelect, onNotice }: { chat: Chat; myId: string; selected: boolean; onSelect: (chatId: string) => void; onNotice: (message: string) => void }) {
  const store = useMessagingStore();
  const state = useMessaging();
  const unread = chat.unreadCount > 0 || chat.markedUnread;
  const act = (action: () => Promise<void>) => () => void action().catch((error: unknown) => onNotice(errorMessage(error)));
  const items: MenuItem[] = [
    { label: chat.pinned ? 'Unpin' : 'Pin', icon: chat.pinned ? 'keep_off' : 'keep', onSelect: act(() => store.setChatState(chat.id, { pinned: !chat.pinned })) },
    { label: chat.archived ? 'Unarchive' : 'Archive', icon: chat.archived ? 'unarchive' : 'archive', onSelect: act(() => store.setChatState(chat.id, { archived: !chat.archived })) },
    unread
      ? { label: 'Mark as read', icon: 'mark_chat_read', onSelect: act(() => store.markRead(chat.id)) }
      : { label: 'Mark as unread', icon: 'mark_chat_unread', onSelect: act(() => store.setChatState(chat.id, { unread: true })) },
    ...state.folders.map((folder) => {
      const inFolder = folder.chatIds.includes(chat.id);
      return {
        label: `${inFolder ? 'Remove from' : 'Add to'} ${folder.name}`,
        icon: 'folder' as const,
        onSelect: act(() =>
          store.updateFolder(folder.id, { chatIds: inFolder ? folder.chatIds.filter((id) => id !== chat.id) : [...folder.chatIds, chat.id] }),
        ),
      };
    }),
  ];
  return (
    <li className={`group flex items-center ${selected ? 'bg-surface-selected' : 'hover:bg-surface-hover'}`}>
      <button type="button" onClick={() => onSelect(chat.id)} className="flex min-w-0 flex-1 items-center gap-3 py-2 pl-3 text-left" aria-current={selected || undefined}>
        <Avatar name={chat.peer.displayName} photoUrl={chat.peer.photoUrl} size={48} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-medium">{displayName(chat.peer)}</span>
            <span className="shrink-0 text-xs text-ink-secondary">{listTime(chat.lastMessageAt)}</span>
          </span>
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm text-ink-secondary">{state.typing[chat.id] ? 'typing…' : preview(chat, myId)}</span>
            {chat.pinned ? <Icon name="keep" size={16} className="shrink-0 text-ink-secondary" title="Pinned" /> : null}
            {chat.unreadCount > 0 ? (
              <span className="min-w-5 shrink-0 rounded-full bg-accent px-1.5 text-center text-xs font-medium text-on-accent" aria-label={`${chat.unreadCount} unread`}>
                {chat.unreadCount >= 1000 ? '999+' : chat.unreadCount}
              </span>
            ) : chat.markedUnread ? (
              <span className="size-3 shrink-0 rounded-full bg-accent" aria-label="Marked as unread" />
            ) : null}
          </span>
        </span>
      </button>
      <div className="px-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
        <ActionMenu label={`Actions for ${displayName(chat.peer)}`} items={items} />
      </div>
    </li>
  );
}
