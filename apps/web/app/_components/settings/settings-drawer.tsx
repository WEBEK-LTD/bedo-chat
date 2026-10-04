'use client';

import { Icon, type IconName } from '@bedo/ui';
import { useEffect } from 'react';
import { useSession } from '../../_lib/session';
import { Avatar, IconButton } from '../ui';
import { DeleteAccountPanel } from './delete-account-panel';
import { DevicesPanel } from './devices-panel';
import { NotificationsPanel } from './notifications-panel';
import { PhonePanel } from './phone-panel';
import { PrivacyPanel } from './privacy-panel';
import { ProfilePanel } from './profile-panel';
import { TwoStepPanel } from './two-step-panel';

export type SettingsSection = 'menu' | 'profile' | 'phone' | 'privacy' | 'devices' | 'two-step' | 'notifications' | 'delete';

const TITLES: Record<SettingsSection, string> = {
  menu: 'Settings',
  profile: 'Edit profile',
  phone: 'Change phone number',
  privacy: 'Privacy',
  devices: 'Devices',
  'two-step': '2-Step Verification',
  notifications: 'Notifications',
  delete: 'Delete account',
};

const MENU: Array<{ section: SettingsSection; icon: IconName; label: string }> = [
  { section: 'profile', icon: 'account_circle', label: 'Edit profile' },
  { section: 'privacy', icon: 'privacy_tip', label: 'Privacy' },
  { section: 'devices', icon: 'devices', label: 'Devices' },
  { section: 'two-step', icon: 'key', label: '2-Step Verification' },
  { section: 'notifications', icon: 'notifications', label: 'Notifications' },
  { section: 'delete', icon: 'person_remove', label: 'Delete account' },
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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (state.status !== 'signedIn') return null;
  const me = state.me;
  const back = section === 'menu' ? onClose : () => onNavigate(section === 'phone' ? 'profile' : 'menu');

  return (
    <section role="dialog" aria-modal="true" aria-label={TITLES[section]} className="absolute inset-0 z-10 flex flex-col bg-surface">
      <header className="flex h-[var(--bedo-header-height)] shrink-0 items-center gap-2 border-b border-line px-2">
        <IconButton icon={section === 'menu' ? 'close' : 'arrow_back'} label={section === 'menu' ? 'Close' : 'Back'} onClick={back} />
        <h2 className="font-semibold">{TITLES[section]}</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {section === 'menu' && (
          <nav className="flex flex-col py-2">
            <div className="flex items-center gap-3 px-4 py-3">
              <Avatar name={me.name} photoUrl={me.photoUrl} size={56} />
              <div className="min-w-0">
                <p className="truncate font-medium">{me.name}</p>
                <p className="truncate text-sm text-ink-secondary">{me.phone}</p>
                {me.username ? <p className="truncate text-sm text-ink-secondary">@{me.username}</p> : null}
              </div>
            </div>
            {MENU.map((item) => (
              <button
                key={item.section}
                type="button"
                onClick={() => onNavigate(item.section)}
                className="flex h-12 items-center gap-4 px-4 text-left hover:bg-surface-hover"
              >
                <Icon name={item.icon} className="text-ink-secondary" />
                <span className="flex-1">{item.label}</span>
                <Icon name="chevron_right" size={20} className="text-ink-secondary" />
              </button>
            ))}
            <button type="button" onClick={() => void logout()} className="flex h-12 items-center gap-4 px-4 text-left text-danger hover:bg-surface-hover">
              <Icon name="logout" />
              <span>Log out</span>
            </button>
          </nav>
        )}
        {section === 'profile' && <ProfilePanel onChangePhone={() => onNavigate('phone')} />}
        {section === 'phone' && <PhonePanel onDone={() => onNavigate('profile')} />}
        {section === 'privacy' && <PrivacyPanel />}
        {section === 'devices' && <DevicesPanel />}
        {section === 'two-step' && <TwoStepPanel />}
        {section === 'notifications' && <NotificationsPanel />}
        {section === 'delete' && <DeleteAccountPanel />}
      </div>
    </section>
  );
}
