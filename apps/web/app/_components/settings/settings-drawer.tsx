'use client';

import { Icon, type IconName } from '@bedo/ui';
import { useEffect, useRef, useState } from 'react';
import { useSession } from '../../_lib/session';
import { useSwipeBack } from '../../_lib/swipe-back';
import { Avatar, IconButton } from '../ui';
import { AppearancePanel } from './appearance-panel';
import { DeleteAccountPanel } from './delete-account-panel';
import { DevicesPanel } from './devices-panel';
import { NotificationsPanel } from './notifications-panel';
import { PhonePanel } from './phone-panel';
import { PrivacyPanel } from './privacy-panel';
import { ProfilePanel } from './profile-panel';
import { TwoStepPanel } from './two-step-panel';

export type SettingsSection = 'menu' | 'profile' | 'phone' | 'privacy' | 'devices' | 'two-step' | 'notifications' | 'appearance' | 'delete';

const TITLES: Record<SettingsSection, string> = {
  menu: 'Settings',
  profile: 'Edit profile',
  phone: 'Change phone number',
  privacy: 'Privacy',
  devices: 'Devices',
  'two-step': '2-Step Verification',
  notifications: 'Notifications',
  appearance: 'Appearance',
  delete: 'Delete account',
};

// Each item has a coloured icon tile (one of the shared avatar tones), so the list is quick to scan.
const MENU: Array<{ section: SettingsSection; icon: IconName; label: string; tone: number }> = [
  { section: 'profile', icon: 'account_circle', label: 'Edit profile', tone: 5 },
  { section: 'privacy', icon: 'privacy_tip', label: 'Privacy', tone: 3 },
  { section: 'devices', icon: 'devices', label: 'Devices', tone: 4 },
  { section: 'two-step', icon: 'key', label: '2-Step Verification', tone: 1 },
  { section: 'notifications', icon: 'notifications', label: 'Notifications', tone: 6 },
  { section: 'appearance', icon: 'palette', label: 'Appearance', tone: 2 },
  { section: 'delete', icon: 'person_remove', label: 'Delete account', tone: 0 },
];

/** Account settings as a panel over the chat list, never a separate page (spec §23). */
export function SettingsDrawer({
  section,
  onNavigate,
  onClose,
}: {
  section: SettingsSection;
  onNavigate: (section: SettingsSection) => void;
  onClose: () => void;
}) {
  const { state, logout } = useSession();
  const panel = useRef<HTMLElement>(null);
  const underneath = useRef<HTMLElement>(null);
  const [peeking, setPeeking] = useState(false);
  const previous: SettingsSection | null = section === 'menu' ? null : section === 'phone' ? 'profile' : 'menu';
  const back = previous ? () => onNavigate(previous) : onClose;
  // Phase 16.13: swipe right goes back a page (or closes Settings), like the back arrow; the previous page shows
  // underneath while swiping, as in Telegram.
  useSwipeBack(panel, back, { under: underneath, onPeek: setPeeking });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (state.status !== 'signedIn') return null;
  const me = state.me;

  const page = (current: SettingsSection, top: boolean) => (
    <section
      key={top ? 'top' : 'under'}
      ref={top ? panel : underneath}
      role={top ? 'dialog' : undefined}
      aria-modal={top ? true : undefined}
      aria-label={top ? TITLES[current] : undefined}
      aria-hidden={top ? undefined : true}
      className={`absolute inset-0 flex flex-col bg-surface ${top ? 'z-10' : peeking ? 'z-[9]' : 'hidden'}`}
    >
      <header className="bedo-glass relative z-10 flex h-[var(--bedo-header-height)] shrink-0 items-center gap-2 border-b border-line px-2">
        <IconButton icon={current === 'menu' ? 'close' : 'arrow_back'} label={current === 'menu' ? 'Close' : 'Back'} onClick={top ? back : () => undefined} />
        <h2 className="font-semibold">{TITLES[current]}</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {current === 'menu' && (
          <nav className="flex flex-col gap-0.5 px-2 py-2">
            <div className="mb-2 flex items-center gap-4 px-3 py-4">
              <Avatar name={me.name} photoUrl={me.photoUrl} size={64} />
              <div className="min-w-0">
                <p className="truncate text-lg font-semibold">{me.name}</p>
                <p className="truncate text-sm text-ink-secondary">{me.phone}</p>
                {me.username ? <p className="truncate text-sm text-ink-secondary">@{me.username}</p> : null}
              </div>
            </div>
            {MENU.map((item) => (
              <button
                key={item.section}
                type="button"
                onClick={() => onNavigate(item.section)}
                className="flex h-12 items-center gap-4 rounded-md px-3 text-left transition-colors hover:bg-surface-hover"
              >
                <span className={`grid size-8 shrink-0 place-items-center rounded-[9px] text-white bedo-tone-${item.tone}`}>
                  <Icon name={item.icon} size={20} />
                </span>
                <span className="flex-1">{item.label}</span>
                <Icon name="chevron_right" size={20} className="text-ink-secondary" />
              </button>
            ))}
            <button type="button" onClick={() => void logout()} className="mt-2 flex h-12 items-center gap-4 rounded-md px-3 text-left text-danger transition-colors hover:bg-surface-hover">
              <span className="grid size-8 shrink-0 place-items-center">
                <Icon name="logout" />
              </span>
              <span>Log out</span>
            </button>
          </nav>
        )}
        {current === 'profile' && <ProfilePanel onChangePhone={() => onNavigate('phone')} />}
        {current === 'phone' && <PhonePanel onDone={() => onNavigate('profile')} />}
        {current === 'privacy' && <PrivacyPanel />}
        {current === 'devices' && <DevicesPanel />}
        {current === 'two-step' && <TwoStepPanel />}
        {current === 'notifications' && <NotificationsPanel />}
        {current === 'appearance' && <AppearancePanel />}
        {current === 'delete' && <DeleteAccountPanel />}
      </div>
    </section>
  );

  // The previous page is drawn underneath only while a swipe shows it (the menu, or Edit profile under the phone page).
  return (
    <>
      {previous && peeking ? page(previous, false) : null}
      {page(section, true)}
    </>
  );
}
