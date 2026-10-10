import type { Chat, Folder, Me, Message } from '@bedo/contracts';
import { clearMediaCache } from '../media-cache';

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

/**
 * The shape of cached messages; a cache in an older shape is dropped (Phase 4 added files, stickers, reactions;
 * Phase 6 channels, scheduled counts and forward origins).
 */
export const CACHE_FORMAT = 3;

export interface CachedState {
  /** CACHE_FORMAT when written (missing before Phase 4). */
  format?: number;
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
/** Phase 14.4: the signed-in account, so the app opens straight away on the next visit. */
const ACCOUNT_KEY = 'account';
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
  if (state.userId !== userId || state.format !== CACHE_FORMAT) {
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
    format: CACHE_FORMAT,
    messages: Object.fromEntries(Object.entries(state.messages).map(([chatId, list]) => [chatId, list.slice(-CACHED_MESSAGES_PER_CHAT)])),
  };
  await run<unknown>('readwrite', (store) => (started === generation && !closed ? store.put(trimmed, KEY) : store.count()) as IDBRequest<unknown>);
}

export async function clearCache(): Promise<void> {
  generation += 1;
  closed = true;
  await run('readwrite', (store) => store.delete(KEY));
  await run('readwrite', (store) => store.delete(ACCOUNT_KEY));
  await clearMediaCache();
}

/**
 * Phase 14.4: the account last signed in on this browser, shown at once on the next visit while the session is
 * checked with the server in the background. Erased with the rest of the cache when the session ends.
 */
export async function loadAccount(): Promise<Me | null> {
  const stored = await run<{ format: number; me: Me }>('readonly', (store) => store.get(ACCOUNT_KEY) as IDBRequest<{ format: number; me: Me }>);
  return stored && stored.format === CACHE_FORMAT && stored.me?.id ? stored.me : null;
}

export async function saveAccount(me: Me): Promise<void> {
  await run<unknown>('readwrite', (store) => store.put({ format: CACHE_FORMAT, me }, ACCOUNT_KEY) as IDBRequest<unknown>);
}
