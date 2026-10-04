'use client';

import { createContext, type ReactNode, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { type MessagingSnapshot, MessagingStore } from './store';

const StoreContext = createContext<MessagingStore | null>(null);

/** Starts messaging for the signed-in account and stops it (and forgets its state) when it changes. */
export function MessagingProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [store] = useState(() => new MessagingStore());
  useEffect(() => {
    void store.start(userId);
    return () => store.stop();
  }, [store, userId]);
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useMessagingStore(): MessagingStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useMessagingStore must be used inside MessagingProvider');
  return store;
}

export function useMessaging(): MessagingSnapshot {
  const store = useMessagingStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
