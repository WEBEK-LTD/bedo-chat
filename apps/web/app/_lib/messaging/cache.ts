import type { Chat, Folder, Message } from '@bedo/contracts';

/**
 * Local cache (blueprint: Client apps, "Local cache"): recent chats and messages kept in this browser for a
 * fast start and offline reading. The server stays the source of truth; the cache is replaced by whatever
 * the server says on every sync. It belongs to one account and is erased when that account signs out or the
 * session ends, and when another account signs in on this browser.
 */
export interface PendingMessage {
  clientId: string;
  chatId: string;
  text: string;
  replyToId: string | null;
  createdAt: string;
  status: 'sending' | 'failed';
  /** Why it failed, when the server refused it (shown to the user). */
  error: string | null;
}

export interface CachedState {
  userId: string;
  seq: number;
  chats: Chat[];
  /** The newest messages of each chat (at most 50 each). */
  messages: Record<string, Message[]>;
  folders: Folder[];
  outbox: PendingMessage[];
}

const DB_NAME = 'bedo-chat';
const STORE = 'state';
const KEY = 'current';
/** Messages kept per chat in the cache. */
export const CACHED_MESSAGES_PER_CHAT = 50;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    // Private windows or blocked storage: run without a cache.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    return await new Promise<T | null>((resolve) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result ?? null);
      transaction.onerror = () => resolve(null);
      transaction.onabort = () => resolve(null);
    });
  } finally {
    db.close();
  }
}

/** Incremented by every clear, so a save that started before a sign-out never writes after it. */
let generation = 0;
/** Set by a clear (sign-out): no save is accepted until an account loads its cache again. */
let closed = false;

/** The cached state of this account, or null (nothing cached, or another account's cache, which is erased). */
export async function loadCache(userId: string): Promise<CachedState | null> {
  closed = false;
  const state = await run<CachedState>('readonly', (store) => store.get(KEY) as IDBRequest<CachedState>);
  if (!state) return null;
  if (state.userId !== userId) {
    await clearCache();
    // The cache now belongs to the account that is signing in.
    closed = false;
    return null;
  }
  return state;
}

export async function saveCache(state: CachedState): Promise<void> {
  if (closed) return;
  const started = generation;
  const trimmed: CachedState = {
    ...state,
    messages: Object.fromEntries(Object.entries(state.messages).map(([chatId, list]) => [chatId, list.slice(-CACHED_MESSAGES_PER_CHAT)])),
  };
  await run<unknown>('readwrite', (store) => (started === generation && !closed ? store.put(trimmed, KEY) : store.count()) as IDBRequest<unknown>);
}

export async function clearCache(): Promise<void> {
  generation += 1;
  closed = true;
  await run('readwrite', (store) => store.delete(KEY));
}
