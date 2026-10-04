'use client';

import { listSecurityNotices, markSecurityNoticesRead, type SecurityNoticesResponseNoticesItem as SecurityNotice } from '@bedo/api-client';
import { Icon } from '@bedo/ui';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { MessagingProvider, useMessaging } from '../_lib/messaging/context';
import { resumePush } from '../_lib/push';
import { useSession } from '../_lib/session';
import { ChatList } from './chat/chat-list';
import { ChatView } from './chat/chat-view';
import { SettingsDrawer, type SettingsSection } from './settings/settings-drawer';
import { noticeText } from './settings/notifications-panel';
import { Button } from './ui';

/**
 * Chat interface (spec §23). Only signed-in accounts with a name reach it (P-03). Account settings open
 * as a panel inside it. Phase 3: the chat list and private chats, on this one route (/).
 */
export function ChatShell() {
  const router = useRouter();
  const { state } = useSession();
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [alert, setAlert] = useState<SecurityNotice | null>(null);

  useEffect(() => {
    if (state.status === 'signedOut' || (state.status === 'signedIn' && !state.me.profileComplete)) {
      router.replace('/login');
    }
  }, [state, router]);

  const signedIn = state.status === 'signedIn' && state.me.profileComplete;

  const loadAlerts = useCallback(async () => {
    const response = await listSecurityNotices();
    setAlert(response.notices.find((notice) => !notice.read) ?? null);
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    void loadAlerts().catch(() => undefined);
    void resumePush().catch(() => undefined);
    const onFocus = () => void loadAlerts().catch(() => undefined);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [signedIn, loadAlerts]);

  if (!signedIn) {
    return <div className="grid h-full place-items-center text-sm text-ink-secondary">Loading…</div>;
  }
  const me = state.me;

  async function dismissAlert() {
    if (!alert) return;
    await markSecurityNoticesRead({ ids: [alert.id] }).catch(() => undefined);
    await loadAlerts().catch(() => undefined);
  }

  return (
    <MessagingProvider userId={me.id}>
      <ChatArea
        myId={me.id}
        deletionRequested={me.status === 'deletion_requested'}
        alert={alert}
        onDismissAlert={() => void dismissAlert()}
        onOpenSettings={setSettings}
        settings={
          settings ? (
            <SettingsDrawer
              section={settings}
              onNavigate={setSettings}
              onClose={() => {
                setSettings(null);
                void loadAlerts().catch(() => undefined);
              }}
            />
          ) : null
        }
      />
    </MessagingProvider>
  );
}

/** The chat list and the open chat; one pane on phones, two side by side from tablet width up. */
function ChatArea({
  myId,
  deletionRequested,
  alert,
  onDismissAlert,
  onOpenSettings,
  settings,
}: {
  myId: string;
  deletionRequested: boolean;
  alert: SecurityNotice | null;
  onDismissAlert: () => void;
  onOpenSettings: (section: SettingsSection) => void;
  settings: ReactNode;
}) {
  const messaging = useMessaging();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chat = selectedId ? messaging.chats[selectedId] : undefined;

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[var(--bedo-chat-list-width)_1fr]">
      <aside className={`relative min-h-0 flex-col border-line md:flex md:border-r ${chat ? 'hidden' : 'flex'}`} aria-label="Chats">
        <header className="flex h-[var(--bedo-header-height)] shrink-0 items-center gap-2 px-2">
          <button
            type="button"
            aria-label="Settings"
            onClick={() => onOpenSettings('menu')}
            className="grid size-10 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover"
          >
            <Icon name="menu" />
          </button>
          <label className="flex h-9 flex-1 items-center gap-2 rounded-sm bg-surface-subtle px-3 text-ink-secondary">
            <Icon name="search" size={20} />
            <span className="sr-only">Search</span>
            <input
              type="search"
              placeholder="Search"
              value={query}
              maxLength={64}
              onChange={(event) => setQuery(event.target.value)}
              className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-secondary"
            />
          </label>
        </header>

        {deletionRequested ? (
          <div className="mx-2 mb-2 flex items-start gap-2 rounded-md bg-surface-subtle p-3 text-sm">
            <Icon name="info" size={20} className="shrink-0 text-ink-secondary" />
            <span>Account deletion requested. An administrator will review your request.</span>
          </div>
        ) : null}

        {alert ? (
          <div role="status" className="mx-2 mb-2 flex flex-col gap-2 rounded-md border border-line p-3 text-sm">
            <div className="flex items-start gap-2">
              <Icon name="shield" size={20} className="shrink-0 text-accent" />
              <span>{noticeText(alert)}</span>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" className="h-8 px-2" onClick={onDismissAlert}>
                Dismiss
              </Button>
              {alert.kind === 'new_login' ? (
                <Button variant="secondary" className="h-8 px-3" onClick={() => onOpenSettings('devices')}>
                  Review devices
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <ChatList
          myId={myId}
          query={query}
          selectedId={selectedId}
          onSelect={(chatId) => {
            setSelectedId(chatId);
            setQuery('');
          }}
          onNotice={showNotice}
        />

        {settings}
      </aside>

      <main className={`min-h-0 md:flex ${chat ? 'flex' : 'hidden'} ${chat ? 'flex-col' : 'items-center justify-center bg-surface-subtle'}`}>
        {chat ? (
          <ChatView chat={chat} myId={myId} onBack={() => setSelectedId(null)} onNotice={showNotice} />
        ) : (
          <p className="text-sm text-ink-secondary">Select a chat to start messaging.</p>
        )}
      </main>

      {notice ? (
        <div role="status" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md bg-ink px-4 py-2 text-sm text-surface">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
