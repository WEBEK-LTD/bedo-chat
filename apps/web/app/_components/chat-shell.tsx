'use client';

import { listSecurityNotices, markSecurityNoticesRead, type SecurityNoticesResponseNoticesItem as SecurityNotice } from '@bedo/api-client';
import { BrandIcon, Icon } from '@bedo/ui';
import { badgeCount } from '@bedo/contracts';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { MessagingProvider, useMessaging, useMessagingStore } from '../_lib/messaging/context';
import { appSetBadge } from '../_lib/native-app';
import { enablePush, pushBannerSnoozed, pushTurnedOff, resumePush, snoozePushBanner } from '../_lib/push';
import { useSession } from '../_lib/session';
import { useSwipeBack } from '../_lib/swipe-back';
import { useVisualViewportFit } from '../_lib/visual-viewport';
import { ChatList } from './chat/chat-list';
import { ChatView } from './chat/chat-view';
import { JoinDialog, NewChannelDialog, NewGroupDialog } from './chat/groups';
import { SettingsDrawer, type SettingsSection } from './settings/settings-drawer';
import { noticeText } from './settings/notifications-panel';
import { Button } from './ui';

const JOIN_KEY = 'bedo-join-code';

/**
 * Chat interface (spec §23). Only signed-in accounts with a name reach it (P-03). Account settings open
 * as a panel inside it. Phase 3: the chat list and private chats, on this one route (/).
 */
export function ChatShell() {
  const router = useRouter();
  const { state } = useSession();
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [alert, setAlert] = useState<SecurityNotice | null>(null);
  /** D-55: notifications are not on for this device yet and a click is needed to ask: offer the button. */
  const [offerPush, setOfferPush] = useState(false);

  useEffect(() => {
    if (state.status === 'signedOut' || (state.status === 'signedIn' && !state.me.profileComplete)) {
      // An invite link opened while signed out is remembered for after sign-in (this tab only).
      const code = new URLSearchParams(window.location.search).get('join');
      try {
        if (code) sessionStorage.setItem(JOIN_KEY, code);
      } catch {
        // Storage unavailable: the link has to be opened again after sign-in.
      }
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
    void resumePush()
      .then((push) => setOfferPush(push === 'off' && !pushTurnedOff() && !pushBannerSnoozed()))
      .catch(() => undefined);
    const onFocus = () => void loadAlerts().catch(() => undefined);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [signedIn, loadAlerts]);

  if (!signedIn) {
    return <div className="grid h-full place-items-center text-sm text-ink-secondary">Loading…</div>;
  }
  const me = state.me;

  async function turnOnPush() {
    const push = await enablePush().catch(() => 'off' as const);
    if (push !== 'off') setOfferPush(false);
  }

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
        offerPush={offerPush}
        onTurnOnPush={() => void turnOnPush()}
        onSnoozePush={() => {
          snoozePushBanner();
          setOfferPush(false);
        }}
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
  offerPush,
  onTurnOnPush,
  onSnoozePush,
  onOpenSettings,
  settings,
}: {
  myId: string;
  deletionRequested: boolean;
  alert: SecurityNotice | null;
  onDismissAlert: () => void;
  offerPush: boolean;
  onTurnOnPush: () => void;
  onSnoozePush: () => void;
  onOpenSettings: (section: SettingsSection) => void;
  settings: ReactNode;
}) {
  const messaging = useMessaging();
  const store = useMessagingStore();
  // iPhone: the chat screen stays within the visible part of the page when the keyboard opens.
  useVisualViewportFit();
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Phase 8: a search result to show once its chat is open. */
  const [jump, setJump] = useState<{ chatId: string; id: string; seq: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chat = selectedId ? messaging.chats[selectedId] : undefined;
  // Phase 16.13: on phones the open chat is swiped right to go back to the list, which shows underneath meanwhile.
  const listRef = useRef<HTMLElement>(null);
  const chatRef = useRef<HTMLElement>(null);
  const [peeking, setPeeking] = useState(false);
  const closeChat = useCallback(() => setSelectedId(null), []);
  useSwipeBack(chatRef, chat ? closeChat : null, { under: listRef, onPeek: setPeeking });
  const [newGroup, setNewGroup] = useState(false);
  const [mayCreateGroups, setMayCreateGroups] = useState(false);
  const [newChannel, setNewChannel] = useState(false);
  const [mayCreateChannels, setMayCreateChannels] = useState(false);
  const [joinCode, setJoinCode] = useState<string | null>(null);
  useEffect(() => {
    void store
      .myPermissions()
      .then((permissions) => {
        setMayCreateGroups(permissions.createGroups);
        setMayCreateChannels(permissions.createChannels);
      })
      .catch(() => undefined);
    // Phase 5: an invite link (https://bedochat.com/?join=<code>) opens its preview once signed in.
    let code = new URLSearchParams(window.location.search).get('join');
    try {
      code ??= sessionStorage.getItem(JOIN_KEY);
      sessionStorage.removeItem(JOIN_KEY);
    } catch {
      // Storage unavailable.
    }
    if (code && /^[A-Za-z0-9_-]{22}$/.test(code)) setJoinCode(code);
  }, [store]);
  // Phase 7: a notification opens its chat: ?chat=<id> when the app was closed, a message from the service worker
  // when it was open.
  useEffect(() => {
    const open = (url: string) => {
      const chatId = new URL(url, window.location.origin).searchParams.get('chat');
      if (chatId && /^[0-9a-f-]{36}$/.test(chatId)) setSelectedId(chatId);
    };
    open(window.location.href);
    if (new URLSearchParams(window.location.search).has('chat')) window.history.replaceState(null, '', '/');
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; url?: string } | null;
      if (data?.type === 'bedo-open' && typeof data.url === 'string') open(data.url);
    };
    // D-53: the iPhone app, when a notification is tapped while the app is open.
    const onAppOpen = (event: Event) => {
      const url = (event as CustomEvent<unknown>).detail;
      if (typeof url === 'string') open(url);
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    window.addEventListener('bedo-app-open', onAppOpen);
    return () => {
      navigator.serviceWorker?.removeEventListener('message', onMessage);
      window.removeEventListener('bedo-app-open', onAppOpen);
    };
  }, []);
  // Phase 7: the badge (tab title and app icon) from the server's unread counts, the same on every device (D-41).
  const badge = badgeCount(Object.values(messaging.chats));
  useEffect(() => {
    document.title = badge > 0 ? `(${badge}) Bedo Chat` : 'Bedo Chat';
    const nav = navigator as Navigator & { setAppBadge?: (count: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    void (badge > 0 ? nav.setAppBadge?.(badge) : nav.clearAppBadge?.())?.catch(() => undefined);
    appSetBadge(badge);
  }, [badge]);
  // A chat that disappears (left, removed, group deleted) closes.
  useEffect(() => {
    if (selectedId && messaging.status === 'ready' && !messaging.chats[selectedId]) setSelectedId(null);
  }, [selectedId, messaging.status, messaging.chats]);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);

  return (
    <div className="bedo-app-viewport grid grid-cols-1 md:grid-cols-[var(--bedo-chat-list-width)_1fr]">
      <aside ref={listRef} className={`relative min-h-0 flex-col border-line max-md:[grid-area:1/1] md:flex md:border-r ${chat && !peeking ? 'hidden' : 'flex'}`} aria-label="Chats" aria-hidden={chat && peeking ? true : undefined}>
        <header className="flex h-[var(--bedo-header-height)] shrink-0 items-center gap-2 px-2">
          <button
            type="button"
            aria-label="Settings"
            onClick={() => onOpenSettings('menu')}
            className="grid size-10 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink"
          >
            <Icon name="menu" />
          </button>
          <label className="flex h-10 flex-1 items-center gap-2 rounded-full border border-transparent bg-surface-subtle px-3.5 text-ink-secondary transition-colors focus-within:border-accent/50 focus-within:bg-surface">
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
          {mayCreateGroups ? (
            <button type="button" aria-label="New group" onClick={() => setNewGroup(true)} className="grid size-10 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink">
              <Icon name="group_add" />
            </button>
          ) : null}
          {mayCreateChannels ? (
            <button type="button" aria-label="New channel" onClick={() => setNewChannel(true)} className="grid size-10 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink">
              <Icon name="campaign" />
            </button>
          ) : null}
        </header>

        {deletionRequested ? (
          <div className="mx-3 mb-2 flex items-start gap-2 rounded-md bg-surface-subtle p-3 text-sm">
            <Icon name="info" size={20} className="shrink-0 text-ink-secondary" />
            <span>Account deletion requested. An administrator will review your request.</span>
          </div>
        ) : null}

        {alert ? (
          <div role="status" className="mx-3 mb-2 flex flex-col gap-2 rounded-md border border-line bg-accent-soft/50 p-3 text-sm">
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

        {offerPush ? (
          <div role="region" aria-label="Get notifications" className="mx-3 mb-2 flex flex-col gap-2 rounded-md border border-line bg-accent-soft/50 p-3 text-sm">
            <div className="flex items-start gap-2">
              <Icon name="notifications_active" size={20} className="shrink-0 text-accent" />
              <span>Turn on notifications to know when new messages arrive, even when Bedo Chat is closed.</span>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" className="h-8 px-2" onClick={onSnoozePush}>
                Not now
              </Button>
              <Button className="h-8 px-3" onClick={onTurnOnPush}>
                Turn on
              </Button>
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
          onOpenMessage={(message) => {
            setSelectedId(message.chatId);
            setJump({ chatId: message.chatId, id: message.id, seq: message.seq });
          }}
          onNotice={showNotice}
        />

        {settings}
      </aside>

      <main ref={chatRef} className={`relative min-h-0 max-md:z-10 max-md:[grid-area:1/1] md:flex ${chat ? 'flex' : 'hidden'} ${chat ? 'flex-col bg-surface' : 'bedo-wallpaper items-center justify-center'}`}>
        {chat ? (
          <ChatView
            chat={chat}
            myId={myId}
            jump={jump?.chatId === chat.id ? jump : null}
            onJumped={() => setJump(null)}
            onBack={closeChat}
            onNotice={showNotice}
          />
        ) : (
          <div className="flex flex-col items-center gap-4">
            <BrandIcon size={88} className="opacity-90 drop-shadow-md" />
            <p className="rounded-full bg-scrim/30 px-4 py-1.5 text-sm font-medium text-white">Select a chat to start messaging.</p>
          </div>
        )}
      </main>

      {newGroup ? (
        <NewGroupDialog
          onClose={() => setNewGroup(false)}
          onCreated={(created) => {
            setNewGroup(false);
            setSelectedId(created.id);
          }}
        />
      ) : null}
      {newChannel ? (
        <NewChannelDialog
          onClose={() => setNewChannel(false)}
          onCreated={(created) => {
            setNewChannel(false);
            setSelectedId(created.id);
          }}
        />
      ) : null}
      {joinCode ? (
        <JoinDialog
          code={joinCode}
          onClose={() => {
            setJoinCode(null);
            window.history.replaceState(null, '', '/');
          }}
          onJoined={(chatId) => {
            setJoinCode(null);
            window.history.replaceState(null, '', '/');
            setSelectedId(chatId);
          }}
        />
      ) : null}
      {notice ? (
        <div role="status" className="fixed inset-x-0 bottom-5 z-50 mx-auto w-fit max-w-[calc(100%-2rem)] rounded-full bg-ink px-5 py-2.5 text-sm font-medium text-surface shadow-raised bedo-pop-in">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
