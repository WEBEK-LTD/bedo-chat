import {
  blockUser,
  createFolder,
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
  reportUser,
  searchChat,
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
  type Message,
  MESSAGING_RULES,
  type Peer,
  type Presence,
  type RealtimeServerMessage,
  type ReportBody,
  type SyncResponse,
} from '@bedo/contracts';
import { ApiError, errorMessage } from '../api';
import { type CachedState, clearCache, loadCache, type PendingMessage, saveCache } from './cache';
import { type ConnectionState, RealtimeClient } from './realtime';

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
  folders: Folder[];
  /** chatId -> time (ms) the other participant's typing indicator ends. */
  typing: Record<string, number>;
  /** Live presence of users from realtime events, newer than the chat summaries. */
  presence: Record<string, Presence | null>;
}

const EMPTY: MessagingSnapshot = {
  status: 'loading',
  connection: 'connecting',
  chats: {},
  messages: {},
  hasOlder: {},
  pins: {},
  outbox: [],
  folders: [],
  typing: {},
  presence: {},
};

const PAGE = MESSAGING_RULES.refetchPageSize;
const TYPING_MS = MESSAGING_RULES.typingSeconds * 1000;
/** Typing is sent at most this often while the user keeps typing (the indicator lasts 6 s). */
const TYPING_SEND_MS = 3_000;
/** Without a realtime connection, sync over HTTP this often. */
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
 * the realtime connection and sync (P-17), cached locally for a fast start and offline reading. Every change
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
  private readonly lastTypingSent = new Map<string, number>();
  private readonly sending = new Set<string>();
  private stopped = false;

  constructor() {
    this.realtime = new RealtimeClient({
      onReady: (serverSeq) => void this.onReady(serverSeq),
      onMessage: (message) => this.onRealtime(message),
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
      if (this.snapshot.connection !== 'online') void this.httpSync();
    }, POLL_MS);
    if (!cached) {
      // Without a cache, show the chat list as soon as possible, even before the socket is up.
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

  private async onReady(serverSeq: number): Promise<void> {
    if (!this.initialized) {
      await this.fullFetch(serverSeq).catch(() => undefined);
    }
    this.realtime.send({ type: 'sync', since: this.seq });
    this.flushOutbox();
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

  private onRealtime(message: RealtimeServerMessage): void {
    switch (message.type) {
      case 'updates':
        void this.applySync(message.sync);
        return;
      case 'typing': {
        const until = Date.now() + TYPING_MS;
        this.set({ typing: { ...this.snapshot.typing, [message.chatId]: until } }, false);
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

  /** Sync over HTTP, used while the realtime connection is down. */
  private async httpSync(): Promise<void> {
    if (this.httpSyncing || !this.initialized) return;
    this.httpSyncing = true;
    try {
      for (let page = 0; page < 20; page += 1) {
        const result = cast<SyncResponse>(await fetchSync({ since: this.seq }));
        const more = await this.applySync(result);
        if (!more) break;
      }
    } catch {
      // Offline: try again on the next tick.
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
    for (const chat of result.chats) delete presence[chat.peer.id];
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
    for (const update of result.updates) {
      const chatId = update.chatId;
      if (!chatId) continue;
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
    return result.hasMore;
  }

  /** Tells the sender this device received their messages (status "delivered"). */
  private acknowledge(chatId: string, seq: number): void {
    if (!this.realtime.send({ type: 'delivered', chatId, seq })) {
      void markChatDelivered(chatId, { seq }).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------------------ chats

  upsertChat(chat: Chat): void {
    const presence = { ...this.snapshot.presence };
    delete presence[chat.peer.id];
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

  async setChatState(chatId: string, state: { pinned?: boolean; archived?: boolean; unread?: boolean }): Promise<void> {
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
    this.realtime.send({ type: 'typing', chatId });
  }

  // ------------------------------------------------------------------------------ message actions

  private replaceMessage(message: Message): void {
    const list = this.snapshot.messages[message.chatId];
    if (!list) return;
    this.set({ messages: { ...this.snapshot.messages, [message.chatId]: mergeMessages(list, [message]) } });
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

  searchPeople(q: string): Promise<Peer[]> {
    return searchUsers({ q }).then((result) => cast<Peer[]>(result.users));
  }

  // ------------------------------------------------------------------------------ safety, folders

  async setBlocked(userId: string, blocked: boolean): Promise<void> {
    if (blocked) await blockUser(userId);
    else await unblockUser(userId);
    const chat = Object.values(this.snapshot.chats).find((item) => item.peer.id === userId);
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
