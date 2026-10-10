'use client';

import { adminLogout, adminSession, type AdminSessionResponseAdmin as AdminInfo } from '@bedo/api-client';
import { Icon, type IconName } from '@bedo/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../_lib/api';
import { applyTheme, savedTheme, THEME_ORDER, type ThemeChoice } from '../_lib/theme';
import { AccountPassword } from './account-password';
import { AuditHistory } from './audit-history';
import { Broadcasts } from './broadcasts';
import { Chats } from './chats';
import { DeletionRequests } from './deletion-requests';
import { Overview } from './overview';
import { Reports } from './reports';
import { Users } from './users';
import { MediaSettings } from './media-settings';
import { UserPermissions } from './user-permissions';
import { OtpSettings } from './otp-settings';
import { PhoneList } from './phone-list';
import { TwoStepReset } from './two-step-reset';

type Section = 'overview' | 'users' | 'chats' | 'reports' | 'audit' | 'broadcasts' | 'phones' | 'deletions' | 'permissions' | 'two-step' | 'otp' | 'media' | 'account';

const SECTIONS: Array<{ id: Section; label: string; icon: IconName; superAdminOnly?: boolean }> = [
  { id: 'overview', label: 'Overview', icon: 'dashboard' },
  { id: 'users', label: 'Users', icon: 'group' },
  { id: 'chats', label: 'Groups and channels', icon: 'groups' },
  { id: 'reports', label: 'Reports', icon: 'flag' },
  { id: 'audit', label: 'Audit history', icon: 'history', superAdminOnly: true },
  { id: 'broadcasts', label: 'Broadcast notifications', icon: 'campaign', superAdminOnly: true },
  { id: 'phones', label: 'Academy phone list', icon: 'list_alt' },
  { id: 'deletions', label: 'Deletion requests', icon: 'person_remove' },
  { id: 'permissions', label: 'User permissions', icon: 'manage_accounts' },
  { id: 'two-step', label: '2-Step reset', icon: 'lock_reset', superAdminOnly: true },
  { id: 'otp', label: 'OTP / WhatsApp', icon: 'key', superAdminOnly: true },
  { id: 'media', label: 'Stickers and GIFs', icon: 'sticker' },
  { id: 'account', label: 'Account', icon: 'lock' },
];

const ROLE_LABELS = { super_admin: 'Super Admin', moderator: 'Moderator' } as const;

/**
 * Admin dashboard (spec §22, D-20): statistics, users, groups and channels, reports, the audit history and broadcast
 * notifications (Phase 10, D-44), the Phase 2 areas, the OTP / WhatsApp settings (D-32), stickers and GIFs (Phase 4)
 * and the admin's own password (D-34). Separate from the user app.
 */
export function Dashboard() {
  const router = useRouter();
  const [admin, setAdmin] = useState<AdminInfo | null>(null);
  const [section, setSection] = useState<Section>('overview');
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    adminSession()
      .then((response) => setAdmin(response.admin))
      .catch(() => router.replace('/login'));
  }, [router]);

  /** Any request that finds the session ended (sign-out, password change, 400 days unused) goes back to sign-in. */
  const onSessionError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') {
        router.replace('/login');
      }
    },
    [router],
  );

  async function signOut() {
    await adminLogout().catch(() => undefined);
    router.replace('/login');
  }

  if (!admin) {
    return <div className="grid h-full place-items-center text-sm text-ink-secondary">Loading…</div>;
  }
  const canChange = admin.role === 'super_admin';

  return (
    <div className="flex min-h-full flex-col">
      <header className="bedo-glass sticky top-0 z-20 flex h-[var(--bedo-header-height)] shrink-0 items-center justify-between gap-2 border-b border-line px-2 md:gap-4 md:px-4">
        <span className="flex min-w-0 items-center gap-2 font-semibold">
          {/* Phase 13: on a phone the sections are behind this button. */}
          <button
            type="button"
            aria-label="Menu"
            aria-expanded={menuOpen}
            aria-controls="admin-sections"
            onClick={() => setMenuOpen((value) => !value)}
            className="grid size-10 shrink-0 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover md:hidden"
          >
            <Icon name={menuOpen ? 'close' : 'menu'} />
          </button>
          <span className="hidden size-8 shrink-0 place-items-center rounded-[9px] bg-accent text-on-accent md:grid">
            <Icon name="admin_panel_settings" size={20} />
          </span>
          <span className="truncate">Bedo Chat Admin</span>
        </span>
        <div className="flex shrink-0 items-center gap-1 text-sm md:gap-2">
          <span className="mr-1 hidden text-ink-secondary sm:inline">
            {admin.name} · {ROLE_LABELS[admin.role]}
          </span>
          <ThemeButton />
          <button type="button" onClick={() => void signOut()} className="flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink">
            <Icon name="logout" size={20} />
            Sign out
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          id="admin-sections"
          className={`${menuOpen ? 'flex' : 'hidden'} shrink-0 flex-col gap-0.5 border-b border-line bg-surface p-2 md:sticky md:top-[var(--bedo-header-height)] md:flex md:h-[calc(100dvh-var(--bedo-header-height))] md:w-64 md:overflow-y-auto md:border-r md:border-b-0 md:p-3`}
          aria-label="Sections"
        >
          {/* On a phone: the signed-in admin, since the header has no room for the name. */}
          {menuOpen ? (
            <p className="px-3 py-1 text-sm text-ink-secondary sm:hidden">
              {admin.name} · {ROLE_LABELS[admin.role]}
            </p>
          ) : null}
          {SECTIONS.filter((item) => canChange || !item.superAdminOnly).map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => {
                setSection(item.id);
                setMenuOpen(false);
              }}
              className="group flex h-10 shrink-0 items-center gap-3 rounded-sm px-3 text-left text-sm transition-colors hover:bg-surface-hover aria-[current=page]:bg-accent-soft aria-[current=page]:font-semibold aria-[current=page]:text-accent"
            >
              <Icon name={item.icon} size={20} className="text-ink-secondary group-aria-[current=page]:text-accent" />
              {item.label}
            </button>
          ))}
        </nav>
        <main className="min-w-0 flex-1 bg-surface-subtle p-4 md:p-8">
          <div className="mx-auto max-w-5xl">
          {section === 'overview' && <Overview onSessionError={onSessionError} />}
          {section === 'users' && <Users isSuperAdmin={canChange} onSessionError={onSessionError} />}
          {section === 'chats' && <Chats isSuperAdmin={canChange} onSessionError={onSessionError} />}
          {section === 'reports' && <Reports isSuperAdmin={canChange} onSessionError={onSessionError} />}
          {section === 'audit' && canChange && <AuditHistory onSessionError={onSessionError} />}
          {section === 'broadcasts' && canChange && <Broadcasts onSessionError={onSessionError} />}
          {section === 'phones' && <PhoneList canChange={canChange} onSessionError={onSessionError} />}
          {section === 'deletions' && <DeletionRequests canDecide={canChange} onSessionError={onSessionError} />}
          {section === 'two-step' && canChange && <TwoStepReset onSessionError={onSessionError} />}
          {section === 'otp' && canChange && <OtpSettings onSessionError={onSessionError} />}
          {section === 'permissions' && <UserPermissions canChange={canChange} onSessionError={onSessionError} />}
          {section === 'media' && <MediaSettings canChange={canChange} onSessionError={onSessionError} />}
          {section === 'account' && <AccountPassword onSessionError={onSessionError} />}
        </div>
        </main>
      </div>
    </div>
  );
}

const THEME_LABELS: Record<ThemeChoice, { label: string; icon: IconName }> = {
  system: { label: 'Theme: same as device', icon: 'brightness_auto' },
  light: { label: 'Theme: light', icon: 'light_mode' },
  dark: { label: 'Theme: dark', icon: 'dark_mode' },
};

/** Light, dark, or the device's setting (D-48); each press moves to the next. */
function ThemeButton() {
  const [choice, setChoice] = useState<ThemeChoice>('system');
  useEffect(() => {
    const saved = savedTheme();
    setChoice(saved);
    applyTheme(saved);
  }, []);
  const next = THEME_ORDER[(THEME_ORDER.indexOf(choice) + 1) % THEME_ORDER.length]!;
  return (
    <button
      type="button"
      aria-label={`${THEME_LABELS[choice].label}. Switch to ${THEME_LABELS[next].label.replace('Theme: ', '')}`}
      title={THEME_LABELS[choice].label}
      onClick={() => {
        setChoice(next);
        applyTheme(next);
      }}
      className="grid size-9 shrink-0 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink"
    >
      <Icon name={THEME_LABELS[choice].icon} size={20} />
    </button>
  );
}