'use client';

import { logout as apiLogout } from '@bedo/api-client';
import type { AuthenticatedResponse, Me } from '@bedo/contracts';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiError, session, type SignedOutReason } from './api';
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

/** Holds the signed-in account for both screens; the session is restored from the refresh cookie on load. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    session.onSignedOut((reason) => setState({ status: 'signedOut', reason }));
    let cancelled = false;
    session
      .refresh()
      .then((response) => {
        if (!cancelled) setState({ status: 'signedIn', me: response.user });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const code = error instanceof ApiError ? error.code : null;
        const reason = code === 'ACCOUNT_DELETED' ? 'account_deleted' : code === 'ACCOUNT_BLOCKED' ? 'account_blocked' : null;
        setState({ status: 'signedOut', reason });
      });
    return () => {
      cancelled = true;
      session.onSignedOut(null);
    };
  }, []);

  const signedIn = useCallback((response: AuthenticatedResponse) => {
    session.setSession(response);
    setState({ status: 'signedIn', me: response.user });
  }, []);

  const setMe = useCallback((me: Me) => setState({ status: 'signedIn', me }), []);

  const logout = useCallback(async () => {
    await unsubscribeThisBrowser().catch(() => undefined);
    await apiLogout().catch(() => undefined);
    session.clear();
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
