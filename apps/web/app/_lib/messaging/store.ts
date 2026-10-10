import {
  blockUser,
  cancelScheduledMessage,
  createChannel as apiCreateChannel,
  getMyPermissions,
  joinChannel as apiJoinChannel,
  listScheduledMessages,
  realtimeViewing,
  scheduleMessage,
  searchChannels as apiSearchChannels,
  sendScheduledMessageNow,
  updateScheduledMessage,
  createFolder,
  createUpload,
  getMessageFile,
  listChatMedia,
  listStickers,
  reactToMessage,
  removeReaction,
  searchGifs,
  deleteFolder,
  deleteMessages,
  editMessage,
  forwardMessages,
  getChat,
  listChats,
  listFolders,
  listMessages,
  listPinnedMessages,
  markChatDelivered,
  markChatRead,
  openChat,
  pinMessage,
  realtimeTyping,
  reportUser,
  searchChat,
  searchEverywhere,
  searchUsers,
  sendMessage,
  sync as fetchSync,
  unblockUser,
  unpinMessage,
  updateChatState,
  updateFolder,
} from '@bedo/api-client';
import {
  type Chat,
  type Folder,
  type GifSearchResponse,
  type MediaFilter,
  type Message,
  MESSAGING_RULES,
  type ReactionBody,
  type StickerPack,
  type UploadKind,
  type Peer,
  type Presence,
  type PublicChannel,
  type RealtimeSignal,
  type ReportBody,
  type GlobalSearchResponse,
  type ScheduledMessage,
  type SyncResponse,
  type UserPermissions,
} from '@bedo/contracts';
import { ApiError, errorMessage } from '../api';
import { type CachedState, clearCache, loadCache, type PendingMessage, saveCache } from './cache';
import { type PreparedFile, uploadWithProgress } from './media';
import { type ConnectionState, RealtimeClient } from './realtime';

/** A file being uploaded and sent (Phase 4). Kept in memory only: a page reload drops it. */
export interface PendingUpload {
  clientId: string;
  chatId: string;
  kind: UploadKind;
  fileName: string | null;
  size: number;
  previewUrl: string | null;
  caption: string | null;
  replyToId: string | null;
  /** Phase 6: schedule it for this time instead of sending it now. */
  sendAt: string | null;
  /** 0 to 1 while uploading. */
  progress: number;
  status: 'uploading' | 'sending' | 'failed';
  error: string | null;
  createdAt: string;
}

export type { PendingMessage } from './cache';

export interface MessagingSnapshot {
  status: 'loading' | 'ready';
  connection: ConnectionState;
  chats: Record<string, Chat>;
  /** Loaded messages of each chat, oldest first (a contiguous window ending at the newest). */
  messages: Record<string, Message[]>;
  /** Whether older messages exist before the loaded window. */
  hasOlder: Record<string, boolean>;
  pins: Record<string, Message[]>;
  outbox: PendingMessage[];
  uploads: PendingUpload[];
  folders: Folder[];
  /** chatId -> time (ms) the other participant's typing indicator ends. */
  typing: Record<string, number>;
  /** Groups: chatId -> who is typing, when this member may know it (O-03); missing: "someone". */
  typingNames: Record<string, string>;
  /** Live presence of users from realtime events, newer than the chat summaries. */
  presence: Record<string, Presence | null>;
  /** Phase 6: the signed-in user's scheduled messages, per chat whose list was opened (not cached on the device). */
  scheduled: Record<string, ScheduledMessage[]>;
}

const EMPTY: MessagingSnapshot = {
  status: 'loading',
  connection: 'connecting',
  chats: {},
  messages: {},
  hasOlder: {},
  pins: {},
  outbox: [],
  uploads: [],
  folders: [],
  typing: {},
  typingNames: {},
  presence: {},
  scheduled: {},
};

const PAGE = MESSAGING_RULES.refetchPageSize;
const TYPING_MS = MESSAGING_RULES.typingSeconds * 1000;
/** Typing is sent at most this often while the user keeps typing (the indicator lasts 6 s). */
const TYPING_SEND_MS = 3_000;
/** While not listening on the realtime channel, sync over HTTP this often. */
const POLL_MS = 20_000;
/** After a reconnect or re-fetch, only the most recently active chats get their newest page again. */
const REFETCH_CHATS = 20;

const cast = <T>(value: unknown) => value as T;

function mergeMessages(current: readonly Message[], incoming: readonly Message[]): Message[] {
  if (incoming.length === 0) return [...current];
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

export function presenceOf(snapshot: MessagingSnapshot, peer: Peer): Presence | null {
  return peer.id in snapshot.presence ? (snapshot.presence[peer.id] ?? null) : peer.presence;
}

/** Chat list order: pinned chats first (most recently pinned on top), then by the latest activity. */
export function sortedChats(chats: readonly Chat[]): Chat[] {
  const activity = (chat: Chat) => chat.lastMessageAt ?? chat.createdAt;
  return [...chats].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned && b.pinned) return (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? '');
    return activity(b).localeCompare(activity(a));
  });
}

/**
 * The web app's messaging state: chats, messages, folders and the outbox, kept in step with the server by
 * realtime signals, heartbeats and sync (P-17, D-36), cached locally for a fast start and offline reading. Every change
 * goes through the API, which decides what is allowed; this store never assumes a permission.
 */
export class MessagingStore {
  private snapshot: MessagingSnapshot = EMPTY;
  private readonly listeners = new Set<() => void>();
  private readonly realtime: RealtimeClient;
  private userId: string | null = null;
  private seq = 0;
  private initialized = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private httpSyncing = false;
  /** A sync was asked for while one was running: run once more after it. */
  private syncAgain = false;
  private outboxFlushed = false;
  private readonly lastTypingSent = new Map<string, number>();
  private readonly sending = new Set<string>();
  /** Files of uploads in progress (and their upload slot once given), for retries. */
  private readonly uploadJobs = new Map<string, { file: PreparedFile; fileId: string | null; uploaded: boolean; controller: AbortController }>();
  private stickerPacks: Promise<StickerPack[]> | null = null;
  private permissions: Promise<UserPermissions> | null = null;
  /** Phase 7: the chat this device last said it shows (null: none). */
  private viewingChat: string | null | undefined = undefined;
  private stopped = false;

  constructor() {
    this.realtime = new RealtimeClient({
      onHeartbeat: (serverSeq) => void this.onHeartbeat(serverSeq),
      onListening: () => void this.httpSync(),
      onSignal: (signal) => this.onSignal(signal),
      onState: (connection) => this.onConnection(connection),
    });
  }

  // ------------------------------------------------------------------------------ subscription

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): MessagingSnapshot => this.snapshot;

  private set(update: Partial<MessagingSnapshot>, persist = true): void {
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
    if (persist) this.schedulePersist();
  }

  // ------------------------------------------------------------------------------ lifecycle

  async start(userId: string): Promise<void> {
    this.userId = userId;
    this.stopped = false;
    this.outboxFlushed = false;
    const cached = await loadCache(userId);
    if (this.stopped) return;
    if (cached) {
      this.seq = cached.seq;
      this.initialized = true;
      this.set(
        {
          status: 'ready',
          chats: Object.fromEntries(cached.chats.map((chat) => [chat.id, chat])),
          messages: cached.messages,
          hasOlder: Object.fromEntries(Object.entries(cached.messages).map(([chatId, list]) => [chatId, (list[0]?.seq ?? 1) > 1])),
          folders: cached.folders,
          // Anything that was being sent when the page closed is retried.
          outbox: cached.outbox.map((item) => (item.status === 'sending' ? { ...item } : item)),
        },
        false,
      );
    }
    this.realtime.start();
    this.pollTimer = setInterval(() => {
      if (!this.realtime.live) void this.httpSync();
    }, POLL_MS);
    if (!cached) {
      // Without a cache, show the chat list as soon as possible, even before the first heartbeat.
      void this.fullFetch(null).catch(() => undefined);
    }
  }

  stop(): void {
    this.stopped = true;
    this.realtime.stop();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.pollTimer = null;
    this.persistTimer = null;
  }

  /** Signing out: forget everything, including the local cache. */
  async wipe(): Promise<void> {
    this.stop();
    this.snapshot = EMPTY;
    this.seq = 0;
    this.initialized = false;
    await clearCache();
  }

  private schedulePersist(): void {
    if (!this.userId || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.userId || this.stopped || !this.initialized) return;
      const state: CachedState = {
        userId: this.userId,
        seq: this.seq,
        chats: Object.values(this.snapshot.chats),
        messages: this.snapshot.messages,
        folders: this.snapshot.folders,
        outbox: this.snapshot.outbox,
      };
      void saveCache(state);
    }, 500);
  }

  private onConnection(connection: ConnectionState): void {
    this.set({ connection }, false);
  }

  /** Every heartbeat (25 s) returns the server's update seq: catch up when this device is behind. */
  private async onHeartbeat(serverSeq: number): Promise<void> {
    if (!this.initialized) {
      await this.fullFetch(serverSeq).catch(() => undefined);
    } else if (serverSeq !== this.seq) {
      await this.httpSync();
    }
    if (!this.outboxFlushed) {
      this.outboxFlushed = true;
      this.flushOutbox();
    }
  }

  // ------------------------------------------------------------------------------ sync

  /**
   * Everything from scratch (first start, or more than 1,000 updates behind, P-17): the chat list, the
   * folders, and the newest page of the recently active chats (50 messages per page).
   */
  private async fullFetch(serverSeq: number | null): Promise<void> {
    const [chats, folders] = await Promise.all([listChats(), listFolders()]);
    const list = cast<Chat[]>(chats.chats);
    const keep = new Set(
      [...Object.keys(this.snapshot.messages)]
        .filter((chatId) => list.some((chat) => chat.id === chatId))
        .slice(0, REFETCH_CHATS),
    );
    const pages = await Promise.all(
      [...keep].map(async (chatId) => [chatId, cast<Message[]>((await listMessages(chatId, { limit: PAGE })).messages)] as const),
    );
    if (serverSeq !== null) this.seq = serverSeq;
    this.initialized = this.initialized || serverSeq !== null;
    this.set({
      status: 'ready',
      chats: Object.fromEntries(list.map((chat) => [chat.id, chat])),
      folders: cast<Folder[]>(folders.folders),
      messages: Object.fromEntries(pages),
      hasOlder: Object.fromEntries(pages.map(([chatId, messages]) => [chatId, messages.length === PAGE])),
      pins: {},
    });
  }

  private onSignal(message: RealtimeSignal): void {
    switch (message.type) {
      case 'updates':
        void this.httpSync();
        return;
      case 'typing': {
        const until = Date.now() + TYPING_MS;
        const typingNames = { ...this.snapshot.typingNames };
        const sender = message.userId ? (this.snapshot.messages[message.chatId] ?? []).findLast((item) => item.sender?.id === message.userId)?.sender : undefined;
        if (sender) typingNames[message.chatId] = sender.displayName.split(' ')[0]!;
        else delete typingNames[message.chatId];
        this.set({ typing: { ...this.snapshot.typing, [message.chatId]: until }, typingNames }, false);
        setTimeout(() => {
          if ((this.snapshot.typing[message.chatId] ?? 0) <= Date.now()) {
            const typing = { ...this.snapshot.typing };
            delete typing[message.chatId];
            this.set({ typing }, false);
          }
        }, TYPING_MS + 50);
        return;
      }
      case 'presence':
        this.set({ presence: { ...this.snapshot.presence, [message.userId]: message.presence } }, false);
        return;
      default:
        return;
    }
  }

  /**
   * Fetches the updates after this device's seq (P-17), page by page. Signals, heartbeats and the poll ask for
   * it; requests that arrive while one runs collapse into one more round.
   */
  private async httpSync(): Promise<void> {
    if (!this.initialized) return;
    if (this.httpSyncing) {
      this.syncAgain = true;
      return;
    }
    this.httpSyncing = true;
    try {
      do {
        this.syncAgain = false;
        for (let page = 0; page < 20; page += 1) {
          const result = cast<SyncResponse>(await fetchSync({ since: this.seq }));
          const more = await this.applySync(result);
          if (!more) break;
        }
      } while (this.syncAgain && !this.stopped);
    } catch {
      // Offline: try again on the next heartbeat or poll.
    } finally {
      this.httpSyncing = false;
    }
  }

  /** Applies one sync page; returns whether more pages follow. */
  private async applySync(result: SyncResponse): Promise<boolean> {
    if (result.resync) {
      await this.fullFetch(result.seq).catch(() => undefined);
      return false;
    }
    if (result.seq < this.seq && result.updates.length === 0) return false;
    const chats = { ...this.snapshot.chats };
    for (const chat of result.chats) chats[chat.id] = chat;
    const presence = { ...this.snapshot.presence };
    for (const chat of result.chats) if (chat.peer) delete presence[chat.peer.id];
    const messages = { ...this.snapshot.messages };
    const pins = { ...this.snapshot.pins };
    const byId = new Map(result.messages.map((message) => [message.id, message]));
    // New and changed messages go into the chats whose messages are loaded.
    const incoming = new Map<string, Message[]>();
    for (const message of result.messages) {
      if (!messages[message.chatId]) continue;
      incoming.set(message.chatId, [...(incoming.get(message.chatId) ?? []), message]);
    }
    for (const [chatId, list] of incoming) messages[chatId] = mergeMessages(messages[chatId] ?? [], list);
    const deliveredUpTo = new Map<string, number>();
    let outbox = this.snapshot.outbox;
    const typing = { ...this.snapshot.typing };
    const scheduledChanged = new Set<string>();
    for (const update of result.updates) {
      const chatId = update.chatId;
      if (!chatId) continue;
      if (update.kind === 'scheduled') scheduledChanged.add(chatId);
      if (update.kind === 'chat.removed') {
        // Left, removed or the group was deleted: the chat and its messages go from this device.
        delete chats[chatId];
        delete messages[chatId];
        delete pins[chatId];
        continue;
      }
      if (update.kind === 'message.hidden' && update.messageId) {
        if (messages[chatId]) messages[chatId] = messages[chatId].filter((message) => message.id !== update.messageId);
        if (pins[chatId]) pins[chatId] = pins[chatId].filter((message) => message.id !== update.messageId);
      }
      if (update.kind === 'message.new' && update.messageId) {
        const message = byId.get(update.messageId);
        if (message && message.senderId !== this.userId) {
          deliveredUpTo.set(chatId, Math.max(deliveredUpTo.get(chatId) ?? 0, message.seq));
          // The message the other person was typing has arrived.
          delete typing[chatId];
        }
        if (message && message.senderId === this.userId) {
          // Sent from this or another device: the pending copy is now the real message.
          outbox = outbox.filter((item) => item.clientId !== message.clientId);
        }
      }
      if ((update.kind === 'message.pinned' || update.kind === 'message.unpinned') && update.messageId && pins[chatId]) {
        const message = byId.get(update.messageId);
        pins[chatId] = pins[chatId].filter((item) => item.id !== update.messageId);
        if (update.kind === 'message.pinned' && message) pins[chatId] = [message, ...pins[chatId]];
      }
      if (update.kind === 'message.deleted' && update.messageId && pins[chatId]) {
        pins[chatId] = pins[chatId].filter((item) => item.id !== update.messageId);
      }
    }
    this.seq = Math.max(this.seq, result.seq);
    this.set({
      chats,
      messages,
      pins,
      presence,
      outbox,
      typing,
      ...(result.folders ? { folders: result.folders } : {}),
    });
    for (const [chatId, seq] of deliveredUpTo) this.acknowledge(chatId, seq);
    for (const chatId of scheduledChanged) if (this.snapshot.scheduled[chatId]) void this.loadScheduled(chatId).catch(() => undefined);
    return result.hasMore;
  }

  /** Tells the sender this device received their messages (status "delivered"). */
  private acknowledge(chatId: string, seq: number): void {
    void markChatDelivered(chatId, { seq }).catch(() => undefined);
  }

  // ------------------------------------------------------------------------------ chats

  upsertChat(chat: Chat): void {
    const presence = { ...this.snapshot.presence };
    if (chat.peer) delete presence[chat.peer.id];
    this.set({ chats: { ...this.snapshot.chats, [chat.id]: chat }, presence });
  }

  async refreshChat(chatId: string): Promise<void> {
    this.upsertChat(cast<Chat>(await getChat(chatId)));
  }

  /** Loads the newest page of a chat and its pins, when opened. */
  async openChat(chatId: string): Promise<void> {
    const tasks: Array<Promise<unknown>> = [listPinnedMessages(chatId).then((result) => this.set({ pins: { ...this.snapshot.pins, [chatId]: cast<Message[]>(result.messages) } }, false))];
    if (!this.snapshot.messages[chatId]) {
      tasks.push(
        listMessages(chatId, { limit: PAGE }).then((result) => {
          const page = cast<Message[]>(result.messages);
          this.set({
            messages: { ...this.snapshot.messages, [chatId]: mergeMessages(this.snapshot.messages[chatId] ?? [], page) },
            hasOlder: { ...this.snapshot.hasOlder, [chatId]: page.length === PAGE },
          });
        }),
      );
    }
    await Promise.all(tasks);
  }

  async loadOlder(chatId: string): Promise<number> {
    const current = this.snapshot.messages[chatId] ?? [];
    const first = current[0];
    if (!first || !this.snapshot.hasOlder[chatId]) return 0;
    const page = cast<Message[]>((await listMessages(chatId, { before: first.seq, limit: PAGE })).messages);
    this.set({
      messages: { ...this.snapshot.messages, [chatId]: mergeMessages(this.snapshot.messages[chatId] ?? [], page) },
      hasOlder: { ...this.snapshot.hasOlder, [chatId]: page.length === PAGE },
    });
    return page.length;
  }

  async startChatWith(userId: string): Promise<Chat> {
    const chat = cast<Chat>(await openChat({ userId }));
    this.upsertChat(chat);
    return chat;
  }

  /** Mark as read up to the newest message (P-20); also clears "marked as unread". */
  async markRead(chatId: string): Promise<void> {
    const chat = this.snapshot.chats[chatId];
    if (!chat || (chat.readSeq >= chat.lastSeq && !chat.markedUnread)) return;
    this.upsertChat(cast<Chat>(await markChatRead(chatId, { seq: chat.lastSeq })));
  }

  async setChatState(chatId: string, state: { pinned?: boolean; archived?: boolean; unread?: boolean; mutedUntil?: string | null }): Promise<void> {
    this.upsertChat(cast<Chat>(await updateChatState(chatId, state)));
  }

  // ------------------------------------------------------------------------------ sending

  /** Queues a message (status "sending") and sends it; a retry reuses its client id. */
  send(chatId: string, text: string, replyToId: string | null): void {
    const item: PendingMessage = {
      clientId: crypto.randomUUID(),
      chatId,
      text,
      replyToId,
      createdAt: new Date().toISOString(),
      status: 'sending',
      error: null,
    };
    this.set({ outbox: [...this.snapshot.outbox, item] });
    void this.deliver(item);
  }

  retry(clientId: string): void {
    const item = this.snapshot.outbox.find((entry) => entry.clientId === clientId);
    if (!item) return;
    this.updatePending(clientId, { status: 'sending', error: null });
    void this.deliver({ ...item, status: 'sending', error: null });
  }

  discard(clientId: string): void {
    this.set({ outbox: this.snapshot.outbox.filter((entry) => entry.clientId !== clientId) });
  }

  private flushOutbox(): void {
    for (const item of this.snapshot.outbox) {
      if (item.status === 'sending' || (item.status === 'failed' && item.error === null)) {
        this.updatePending(item.clientId, { status: 'sending', error: null });
        void this.deliver(item);
      }
    }
  }

  private updatePending(clientId: string, change: Partial<PendingMessage>): void {
    this.set({ outbox: this.snapshot.outbox.map((entry) => (entry.clientId === clientId ? { ...entry, ...change } : entry)) });
  }

  private async deliver(item: PendingMessage): Promise<void> {
    if (this.sending.has(item.clientId)) return;
    this.sending.add(item.clientId);
    try {
      const message = cast<Message>(
        await sendMessage(item.chatId, { clientId: item.clientId, text: item.text, ...(item.replyToId ? { replyToId: item.replyToId } : {}) }),
      );
      const messages = this.snapshot.messages[item.chatId];
      this.set({
        outbox: this.snapshot.outbox.filter((entry) => entry.clientId !== item.clientId),
        ...(messages ? { messages: { ...this.snapshot.messages, [item.chatId]: mergeMessages(messages, [message]) } } : {}),
      });
      void this.refreshChat(item.chatId).catch(() => undefined);
    } catch (error) {
      // A network failure stays queued and is retried on reconnect; a refusal is shown with its reason.
      const network = error instanceof ApiError && error.code === 'NETWORK';
      this.updatePending(item.clientId, { status: 'failed', error: network ? null : errorMessage(error) });
    } finally {
      this.sending.delete(item.clientId);
    }
  }

  typing(chatId: string): void {
    const now = Date.now();
    if (now - (this.lastTypingSent.get(chatId) ?? 0) < TYPING_SEND_MS) return;
    this.lastTypingSent.set(chatId, now);
    void realtimeTyping({ chatId }).catch(() => undefined);
  }

  // ------------------------------------------------------------------------------ message actions

  private replaceMessage(message: Message): void {
    const list = this.snapshot.messages[message.chatId];
    if (!list) return;
    this.set({ messages: { ...this.snapshot.messages, [message.chatId]: mergeMessages(list, [message]) } });
  }

  /** A message the API returned (a poll vote, a new poll): shown at once, before sync confirms it. */
  replaceMessagePublic(message: Message): void {
    this.replaceMessage(message);
  }

  /** Phase 5: a chat this user left or deleted goes from this device at once (sync says the same later). */
  removeChatLocally(chatId: string): void {
    const chats = { ...this.snapshot.chats };
    const messages = { ...this.snapshot.messages };
    const pins = { ...this.snapshot.pins };
    delete chats[chatId];
    delete messages[chatId];
    delete pins[chatId];
    this.set({ chats, messages, pins });
  }

  async edit(messageId: string, text: string): Promise<void> {
    this.replaceMessage(cast<Message>(await editMessage(messageId, { text })));
  }

  async remove(chatId: string, messageIds: string[], scope: 'me' | 'both'): Promise<void> {
    await deleteMessages({ chatId, messageIds, scope });
    const ids = new Set(messageIds);
    const list = this.snapshot.messages[chatId] ?? [];
    const next =
      scope === 'me'
        ? list.filter((message) => !ids.has(message.id))
        : list.map((message) => (ids.has(message.id) ? { ...message, text: null, deleted: true, replyTo: message.replyTo } : message));
    this.set({
      messages: { ...this.snapshot.messages, [chatId]: next },
      pins: { ...this.snapshot.pins, [chatId]: (this.snapshot.pins[chatId] ?? []).filter((message) => !ids.has(message.id)) },
    });
    void this.refreshChat(chatId).catch(() => undefined);
  }

  async forward(fromChatId: string, messageIds: string[], chatIds: string[]): Promise<void> {
    const result = await forwardMessages({
      fromChatId,
      messageIds,
      targets: chatIds.map((chatId) => ({ chatId, clientId: crypto.randomUUID() })),
    });
    const messages = { ...this.snapshot.messages };
    for (const message of cast<Message[]>(result.messages)) {
      if (messages[message.chatId]) messages[message.chatId] = mergeMessages(messages[message.chatId] ?? [], [message]);
    }
    this.set({ messages });
    await Promise.all(chatIds.map((chatId) => this.refreshChat(chatId).catch(() => undefined)));
  }

  async setPinned(message: Message, pinned: boolean): Promise<void> {
    const updated = cast<Message>(pinned ? await pinMessage(message.id) : await unpinMessage(message.id));
    const current = (this.snapshot.pins[message.chatId] ?? []).filter((item) => item.id !== message.id);
    this.set({ pins: { ...this.snapshot.pins, [message.chatId]: pinned ? [updated, ...current] : current } }, false);
  }

  searchInChat(chatId: string, q: string, before?: number): Promise<Message[]> {
    return searchChat(chatId, { q, ...(before ? { before } : {}) }).then((result) => cast<Message[]>(result.messages));
  }

  /** Phase 8: messages, files, images and voice messages across every chat (D-42). */
  searchEverywhere(params: { q?: string; kind?: 'messages' | 'media' | 'files' | 'voice'; fromUserId?: string; after?: string; cursor?: string }): Promise<GlobalSearchResponse> {
    return searchEverywhere(params).then((result) => cast<GlobalSearchResponse>(result));
  }

  searchPeople(q: string): Promise<Peer[]> {
    return searchUsers({ q }).then((result) => cast<Peer[]>(result.users));
  }

  // ------------------------------------------------------------------------------ media (Phase 4)

  /** Uploads a prepared file with progress, then sends it (with an optional caption and reply). */
  sendFile(chatId: string, file: PreparedFile, caption: string | null, replyToId: string | null, sendAt: string | null = null): void {
    const item: PendingUpload = {
      clientId: crypto.randomUUID(),
      chatId,
      kind: file.kind,
      fileName: file.fileName ?? null,
      size: file.body.size,
      previewUrl: file.previewUrl,
      caption,
      replyToId,
      sendAt,
      progress: 0,
      status: 'uploading',
      error: null,
      createdAt: new Date().toISOString(),
    };
    this.uploadJobs.set(item.clientId, { file, fileId: null, uploaded: false, controller: new AbortController() });
    this.set({ uploads: [...this.snapshot.uploads, item] }, false);
    void this.deliverUpload(item.clientId);
  }

  retryUpload(clientId: string): void {
    const job = this.uploadJobs.get(clientId);
    if (!job) return;
    job.controller = new AbortController();
    void this.deliverUpload(clientId);
  }

  cancelUpload(clientId: string): void {
    const job = this.uploadJobs.get(clientId);
    job?.controller.abort();
    const item = this.snapshot.uploads.find((entry) => entry.clientId === clientId);
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    this.uploadJobs.delete(clientId);
    this.set({ uploads: this.snapshot.uploads.filter((entry) => entry.clientId !== clientId) }, false);
  }

  private updateUpload(clientId: string, change: Partial<PendingUpload>): void {
    this.set({ uploads: this.snapshot.uploads.map((entry) => (entry.clientId === clientId ? { ...entry, ...change } : entry)) }, false);
  }

  private async deliverUpload(clientId: string): Promise<void> {
    const job = this.uploadJobs.get(clientId);
    const item = this.snapshot.uploads.find((entry) => entry.clientId === clientId);
    if (!job || !item || this.sending.has(clientId)) return;
    this.sending.add(clientId);
    try {
      if (!job.fileId || !job.uploaded) {
        this.updateUpload(clientId, { status: 'uploading', error: null, progress: 0 });
        const { file } = job;
        const slot = await createUpload({
          chatId: item.chatId,
          kind: file.kind,
          mimeType: file.mimeType,
          size: file.body.size,
          ...(file.fileName ? { fileName: file.fileName } : {}),
          ...(file.width ? { width: file.width, height: file.height } : {}),
          ...(file.durationMs !== undefined ? { durationMs: file.durationMs } : {}),
          ...(file.waveform ? { waveform: file.waveform } : {}),
          ...(file.thumbnail ? { thumbnail: { mimeType: 'image/jpeg', size: file.thumbnail.size } } : {}),
        });
        job.fileId = slot.fileId;
        const total = file.body.size + (file.thumbnail?.size ?? 0);
        await uploadWithProgress(slot.upload.url, slot.upload.headers, file.body, (fraction) => this.updateUpload(clientId, { progress: (fraction * file.body.size) / total }), job.controller.signal);
        if (slot.thumbnailUpload && file.thumbnail) {
          await uploadWithProgress(slot.thumbnailUpload.url, slot.thumbnailUpload.headers, file.thumbnail, () => undefined, job.controller.signal).catch(() => undefined);
        }
        job.uploaded = true;
      }
      this.updateUpload(clientId, { status: 'sending', progress: 1 });
      if (item.sendAt) {
        // Phase 6: the file is checked now and sent by the server at the chosen time.
        await scheduleMessage(item.chatId, {
          sendAt: item.sendAt,
          message: { clientId, fileId: job.fileId!, ...(item.caption ? { text: item.caption } : {}), ...(item.replyToId ? { replyToId: item.replyToId } : {}) },
        });
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        this.uploadJobs.delete(clientId);
        this.set({ uploads: this.snapshot.uploads.filter((entry) => entry.clientId !== clientId) }, false);
        void Promise.all([this.loadScheduled(item.chatId), this.refreshChat(item.chatId)]).catch(() => undefined);
        return;
      }
      const message = cast<Message>(
        await sendMessage(item.chatId, {
          clientId,
          fileId: job.fileId!,
          ...(item.caption ? { text: item.caption } : {}),
          ...(item.replyToId ? { replyToId: item.replyToId } : {}),
        }),
      );
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      this.uploadJobs.delete(clientId);
      const messages = this.snapshot.messages[item.chatId];
      this.set({
        uploads: this.snapshot.uploads.filter((entry) => entry.clientId !== clientId),
        ...(messages ? { messages: { ...this.snapshot.messages, [item.chatId]: mergeMessages(messages, [message]) } } : {}),
      });
      void this.refreshChat(item.chatId).catch(() => undefined);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      // A refused file needs a new upload slot on retry.
      if (error instanceof ApiError && error.code === 'FILE_INVALID') {
        job.fileId = null;
        job.uploaded = false;
      }
      this.updateUpload(clientId, { status: 'failed', error: error instanceof ApiError ? errorMessage(error) : 'The upload failed. Check your connection.' });
    } finally {
      this.sending.delete(clientId);
    }
  }

  /** Sends a sticker or a GIF (nothing to upload). */
  async sendPicked(chatId: string, pick: { stickerId: string } | { gifId: string }, replyToId: string | null): Promise<void> {
    const message = cast<Message>(await sendMessage(chatId, { clientId: crypto.randomUUID(), ...pick, ...(replyToId ? { replyToId } : {}) }));
    this.replaceMessage(message);
    void this.refreshChat(chatId).catch(() => undefined);
  }

  /** A short-lived link to a message's file (5 minutes). */
  async fileUrl(messageId: string, download = false): Promise<string> {
    return (await getMessageFile(messageId, download ? { download: 'true' } : {})).url;
  }

  async react(message: Message, emoji: ReactionBody['emoji'] | null): Promise<void> {
    this.replaceMessage(cast<Message>(emoji ? await reactToMessage(message.id, { emoji }) : await removeReaction(message.id)));
  }

  async chatMedia(chatId: string, kind: MediaFilter, before?: number): Promise<Message[]> {
    return cast<Message[]>((await listChatMedia(chatId, { kind, ...(before ? { before } : {}) })).messages);
  }

  /** Sticker packs, fetched once per page load (and again after an error). */
  stickers(): Promise<StickerPack[]> {
    this.stickerPacks ??= listStickers()
      .then((result) => cast<StickerPack[]>(result.packs))
      .catch((error: unknown) => {
        this.stickerPacks = null;
        throw error;
      });
    return this.stickerPacks;
  }

  searchGifs(q: string, offset = 0): Promise<GifSearchResponse> {
    return searchGifs({ ...(q ? { q } : {}), ...(offset ? { offset } : {}) }).then((result) => cast<GifSearchResponse>(result));
  }

  // ------------------------------------------------------------------------------ notifications (Phase 7)

  /**
   * Tells the server which chat this device shows (page visible), so it is not pushed about that chat (D-41).
   * `force` repeats it (the server forgets it a minute after the device stops sending heartbeats).
   */
  viewing(chatId: string | null, force = false): void {
    if (!force && this.viewingChat === chatId) return;
    this.viewingChat = chatId;
    void realtimeViewing({ chatId }).catch(() => {
      this.viewingChat = undefined;
    });
  }

  // ------------------------------------------------------------------------------ channels, scheduling (Phase 6)

  /** What the signed-in user may create and do (O-21), fetched once per page load. */
  myPermissions(): Promise<UserPermissions> {
    this.permissions ??= getMyPermissions().catch((error: unknown) => {
      this.permissions = null;
      throw error;
    });
    return this.permissions;
  }

  async createChannel(body: { title: string; description?: string; isPublic: boolean }): Promise<Chat> {
    const chat = cast<Chat>(await apiCreateChannel(body));
    this.upsertChat(chat);
    return chat;
  }

  searchChannels(q: string): Promise<PublicChannel[]> {
    return apiSearchChannels({ q }).then((result) => cast<PublicChannel[]>(result.channels));
  }

  async joinChannel(channelId: string): Promise<Chat> {
    const chat = cast<Chat>(await apiJoinChannel(channelId));
    this.upsertChat(chat);
    return chat;
  }

  async loadScheduled(chatId: string): Promise<ScheduledMessage[]> {
    const list = cast<ScheduledMessage[]>((await listScheduledMessages(chatId)).scheduled);
    this.set({ scheduled: { ...this.snapshot.scheduled, [chatId]: list } }, false);
    return list;
  }

  /** Schedules a text message (files go through sendFile with a time). */
  async schedule(chatId: string, text: string, replyToId: string | null, sendAt: string): Promise<void> {
    await scheduleMessage(chatId, { sendAt, message: { clientId: crypto.randomUUID(), text, ...(replyToId ? { replyToId } : {}) } });
    await Promise.all([this.loadScheduled(chatId), this.refreshChat(chatId)]);
  }

  async reschedule(item: ScheduledMessage, sendAt: string): Promise<void> {
    await updateScheduledMessage(item.id, { sendAt });
    await this.loadScheduled(item.chatId);
  }

  async cancelScheduled(item: ScheduledMessage): Promise<void> {
    await cancelScheduledMessage(item.id);
    await Promise.all([this.loadScheduled(item.chatId), this.refreshChat(item.chatId)]);
  }

  async sendScheduledNow(item: ScheduledMessage): Promise<void> {
    this.replaceMessage(cast<Message>(await sendScheduledMessageNow(item.id)));
    await Promise.all([this.loadScheduled(item.chatId), this.refreshChat(item.chatId)]);
  }

  // ------------------------------------------------------------------------------ safety, folders

  async setBlocked(userId: string, blocked: boolean): Promise<void> {
    if (blocked) await blockUser(userId);
    else await unblockUser(userId);
    const chat = Object.values(this.snapshot.chats).find((item) => item.peer?.id === userId);
    if (chat) await this.refreshChat(chat.id);
  }

  async report(body: ReportBody): Promise<void> {
    await reportUser(body);
  }

  async createFolder(name: string, chatIds: string[]): Promise<void> {
    this.set({ folders: cast<Folder[]>((await createFolder({ name, chatIds })).folders) });
  }

  async updateFolder(folderId: string, change: { name?: string; chatIds?: string[] }): Promise<void> {
    this.set({ folders: cast<Folder[]>((await updateFolder(folderId, change)).folders) });
  }

  async deleteFolder(folderId: string): Promise<void> {
    this.set({ folders: cast<Folder[]>((await deleteFolder(folderId)).folders) });
  }
}
