'use client';

import { adminLogout, adminSession, type AdminSessionResponseAdmin as AdminInfo } from '@bedo/api-client';
import { Icon, type IconName } from '@bedo/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../_lib/api';
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

  /** Any request that finds the session ended (idle 30 minutes, 12 hours, sign-out) goes back to sign-in. */
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
      <header className="flex h-[var(--bedo-header-height)] shrink-0 items-center justify-between gap-2 border-b border-line px-2 md:gap-4 md:px-4">
        <span className="flex min-w-0 items-center gap-2 font-semibold">
          {/* Phase 13: on a phone the sections are behind this button. */}
          <button
            type="button"
            aria-label="Menu"
            aria-expanded={menuOpen}
            aria-controls="admin-sections"
            onClick={() => setMenuOpen((value) => !value)}
            className="grid size-10 shrink-0 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover md:hidden"
          >
            <Icon name={menuOpen ? 'close' : 'menu'} />
          </button>
          <Icon name="admin_panel_settings" className="hidden shrink-0 text-accent md:block" />
          <span className="truncate">Bedo Chat Admin</span>
        </span>
        <div className="flex shrink-0 items-center gap-3 text-sm">
          <span className="hidden text-ink-secondary sm:inline">
            {admin.name} · {ROLE_LABELS[admin.role]}
          </span>
          <button type="button" onClick={() => void signOut()} className="flex items-center gap-1 whitespace-nowrap rounded-sm px-2 py-1 text-ink-secondary hover:bg-surface-hover">
            <Icon name="logout" size={20} />
            Sign out
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav
          id="admin-sections"
          className={`${menuOpen ? 'flex' : 'hidden'} shrink-0 flex-col gap-1 border-b border-line p-2 md:flex md:w-60 md:border-r md:border-b-0`}
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
              className="flex h-10 items-center gap-3 rounded-sm px-3 text-left text-sm hover:bg-surface-hover aria-[current=page]:bg-surface-selected aria-[current=page]:font-medium"
            >
              <Icon name={item.icon} size={20} className="text-ink-secondary" />
              {item.label}
            </button>
          ))}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
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
        </main>
      </div>
    </div>
  );
}
