'use client';

import { adminLogout, adminSession, type AdminSessionResponseAdmin as AdminInfo } from '@bedo/api-client';
import { Icon, type IconName } from '@bedo/ui';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../_lib/api';
import { DeletionRequests } from './deletion-requests';
import { PhoneList } from './phone-list';
import { TwoStepReset } from './two-step-reset';

type Section = 'phones' | 'deletions' | 'two-step';

const SECTIONS: Array<{ id: Section; label: string; icon: IconName; superAdminOnly?: boolean }> = [
  { id: 'phones', label: 'Academy phone list', icon: 'list_alt' },
  { id: 'deletions', label: 'Deletion requests', icon: 'person_remove' },
  { id: 'two-step', label: '2-Step reset', icon: 'lock_reset', superAdminOnly: true },
];

const ROLE_LABELS = { super_admin: 'Super Admin', moderator: 'Moderator' } as const;

/** Admin dashboard (spec §22, D-20): Phase 2 areas only. Separate from the user app. */
export function Dashboard() {
  const router = useRouter();
  const [admin, setAdmin] = useState<AdminInfo | null>(null);
  const [section, setSection] = useState<Section>('phones');

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
      <header className="flex h-[var(--bedo-header-height)] shrink-0 items-center justify-between gap-4 border-b border-line px-4">
        <span className="flex items-center gap-2 font-semibold">
          <Icon name="admin_panel_settings" className="text-accent" />
          Bedo Chat Admin
        </span>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-ink-secondary">
            {admin.name} · {ROLE_LABELS[admin.role]}
          </span>
          <button type="button" onClick={() => void signOut()} className="flex items-center gap-1 rounded-sm px-2 py-1 text-ink-secondary hover:bg-surface-hover">
            <Icon name="logout" size={20} />
            Sign out
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <nav className="flex shrink-0 gap-1 border-line p-2 md:w-60 md:flex-col md:border-r" aria-label="Sections">
          {SECTIONS.filter((item) => canChange || !item.superAdminOnly).map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? 'page' : undefined}
              onClick={() => setSection(item.id)}
              className="flex h-10 items-center gap-3 rounded-sm px-3 text-left text-sm hover:bg-surface-hover aria-[current=page]:bg-surface-selected aria-[current=page]:font-medium"
            >
              <Icon name={item.icon} size={20} className="text-ink-secondary" />
              {item.label}
            </button>
          ))}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
          {section === 'phones' && <PhoneList canChange={canChange} onSessionError={onSessionError} />}
          {section === 'deletions' && <DeletionRequests canDecide={canChange} onSessionError={onSessionError} />}
          {section === 'two-step' && canChange && <TwoStepReset onSessionError={onSessionError} />}
        </main>
      </div>
    </div>
  );
}
