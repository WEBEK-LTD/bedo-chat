'use client';

import { type Chat, type Message, MESSAGING_RULES } from '@bedo/contracts';
import { Icon } from '@bedo/ui';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../../_lib/api';
import { useMessaging, useMessagingStore } from '../../_lib/messaging/context';
import { formatBytes, formatDuration, MEDIA_LABEL, prepareFile, type PreparedFile, prepareRecording, Recorder } from '../../_lib/messaging/media';
import { presenceOf } from '../../_lib/messaging/store';
import { Avatar, Button } from '../ui';
import { DeleteDialog, ForwardDialog, ReportDialog } from './dialogs';
import { canPost, chatPhoto, chatTitle, dayLabel, displayName, groupSubtitle, isMuted, presenceText } from './format';
import { FOREVER } from './chat-list';
import { GroupInfoPanel, PollComposer } from './groups';
import { ActionMenu, type MenuItem } from './menu';
import { ExpressionPicker, MediaPanel, MediaViewer, PendingUploadItem } from './media';
import { MessageItem, PendingItem } from './message-item';
import { ScheduledPanel, ScheduleDialog, scheduleLabel } from './scheduled';

/** P-24: the device's share sheet where available, otherwise the text is copied. */
export async function shareText(text: string): Promise<'shared' | 'copied'> {
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'shared';
    }
  }
  await navigator.clipboard.writeText(text);
  return 'copied';
}

type Mode = { kind: 'normal' } | { kind: 'reply'; message: Message } | { kind: 'edit'; message: Message };

/**
 * One private chat (steps 3.3-3.8 in the web app): history with older pages on scroll, the composer, replies,
 * edits, message actions, multi-select (up to 100), pinned messages, in-chat search, typing and presence,
 * block and report.
 */
export function ChatView({
  chat,
  myId,
  jump = null,
  onJumped,
  onBack,
  onNotice,
}: {
  chat: Chat;
  myId: string;
  /** Phase 8: a message to scroll to (a search result). */
  jump?: { id: string; seq: number } | null;
  onJumped?: () => void;
  onBack: () => void;
  onNotice: (message: string) => void;
}) {
  const state = useMessaging();
  const store = useMessagingStore();
  const messages = useMemo(() => state.messages[chat.id] ?? [], [state.messages, chat.id]);
  const pending = state.outbox.filter((item) => item.chatId === chat.id);
  const uploads = state.uploads.filter((item) => item.chatId === chat.id);
  const [viewer, setViewer] = useState<Message | null>(null);
  const [mediaPanel, setMediaPanel] = useState(false);
  const pins = state.pins[chat.id] ?? [];
  const [mode, setMode] = useState<Mode>({ kind: 'normal' });
  const [selected, setSelected] = useState<string[] | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: 'forward'; ids: string[] }
    | { kind: 'delete'; ids: string[] }
    | { kind: 'report'; userId: string; messageId?: string }
    | { kind: 'peer' }
    | { kind: 'info' }
    | { kind: 'poll' }
    | { kind: 'scheduled' }
    | null
  >(null);
  /** The in-chat search, open with its starting words (a tapped #hashtag), or closed. */
  const [searchOpen, setSearchOpen] = useState<string | null>(null);
  const [pinIndex, setPinIndex] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const peer = chat.peer;
  const group = chat.group;
  const channel = chat.type === 'channel';
  // Phase 6: channel admins who post schedule posts; elsewhere the system permission "schedule messages" (O-21).
  const [scheduleAllowed, setScheduleAllowed] = useState(false);
  useEffect(() => {
    void store
      .myPermissions()
      .then((permissions) => setScheduleAllowed(permissions.scheduleMessages))
      .catch(() => undefined);
  }, [store]);
  const maySchedule = canPost(chat) && (channel || scheduleAllowed);
  const typing = (state.typing[chat.id] ?? 0) > Date.now();
  const typingName = state.typingNames[chat.id] ?? null;
  const status = group
    ? typing
      ? `${typingName ?? 'someone'} is typing…`
      : groupSubtitle(chat)
    : typing
      ? 'typing…'
      : peer
        ? presenceText(presenceOf(state, peer))
        : '';

  useEffect(() => {
    setMode({ kind: 'normal' });
    setSelected(null);
    setSearchOpen(null);
    setPinIndex(0);
    atBottom.current = true;
    void store.openChat(chat.id).catch((error: unknown) => onNotice(errorMessage(error)));
    // The peer's presence and privacy can change while the chat is open; refresh it every minute.
    const timer = setInterval(() => void store.refreshChat(chat.id).catch(() => undefined), 60_000);
    return () => clearInterval(timer);
  }, [chat.id, store, onNotice]);

  // Mark as read while the newest messages are on screen and the page is visible (P-20).
  const lastSeq = chat.lastSeq;
  const readSeq = chat.readSeq;
  useEffect(() => {
    if (atBottom.current && document.visibilityState === 'visible' && (lastSeq > readSeq || chat.markedUnread)) {
      void store.markRead(chat.id).catch(() => undefined);
    }
  }, [chat.id, lastSeq, readSeq, chat.markedUnread, store, messages.length]);
  // Phase 7: while this chat is on screen this device is not pushed about it (D-41).
  useEffect(() => {
    const report = (force = false) => store.viewing(document.visibilityState === 'visible' ? chat.id : null, force);
    report(true);
    const onVisibility = () => report();
    document.addEventListener('visibilitychange', onVisibility);
    const timer = setInterval(() => report(true), 45_000);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      store.viewing(null);
    };
  }, [chat.id, store]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && atBottom.current) void store.markRead(chat.id).catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [chat.id, store]);

  // Keep the view at the newest message when it was already there.
  const count = messages.length + pending.length + uploads.length;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [count, chat.id]);

  const onScroll = useCallback(async () => {
    const element = scroller.current;
    if (!element) return;
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    setShowJump(!atBottom.current);
    if (atBottom.current) void store.markRead(chat.id).catch(() => undefined);
    if (element.scrollTop < 120 && !loadingOlder && state.hasOlder[chat.id]) {
      setLoadingOlder(true);
      const before = element.scrollHeight;
      try {
        await store.loadOlder(chat.id);
        // Keep the same messages on screen after older ones are added above.
        requestAnimationFrame(() => {
          if (scroller.current) scroller.current.scrollTop += scroller.current.scrollHeight - before;
        });
      } catch {
        // Retried on the next scroll.
      } finally {
        setLoadingOlder(false);
      }
    }
  }, [chat.id, store, loadingOlder, state.hasOlder]);

  function scrollToMessage(id: string) {
    const element = document.getElementById(`message-${id}`);
    if (element) {
      element.scrollIntoView({ block: 'center' });
      element.classList.add('bg-surface-selected');
      setTimeout(() => element.classList.remove('bg-surface-selected'), 1500);
      return true;
    }
    return false;
  }

  /** Scrolls to a message, loading older pages until it is loaded (bounded); `seq` stops the search early. */
  async function jumpTo(message: { id: string; seq?: number }) {
    for (let page = 0; page < 40 && !scrollToMessage(message.id); page += 1) {
      const current = store.getSnapshot().messages[chat.id] ?? [];
      const reached = message.seq !== undefined && (current[0]?.seq ?? 0) <= message.seq;
      if (reached || !store.getSnapshot().hasOlder[chat.id]) break;
      atBottom.current = false;
      await store.loadOlder(chat.id);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  // Phase 8: a search result opens its chat at that message (loading older pages until it is there).
  useEffect(() => {
    if (!jump) return;
    const timer = setTimeout(() => {
      // The chat's newest page first (when it was not loaded yet), then older pages until the message is there.
      void store
        .openChat(chat.id)
        .then(() => new Promise((resolve) => requestAnimationFrame(resolve)))
        .then(() => jumpTo(jump))
        .catch(() => undefined)
        .finally(() => onJumped?.());
    }, 100);
    return () => clearTimeout(timer);
    // jumpTo reads the current messages through the store; only a new target starts it.
  }, [jump?.id]);

  const toggleSelect = (id: string) =>
    setSelected((current) => {
      const list = current ?? [];
      if (list.includes(id)) return list.filter((item) => item !== id);
      if (list.length >= MESSAGING_RULES.maxSelectedMessages) {
        onNotice(`You can select up to ${MESSAGING_RULES.maxSelectedMessages} messages.`);
        return list;
      }
      return [...list, id];
    });

  const selectedMessages = messages.filter((message) => selected?.includes(message.id));
  const deletesForEveryone = Boolean(group?.adminRights.includes('delete_messages'));
  const canDeleteForBoth = (ids: string[]) =>
    ids.every((id) => {
      const message = messages.find((item) => item.id === id);
      return message !== undefined && !message.deleted && (message.senderId === myId || deletesForEveryone);
    });

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    onNotice('Copied.');
  }

  const muteItems: MenuItem[] = isMuted(chat)
    ? [{ label: 'Unmute', icon: 'notifications_active', onSelect: () => void store.setChatState(chat.id, { mutedUntil: null }).catch((error: unknown) => onNotice(errorMessage(error))) }]
    : [
        { label: 'Mute for 1 hour', icon: 'notifications_off', onSelect: () => void store.setChatState(chat.id, { mutedUntil: new Date(Date.now() + 3600_000).toISOString() }).catch((error: unknown) => onNotice(errorMessage(error))) },
        { label: 'Mute for 8 hours', icon: 'notifications_off', onSelect: () => void store.setChatState(chat.id, { mutedUntil: new Date(Date.now() + 8 * 3600_000).toISOString() }).catch((error: unknown) => onNotice(errorMessage(error))) },
        { label: 'Mute until turned on', icon: 'notifications_off', onSelect: () => void store.setChatState(chat.id, { mutedUntil: FOREVER }).catch((error: unknown) => onNotice(errorMessage(error))) },
      ];
  const headerItems: MenuItem[] = [
    ...(group ? [{ label: channel ? 'Channel info' : 'Group info', icon: 'info' as const, onSelect: () => setDialog({ kind: 'info' }) }] : []),
    ...(chat.scheduledCount > 0 || maySchedule ? [{ label: 'Scheduled messages', icon: 'schedule_send' as const, onSelect: () => setDialog({ kind: 'scheduled' }) }] : []),
    { label: 'Search in chat', icon: 'search', onSelect: () => setSearchOpen('') },
    { label: 'Shared media', icon: 'perm_media', onSelect: () => setMediaPanel(true) },
    { label: 'Select messages', icon: 'check_circle', onSelect: () => setSelected([]) },
    ...muteItems,
    ...(!peer || peer.deleted
      ? []
      : [
          peer.blockedByMe
            ? { label: 'Unblock user', icon: 'block' as const, onSelect: () => void store.setBlocked(peer.id, false).catch((error: unknown) => onNotice(errorMessage(error))) }
            : { label: 'Block user', icon: 'block' as const, danger: true, onSelect: () => void store.setBlocked(peer.id, true).then(() => onNotice('User blocked.')).catch((error: unknown) => onNotice(errorMessage(error))) },
          { label: 'Report user', icon: 'flag' as const, danger: true, onSelect: () => setDialog({ kind: 'report', userId: peer.id }) },
        ]),
  ];

  const currentPin = pins.length > 0 ? pins[pinIndex % pins.length] : undefined;

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={channel ? `Channel ${chatTitle(chat)}` : group ? `Group ${chatTitle(chat)}` : `Chat with ${chatTitle(chat)}`}>
      {selected ? (
        <header className="flex h-[var(--bedo-header-height)] shrink-0 items-center gap-2 border-b border-line px-2">
          <button type="button" aria-label="Cancel selection" onClick={() => setSelected(null)} className="grid size-10 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover">
            <Icon name="close" />
          </button>
          <span className="flex-1 text-sm font-medium">{selected.length} selected</span>
          <button
            type="button"
            aria-label="Copy selected"
            disabled={selectedMessages.every((message) => message.text === null)}
            onClick={() => void copy(selectedMessages.filter((message) => message.text).map((message) => message.text).join('\n\n')).then(() => setSelected(null))}
            className="grid size-10 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover disabled:opacity-40"
          >
            <Icon name="content_copy" />
          </button>
          <button
            type="button"
            aria-label="Forward selected"
            disabled={selected.length === 0 || selectedMessages.some((message) => message.deleted)}
            onClick={() => setDialog({ kind: 'forward', ids: selectedMessages.map((message) => message.id) })}
            className="grid size-10 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover disabled:opacity-40"
          >
            <Icon name="forward" />
          </button>
          <button
            type="button"
            aria-label="Delete selected"
            disabled={selected.length === 0}
            onClick={() => setDialog({ kind: 'delete', ids: selected })}
            className="grid size-10 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover disabled:opacity-40"
          >
            <Icon name="delete" />
          </button>
        </header>
      ) : (
        <header className="flex h-[var(--bedo-header-height)] shrink-0 items-center gap-2 border-b border-line px-2">
          <button type="button" aria-label="Back to chats" onClick={onBack} className="grid size-10 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover md:hidden">
            <Icon name="arrow_back" />
          </button>
          <button type="button" onClick={() => setDialog({ kind: group ? 'info' : 'peer' })} className="flex min-w-0 flex-1 items-center gap-3 rounded-sm px-1 py-1 text-left hover:bg-surface-hover">
            <Avatar name={chatTitle(chat)} photoUrl={chatPhoto(chat)} size={40} />
            <span className="min-w-0">
              <span className="block truncate font-medium">{chatTitle(chat)}</span>
              <span className={`block truncate text-xs ${typing || status === 'online' ? 'text-accent' : 'text-ink-secondary'}`} aria-live="polite">
                {status}
              </span>
            </span>
          </button>
          {state.connection !== 'online' ? (
            <span className="text-xs text-ink-secondary" role="status">
              {state.connection === 'connecting' ? 'Connecting…' : 'Waiting for network…'}
            </span>
          ) : null}
          <ActionMenu label="Chat actions" items={headerItems} />
        </header>
      )}

      {currentPin ? (
        <button
          type="button"
          onClick={() => {
            void jumpTo(currentPin);
            setPinIndex((index) => index + 1);
          }}
          className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2 text-left hover:bg-surface-hover"
          aria-label="Pinned message"
        >
          <Icon name="keep" size={18} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium text-accent">{pins.length > 1 ? `Pinned message ${(pinIndex % pins.length) + 1} of ${pins.length}` : 'Pinned message'}</span>
            <span className="block truncate text-sm">{currentPin.deleted ? 'Deleted message' : (currentPin.text ?? (currentPin.sticker ? `${currentPin.sticker.emoji} Sticker` : currentPin.attachment ? MEDIA_LABEL[currentPin.attachment.kind] : ''))}</span>
          </span>
        </button>
      ) : null}

      {searchOpen !== null ? <ChatSearch key={searchOpen} chatId={chat.id} initial={searchOpen} onClose={() => setSearchOpen(null)} onPick={(message) => void jumpTo(message)} /> : null}

      <div ref={scroller} onScroll={() => void onScroll()} className="relative min-h-0 flex-1 overflow-y-auto bg-surface-subtle px-3 py-2" aria-label="Messages" role="log">
        {loadingOlder ? <p className="py-2 text-center text-xs text-ink-secondary">Loading…</p> : null}
        {messages.length === 0 && pending.length === 0 && uploads.length === 0 ? <p className="py-8 text-center text-sm text-ink-secondary">No messages yet.</p> : null}
        {messages.map((message, index) => {
          const previous = messages[index - 1];
          const newDay = !previous || dayLabel(previous.createdAt) !== dayLabel(message.createdAt);
          return (
            <Fragment key={message.id}>
              {newDay ? <p className="py-2 text-center text-xs text-ink-secondary">{dayLabel(message.createdAt)}</p> : null}
              <MessageItem
                message={message}
                chat={chat}
                mine={message.senderId === myId}
                pinned={pins.some((pin) => pin.id === message.id)}
                selecting={selected !== null}
                selected={selected?.includes(message.id) ?? false}
                onToggleSelect={() => toggleSelect(message.id)}
                onReply={() => setMode({ kind: 'reply', message })}
                onEdit={() => setMode({ kind: 'edit', message })}
                onCopy={() => void copy(message.text ?? '')}
                onShare={() => void shareText(message.text ?? '').then((result) => result === 'copied' && onNotice('Copied.'))}
                onForward={() => setDialog({ kind: 'forward', ids: [message.id] })}
                onPin={(pin) => void store.setPinned(message, pin).catch((error: unknown) => onNotice(errorMessage(error)))}
                onSelect={() => setSelected([message.id])}
                onDelete={() => setDialog({ kind: 'delete', ids: [message.id] })}
                onReport={() => setDialog({ kind: 'report', userId: message.senderId, messageId: message.id })}
                onHashtag={(tag) => setSearchOpen(tag)}
                onNotice={onNotice}
                onJumpToReply={() => message.replyTo && void jumpTo({ id: message.replyTo.id })}
                onOpenMedia={() => setViewer(message)}
                onSaveFile={() =>
                  void store
                    .fileUrl(message.id, true)
                    .then((url) => {
                      const link = document.createElement('a');
                      link.href = url;
                      link.rel = 'noopener';
                      document.body.append(link);
                      link.click();
                      link.remove();
                    })
                    .catch((error: unknown) => onNotice(errorMessage(error)))
                }
                onReact={(emoji) => void store.react(message, emoji as Parameters<typeof store.react>[1]).catch((error: unknown) => onNotice(errorMessage(error)))}
              />
            </Fragment>
          );
        })}
        {pending.map((item) => (
          <PendingItem key={item.clientId} item={item} onRetry={() => store.retry(item.clientId)} onDiscard={() => store.discard(item.clientId)} />
        ))}
        {uploads.map((item) => (
          <PendingUploadItem key={item.clientId} item={item} onRetry={() => store.retryUpload(item.clientId)} onCancel={() => store.cancelUpload(item.clientId)} />
        ))}
      </div>

      {showJump ? (
        <div className="relative">
          <button
            type="button"
            aria-label="Go to the newest message"
            onClick={() => {
              atBottom.current = true;
              if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
            }}
            className="absolute -top-14 right-4 grid size-10 place-items-center rounded-full border border-line bg-surface text-ink-secondary hover:bg-surface-hover"
          >
            <Icon name="keyboard_arrow_down" />
          </button>
        </div>
      ) : null}

      {selected ? null : (
        <Composer
          chat={chat}
          mode={mode}
          maySchedule={maySchedule}
          onModeChange={setMode}
          onNotice={onNotice}
          onPoll={() => setDialog({ kind: 'poll' })}
          onScheduled={() => setDialog({ kind: 'scheduled' })}
        />
      )}

      {dialog?.kind === 'forward' ? (
        <ForwardDialog
          fromChatId={chat.id}
          messageIds={dialog.ids}
          onClose={() => setDialog(null)}
          onDone={(text) => {
            setDialog(null);
            setSelected(null);
            onNotice(text);
          }}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <DeleteDialog
          count={dialog.ids.length}
          canDeleteForBoth={canDeleteForBoth(dialog.ids)}
          onClose={() => setDialog(null)}
          onDelete={async (scope) => {
            await store.remove(chat.id, dialog.ids, scope);
            setDialog(null);
            setSelected(null);
          }}
        />
      ) : null}
      {dialog?.kind === 'report' ? (
        <ReportDialog
          userId={dialog.userId}
          {...(dialog.messageId ? { messageId: dialog.messageId } : {})}
          onClose={() => setDialog(null)}
          onDone={(text) => {
            setDialog(null);
            onNotice(text);
          }}
        />
      ) : null}
      {viewer ? <MediaViewer message={viewer} onClose={() => setViewer(null)} /> : null}
      {mediaPanel ? (
        <MediaPanel
          chatId={chat.id}
          onClose={() => setMediaPanel(false)}
          onOpen={(message) => setViewer(message)}
          onJump={(message) => {
            setMediaPanel(false);
            void jumpTo(message);
          }}
        />
      ) : null}
      {dialog?.kind === 'peer' && peer ? <PeerPanel chat={chat} onClose={() => setDialog(null)} onReport={() => setDialog({ kind: 'report', userId: peer.id })} onNotice={onNotice} /> : null}
      {dialog?.kind === 'info' && group ? <GroupInfoPanel chat={chat} myId={myId} onClose={() => setDialog(null)} onNotice={onNotice} onLeft={onBack} /> : null}
      {dialog?.kind === 'poll' ? <PollComposer chatId={chat.id} onClose={() => setDialog(null)} onNotice={onNotice} /> : null}
      {dialog?.kind === 'scheduled' ? <ScheduledPanel chat={chat} onClose={() => setDialog(null)} onNotice={onNotice} /> : null}
    </section>
  );
}

/** At most this many files are sent at once from the attachment tray. */
const MAX_TRAY_FILES = 10;

interface TrayItem {
  id: string;
  original: File;
  prepared: PreparedFile | null;
  error: string | null;
}

function Composer({
  chat,
  mode,
  maySchedule,
  onModeChange,
  onNotice,
  onPoll,
  onScheduled,
}: {
  chat: Chat;
  mode: Mode;
  maySchedule: boolean;
  onModeChange: (mode: Mode) => void;
  onNotice: (message: string) => void;
  onPoll: () => void;
  onScheduled: () => void;
}) {
  const store = useMessagingStore();
  const [scheduling, setScheduling] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [tray, setTray] = useState<TrayItem[]>([]);
  const [asFiles, setAsFiles] = useState(false);
  const [picker, setPicker] = useState(false);
  const [recording, setRecording] = useState<{ recorder: Recorder; kind: 'voice' | 'video_note' } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode.kind === 'edit') setText(mode.message.text ?? '');
    if (mode.kind !== 'normal') input.current?.focus();
  }, [mode]);

  useEffect(() => {
    setText('');
    setTray([]);
    setPicker(false);
  }, [chat.id]);

  // Each file is prepared once per mode ("send as files" sends photos without resizing); a change of mode prepares
  // them again.
  const preparing = useRef(new Set<string>());
  const currentMode = useRef(asFiles);
  currentMode.current = asFiles;
  useEffect(() => {
    for (const item of tray) {
      const key = `${item.id}:${asFiles}`;
      if (item.prepared || item.error || preparing.current.has(key)) continue;
      preparing.current.add(key);
      prepareFile(item.original, asFiles)
        .then((prepared) => {
          if (currentMode.current !== asFiles) return;
          setTray((current) => current.map((entry) => (entry.id === item.id && !entry.prepared ? { ...entry, prepared } : entry)));
        })
        .catch(() => setTray((current) => current.map((entry) => (entry.id === item.id ? { ...entry, error: 'This file cannot be read.' } : entry))))
        .finally(() => preparing.current.delete(key));
    }
  }, [tray, asFiles]);

  if (!canPost(chat) && chat.type === 'channel') {
    // Phase 6: subscribers read; they can mute the channel here and leave it from its info.
    const muted = isMuted(chat);
    return (
      <div className="flex shrink-0 justify-center border-t border-line px-4 py-2">
        <Button
          variant="ghost"
          onClick={() => void store.setChatState(chat.id, { mutedUntil: muted ? null : FOREVER }).catch((error: unknown) => onNotice(errorMessage(error)))}
        >
          <Icon name={muted ? 'notifications_active' : 'notifications_off'} size={20} />
          {muted ? 'Unmute' : 'Mute'}
        </Button>
      </div>
    );
  }
  if (!canPost(chat)) {
    const peer = chat.peer;
    return (
      <div className="flex shrink-0 flex-col items-center gap-2 border-t border-line px-4 py-3 text-sm text-ink-secondary" role="status">
        {chat.group ? (
          <span>
            {chat.group.restricted
              ? chat.group.restrictedUntil
                ? `The admins restricted you until ${new Date(chat.group.restrictedUntil).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`
                : 'The admins restricted you from sending messages.'
              : 'Only admins can send messages here.'}
          </span>
        ) : peer?.blockedByMe ? (
          <>
            <span>You blocked this user.</span>
            <Button variant="secondary" onClick={() => void store.setBlocked(peer.id, false).catch((error: unknown) => onNotice(errorMessage(error)))}>
              Unblock
            </Button>
          </>
        ) : (
          <span>You can&apos;t message this user</span>
        )}
      </div>
    );
  }
  const mayAttach = canPost(chat, 'media');
  const mayPick = canPost(chat, 'sticker');
  const mayPoll = chat.type !== 'private' && canPost(chat, 'poll');

  const trimmed = text.trim();
  const tooLong = text.length > MESSAGING_RULES.textMaxLength;
  const replyToId = mode.kind === 'reply' ? mode.message.id : null;
  const trayReady = tray.length > 0 && tray.every((item) => item.prepared || item.error) && tray.some((item) => item.prepared);

  function addFiles(files: FileList | File[]) {
    const list = [...files];
    if (list.length === 0) return;
    if (mode.kind === 'edit') onModeChange({ kind: 'normal' });
    setTray((current) => {
      const room = MAX_TRAY_FILES - current.length;
      if (list.length > room) onNotice(`You can send up to ${MAX_TRAY_FILES} files at once.`);
      return [...current, ...list.slice(0, Math.max(0, room)).map((original) => ({ id: crypto.randomUUID(), original, prepared: null, error: null }))];
    });
  }

  function clearTray() {
    for (const item of tray) if (item.prepared?.previewUrl) URL.revokeObjectURL(item.prepared.previewUrl);
    setTray([]);
  }

  async function submit() {
    if (busy) return;
    if (tray.length > 0) {
      if (!trayReady || tooLong) return;
      const ready = tray.map((item) => item.prepared).filter((prepared): prepared is PreparedFile => prepared !== null);
      ready.forEach((prepared, index) => store.sendFile(chat.id, prepared, index === 0 && trimmed ? trimmed : null, index === 0 ? replyToId : null));
      setTray([]);
      setText('');
      onModeChange({ kind: 'normal' });
      return;
    }
    if (!trimmed || tooLong) return;
    if (mode.kind === 'edit') {
      setBusy(true);
      try {
        if (trimmed !== mode.message.text) await store.edit(mode.message.id, trimmed);
        onModeChange({ kind: 'normal' });
        setText('');
      } catch (error) {
        onNotice(errorMessage(error));
      } finally {
        setBusy(false);
      }
      return;
    }
    store.send(chat.id, trimmed, replyToId);
    setText('');
    onModeChange({ kind: 'normal' });
  }

  /** Phase 6: the text, or the files with their caption, sent by the server at `sendAt`. */
  async function scheduleAt(sendAt: string): Promise<boolean> {
    try {
      if (tray.length > 0) {
        if (!trayReady || tooLong) return false;
        const ready = tray.map((item) => item.prepared).filter((prepared): prepared is PreparedFile => prepared !== null);
        ready.forEach((prepared, index) => store.sendFile(chat.id, prepared, index === 0 && trimmed ? trimmed : null, index === 0 ? replyToId : null, sendAt));
        setTray([]);
      } else {
        if (!trimmed || tooLong) return false;
        await store.schedule(chat.id, trimmed, replyToId, sendAt);
      }
      setText('');
      onModeChange({ kind: 'normal' });
      onNotice(`Scheduled for ${scheduleLabel(sendAt)}.`);
      return true;
    } catch (error) {
      onNotice(errorMessage(error));
      return false;
    }
  }

  async function startRecording(kind: 'voice' | 'video_note') {
    try {
      const recorder = await Recorder.start(kind);
      recorder.onLimit = () => void finishRecording(recorder, kind);
      setRecording({ recorder, kind });
    } catch (error) {
      onNotice(error instanceof DOMException && error.name === 'NotAllowedError' ? `Allow ${kind === 'voice' ? 'the microphone' : 'the camera and microphone'} in your browser to record.` : 'Recording is not available on this device.');
    }
  }

  async function finishRecording(recorder: Recorder, kind: 'voice' | 'video_note') {
    setRecording(null);
    try {
      const result = await recorder.stop();
      if (result.durationMs < 700) {
        onNotice('Hold on a little longer to record.');
        return;
      }
      store.sendFile(chat.id, await prepareRecording(kind, result), null, replyToId);
      onModeChange({ kind: 'normal' });
    } catch {
      onNotice('Nothing was recorded.');
    }
  }

  if (recording?.kind === 'voice') {
    return <VoiceRecordingBar recorder={recording.recorder} onCancel={() => { recording.recorder.cancel(); setRecording(null); }} onSend={() => void finishRecording(recording.recorder, 'voice')} />;
  }

  return (
    <div className="relative shrink-0 border-t border-line bg-surface px-3 py-2">
      {recording?.kind === 'video_note' ? (
        <VideoNoteRecorder recorder={recording.recorder} onCancel={() => { recording.recorder.cancel(); setRecording(null); }} onSend={() => void finishRecording(recording.recorder, 'video_note')} />
      ) : null}
      {mode.kind !== 'normal' ? (
        <div className="mb-2 flex items-center gap-2 border-l-2 border-accent pl-2">
          <Icon name={mode.kind === 'edit' ? 'edit' : 'reply'} size={18} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium text-accent">{mode.kind === 'edit' ? 'Edit message' : 'Reply'}</span>
            <span className="block truncate text-sm text-ink-secondary">
              {mode.message.text ?? (mode.message.sticker ? `${mode.message.sticker.emoji} Sticker` : mode.message.attachment ? MEDIA_LABEL[mode.message.attachment.kind] : '')}
            </span>
          </span>
          <button
            type="button"
            aria-label={mode.kind === 'edit' ? 'Cancel editing' : 'Cancel reply'}
            onClick={() => {
              if (mode.kind === 'edit') setText('');
              onModeChange({ kind: 'normal' });
            }}
            className="grid size-8 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover"
          >
            <Icon name="close" size={18} />
          </button>
        </div>
      ) : null}
      {tray.length > 0 ? (
        <div className="mb-2 flex flex-col gap-2 rounded-sm border border-line p-2" aria-label="Files to send">
          <ul className="flex gap-2 overflow-x-auto">
            {tray.map((item) => (
              <li key={item.id} className="relative flex w-28 shrink-0 flex-col items-center gap-1 rounded-sm bg-surface-subtle p-1 text-center">
                {item.prepared?.previewUrl ? (
                  <img src={item.prepared.previewUrl} alt="" className="size-20 rounded-sm object-cover" />
                ) : (
                  <span className="grid size-20 place-items-center text-ink-secondary">
                    <Icon name={item.error ? 'error' : item.prepared ? (item.prepared.kind === 'audio' ? 'headphones' : item.prepared.kind === 'video' ? 'movie' : 'description') : 'schedule'} size={32} />
                  </span>
                )}
                <span className="w-full truncate text-[11px]">{item.original.name}</span>
                <span className="text-[11px] text-ink-secondary">{item.error ?? (item.prepared ? `${MEDIA_LABEL[item.prepared.kind]} · ${formatBytes(item.prepared.body.size)}` : 'Preparing…')}</span>
                <button
                  type="button"
                  aria-label={`Remove ${item.original.name}`}
                  onClick={() => setTray((current) => current.filter((entry) => entry.id !== item.id))}
                  className="absolute right-0.5 top-0.5 grid size-6 place-items-center rounded-full bg-surface text-ink-secondary hover:bg-surface-hover"
                >
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={asFiles}
                onChange={(event) => {
                  setAsFiles(event.target.checked);
                  setTray((current) => current.map((entry) => ({ ...entry, prepared: null, error: null })));
                }}
              />
              Send as files (no compression)
            </label>
            <button type="button" onClick={clearTray} className="ml-auto text-ink-secondary hover:text-ink">
              Clear
            </button>
          </div>
        </div>
      ) : null}
      {picker ? (
        <ExpressionPicker
          onEmoji={(emoji) => {
            const element = input.current;
            const start = element?.selectionStart ?? text.length;
            const end = element?.selectionEnd ?? text.length;
            setText(text.slice(0, start) + emoji + text.slice(end));
            requestAnimationFrame(() => {
              element?.focus();
              element?.setSelectionRange(start + emoji.length, start + emoji.length);
            });
          }}
          stickersAllowed={mayPick}
          onSticker={(sticker) => {
            setPicker(false);
            void store.sendPicked(chat.id, { stickerId: sticker.id }, replyToId).catch((error: unknown) => onNotice(errorMessage(error)));
            onModeChange({ kind: 'normal' });
          }}
          onGif={(gif) => {
            setPicker(false);
            void store.sendPicked(chat.id, { gifId: gif.id }, replyToId).catch((error: unknown) => onNotice(errorMessage(error)));
            onModeChange({ kind: 'normal' });
          }}
          onClose={() => setPicker(false)}
        />
      ) : null}
      <form
        className="flex items-end gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <button
          type="button"
          aria-label="Emoji, stickers and GIFs"
          aria-expanded={picker}
          data-expression-toggle=""
          onClick={() => setPicker(!picker)}
          className="grid size-10 shrink-0 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover"
        >
          <Icon name="mood" size={22} />
        </button>
        {chat.scheduledCount > 0 && mode.kind !== 'edit' ? (
          <button type="button" aria-label={`Scheduled messages (${chat.scheduledCount})`} onClick={onScheduled} className="grid size-10 shrink-0 place-items-center rounded-sm text-accent hover:bg-surface-hover">
            <Icon name="schedule_send" size={22} />
          </button>
        ) : null}
        {mode.kind === 'edit' || !mayPoll ? null : (
          <button type="button" aria-label="Create a poll" onClick={onPoll} className="grid size-10 shrink-0 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover">
            <Icon name="bar_chart" size={22} />
          </button>
        )}
        {mode.kind === 'edit' || !mayAttach ? null : (
          <>
            <button type="button" aria-label="Attach files" onClick={() => filePicker.current?.click()} className="grid size-10 shrink-0 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover">
              <Icon name="attach_file" size={22} />
            </button>
            <input
              ref={filePicker}
              type="file"
              multiple
              hidden
              aria-label="Choose files"
              onChange={(event) => {
                if (event.target.files) addFiles(event.target.files);
                event.target.value = '';
              }}
            />
          </>
        )}
        <label htmlFor="composer" className="sr-only">
          {tray.length > 0 ? 'Caption' : 'Message'}
        </label>
        <textarea
          id="composer"
          ref={input}
          value={text}
          rows={1}
          placeholder={tray.length > 0 ? 'Add a caption' : 'Message'}
          onChange={(event) => {
            setText(event.target.value);
            if (event.target.value.trim()) store.typing(chat.id);
          }}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (files.length > 0 && mode.kind !== 'edit' && mayAttach) {
              event.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
            if (event.key === 'Escape' && mode.kind !== 'normal') onModeChange({ kind: 'normal' });
          }}
          className="max-h-40 min-h-10 flex-1 resize-none rounded-sm border border-line bg-surface px-3 py-2 text-[length:var(--bedo-font-size-md)] outline-none focus:border-accent field-sizing-content"
        />
        {!trimmed && tray.length === 0 && mode.kind === 'normal' && mayAttach ? (
          <>
            <button type="button" aria-label="Record a video message" onClick={() => void startRecording('video_note')} className="grid size-10 shrink-0 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover">
              <Icon name="videocam" size={22} />
            </button>
            <button type="button" aria-label="Record a voice message" onClick={() => void startRecording('voice')} className="grid size-10 shrink-0 place-items-center rounded-sm bg-accent text-on-accent hover:bg-accent-hover">
              <Icon name="mic" size={20} />
            </button>
          </>
        ) : (
          <>
          {maySchedule && mode.kind !== 'edit' ? (
            <button
              type="button"
              aria-label="Schedule message"
              disabled={(tray.length > 0 ? !trayReady : !trimmed) || tooLong || busy}
              onClick={() => setScheduling(true)}
              className="grid size-10 shrink-0 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover disabled:opacity-40"
            >
              <Icon name="schedule" size={22} />
            </button>
          ) : null}
          <button
            type="submit"
            aria-label={mode.kind === 'edit' ? 'Save' : 'Send'}
            disabled={(tray.length > 0 ? !trayReady : !trimmed) || tooLong || busy}
            className="grid size-10 shrink-0 place-items-center rounded-sm bg-accent text-on-accent hover:bg-accent-hover disabled:opacity-40"
          >
            <Icon name={mode.kind === 'edit' ? 'check' : 'send'} size={20} />
          </button>
          </>
        )}
      </form>
      {scheduling ? <ScheduleDialog onClose={() => setScheduling(false)} onPick={scheduleAt} /> : null}
      {text.length > MESSAGING_RULES.textMaxLength - 200 ? (
        <p className={`mt-1 text-right text-xs ${tooLong ? 'text-danger' : 'text-ink-secondary'}`}>
          {text.length}/{MESSAGING_RULES.textMaxLength}
        </p>
      ) : null}
    </div>
  );
}

/** Recording a voice message: time, live level, cancel or send (stops by itself at 15 minutes). */
function VoiceRecordingBar({ recorder, onCancel, onSend }: { recorder: Recorder; onCancel: () => void; onSend: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  useEffect(() => {
    recorder.onLevel = (level) => setLevels((current) => [...current.slice(-47), level]);
    const timer = setInterval(() => setElapsed(recorder.elapsedMs), 200);
    return () => {
      recorder.onLevel = null;
      clearInterval(timer);
    };
  }, [recorder]);
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-3 py-2" role="status" aria-label="Recording a voice message">
      <button type="button" aria-label="Cancel recording" onClick={onCancel} className="grid size-10 place-items-center rounded-sm text-danger hover:bg-surface-hover">
        <Icon name="delete" size={22} />
      </button>
      <span className="size-2.5 animate-pulse rounded-full bg-danger" aria-hidden="true" />
      <span className="w-12 text-sm tabular-nums">{formatDuration(elapsed)}</span>
      <span className="flex h-8 min-w-0 flex-1 items-center gap-[2px] overflow-hidden" aria-hidden="true">
        {levels.map((level, index) => (
          <span key={index} className="w-[3px] shrink-0 rounded-full bg-accent" style={{ height: `${Math.max(8, level)}%` }} />
        ))}
      </span>
      <button type="button" aria-label="Send voice message" onClick={onSend} className="grid size-10 place-items-center rounded-sm bg-accent text-on-accent hover:bg-accent-hover">
        <Icon name="send" size={20} />
      </button>
    </div>
  );
}

/** Recording a video message: a round preview of the camera, up to 60 seconds. */
function VideoNoteRecorder({ recorder, onCancel, onSend }: { recorder: Recorder; onCancel: () => void; onSend: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (video.current) video.current.srcObject = recorder.stream;
    const timer = setInterval(() => setElapsed(recorder.elapsedMs), 200);
    return () => clearInterval(timer);
  }, [recorder]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-ink/70 p-4" role="dialog" aria-modal="true" aria-label="Recording a video message">
      <div className="flex flex-col items-center gap-4">
        <div className="size-64 overflow-hidden rounded-full border-4 border-accent bg-ink">
          <video ref={video} autoPlay muted playsInline className="size-full -scale-x-100 object-cover" />
        </div>
        <p className="text-sm text-on-accent tabular-nums">
          {formatDuration(elapsed)} / {formatDuration(60_000)}
        </p>
        <div className="flex gap-3">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onSend}>Send</Button>
        </div>
      </div>
    </div>
  );
}

function ChatSearch({ chatId, initial, onClose, onPick }: { chatId: string; initial: string; onClose: () => void; onPick: (message: Message) => void }) {
  const store = useMessagingStore();
  const [query, setQuery] = useState(initial);
  const [results, setResults] = useState<Message[] | null>(null);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      store
        .searchInChat(chatId, q)
        .then((found) => !cancelled && setResults(found))
        .catch(() => !cancelled && setResults([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, chatId, store]);
  return (
    <div className="shrink-0 border-b border-line">
      <div className="flex items-center gap-2 px-3 py-2">
        <Icon name="search" size={20} className="text-ink-secondary" />
        <label htmlFor="chat-search" className="sr-only">
          Search in chat
        </label>
        <input
          id="chat-search"
          type="search"
          autoFocus
          value={query}
          maxLength={MESSAGING_RULES.chatSearchMaxLength}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search in this chat"
          className="h-9 flex-1 bg-transparent text-sm outline-none"
        />
        <button type="button" aria-label="Close search" onClick={onClose} className="grid size-8 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover">
          <Icon name="close" size={18} />
        </button>
      </div>
      {results ? (
        <ul className="max-h-60 overflow-y-auto border-t border-line" aria-label="Search results">
          {results.length === 0 ? <li className="px-4 py-2 text-sm text-ink-secondary">No messages found.</li> : null}
          {results.map((message) => (
            <li key={message.id}>
              <button type="button" onClick={() => onPick(message)} className="flex w-full flex-col px-4 py-2 text-left hover:bg-surface-hover">
                <span className="text-xs text-ink-secondary">{new Date(message.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                <span className="truncate text-sm">{message.text ?? (message.attachment ? MEDIA_LABEL[message.attachment.kind] : '')}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PeerPanel({ chat, onClose, onReport, onNotice }: { chat: Chat; onClose: () => void; onReport: () => void; onNotice: (message: string) => void }) {
  const store = useMessagingStore();
  const state = useMessaging();
  const peer = chat.peer!;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/30" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside role="dialog" aria-modal="true" aria-label="Profile" className="flex h-full w-full max-w-[360px] flex-col bg-surface">
        <header className="flex h-[var(--bedo-header-height)] items-center gap-2 border-b border-line px-2">
          <button type="button" aria-label="Close profile" onClick={onClose} className="grid size-10 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover">
            <Icon name="close" />
          </button>
          <h2 className="font-medium">Profile</h2>
        </header>
        <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
          <Avatar name={peer.displayName} photoUrl={peer.photoUrl} size={96} />
          <p className="text-[length:var(--bedo-font-size-lg)] font-medium">{displayName(peer)}</p>
          <p className="text-sm text-ink-secondary">{presenceText(presenceOf(state, peer))}</p>
        </div>
        <dl className="flex flex-col gap-3 border-t border-line px-4 py-4 text-sm">
          {peer.username ? (
            <div>
              <dt className="text-xs text-ink-secondary">Username</dt>
              <dd>@{peer.username}</dd>
            </div>
          ) : null}
          {peer.phone ? (
            <div>
              <dt className="text-xs text-ink-secondary">Phone</dt>
              <dd>{peer.phone}</dd>
            </div>
          ) : null}
          {peer.bio ? (
            <div>
              <dt className="text-xs text-ink-secondary">Bio</dt>
              <dd className="whitespace-pre-wrap">{peer.bio}</dd>
            </div>
          ) : null}
        </dl>
        {peer.deleted ? null : (
          <div className="mt-auto flex flex-col gap-2 border-t border-line p-4">
            <Button
              variant="danger"
              onClick={() =>
                void store
                  .setBlocked(peer.id, !peer.blockedByMe)
                  .then(() => onNotice(peer.blockedByMe ? 'User unblocked.' : 'User blocked.'))
                  .catch((error: unknown) => onNotice(errorMessage(error)))
              }
            >
              {peer.blockedByMe ? 'Unblock user' : 'Block user'}
            </Button>
            <Button variant="danger" onClick={onReport}>
              Report user
            </Button>
          </div>
        )}
      </aside>
    </div>
  );
}

