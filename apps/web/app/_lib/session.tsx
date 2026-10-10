'use client';

import { logout as apiLogout } from '@bedo/api-client';
import type { AuthenticatedResponse, Me } from '@bedo/contracts';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiError, session, type SignedOutReason } from './api';
import { clearCache, loadAccount, saveAccount } from './messaging/cache';
import { unsubscribeThisBrowser } from './push';

type SessionState =
  | { status: 'loading' }
  | { status: 'signedOut'; reason: SignedOutReason | null }
  | { status: 'signedIn'; me: Me };

interface SessionValue {
  state: SessionState;
  signedIn(response: AuthenticatedResponse): void;
  setMe(me: Me): void;
  logout(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

/**
 * Why this tab was signed out, when it was a blocked or deleted account: the server forgets the session at once (its
 * cookie is cleared), so after a reload only this tab still knows why and can say so on the sign-in page.
 */
const REASON_KEY = 'bedo_signed_out_reason';

function keepReason(reason: SignedOutReason | null): void {
  try {
    if (reason === 'account_blocked' || reason === 'account_deleted') window.sessionStorage.setItem(REASON_KEY, reason);
    else if (reason === null) window.sessionStorage.removeItem(REASON_KEY);
  } catch {
    // Storage blocked: the reason is shown only until the page reloads.
  }
}

function keptReason(): SignedOutReason | null {
  try {
    const value = window.sessionStorage.getItem(REASON_KEY);
    return value === 'account_blocked' || value === 'account_deleted' ? value : null;
  } catch {
    return null;
  }
}

/** Holds the signed-in account for both screens; the session is restored from the refresh cookie on load. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    // Phase 3: the local message cache belongs to the session and is erased whenever it ends.
    session.onSignedOut((reason) => {
      void clearCache();
      // A request still in flight when the account was found blocked or deleted ends with "session ended" (the server
      // already forgot the session): the real reason, found first, is kept.
      const kept = keptReason();
      const final = reason === 'session_ended' && kept ? kept : reason;
      keepReason(final);
      setState({ status: 'signedOut', reason: final });
    });
    let cancelled = false;
    let settled = false;
    // Phase 14.4: the account saved on this browser opens the app at once (chats and messages come from the local
    // cache); the session is checked with the server at the same time and, if it has ended, the app signs out.
    void loadAccount().then((me) => {
      if (!cancelled && !settled && me && me.profileComplete) setState({ status: 'signedIn', me });
    });
    session
      .refresh()
      .then((response) => {
        settled = true;
        if (cancelled) return;
        keepReason(null);
        setState({ status: 'signedIn', me: response.user });
      })
      .catch((error: unknown) => {
        settled = true;
        if (cancelled) return;
        const code = error instanceof ApiError ? error.code : null;
        if (code === 'NETWORK') {
          // Offline: keep showing what this browser has (if anything); requests try the session again later.
          void loadAccount().then((me) => !cancelled && setState(me && me.profileComplete ? { status: 'signedIn', me } : { status: 'signedOut', reason: null }));
          return;
        }
        // A blocked or deleted account found earlier in this tab keeps its explanation after a reload.
        const reason = code === 'ACCOUNT_DELETED' ? 'account_deleted' : code === 'ACCOUNT_BLOCKED' ? 'account_blocked' : keptReason();
        keepReason(reason);
        if (error instanceof ApiError) void clearCache();
        setState({ status: 'signedOut', reason });
      });
    return () => {
      cancelled = true;
      session.onSignedOut(null);
    };
  }, []);

  // The current account is kept for the next visit.
  useEffect(() => {
    if (state.status === 'signedIn') void saveAccount(state.me);
  }, [state]);

  const signedIn = useCallback((response: AuthenticatedResponse) => {
    keepReason(null);
    session.setSession(response);
    setState({ status: 'signedIn', me: response.user });
  }, []);

  const setMe = useCallback((me: Me) => setState({ status: 'signedIn', me }), []);

  const logout = useCallback(async () => {
    await unsubscribeThisBrowser().catch(() => undefined);
    await apiLogout().catch(() => undefined);
    session.clear();
    await clearCache();
    setState({ status: 'signedOut', reason: 'signed_out' });
  }, []);

  const value = useMemo(() => ({ state, signedIn, setMe, logout }), [state, signedIn, setMe, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used inside SessionProvider');
  }
  return value;
}

/** For screens that only render when signed in. */
export function useMe(): Me {
  const { state } = useSession();
  if (state.status !== 'signedIn') {
    throw new Error('Not signed in');
  }
  return state.me;
}
