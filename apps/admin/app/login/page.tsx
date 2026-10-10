import type { Metadata } from 'next';
import { Icon } from '@bedo/ui';
import { AdminLogin } from '../_components/admin-login';

export const metadata: Metadata = { title: 'Sign in · Bedo Chat Admin' };

export default function AdminLoginPage() {
  return (
    <main className="flex min-h-full items-start justify-center bg-surface-subtle px-4 pb-10 pt-[10vh]">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex flex-col items-center gap-3">
          <span className="grid size-[72px] place-items-center rounded-[22px] bg-accent text-on-accent shadow-raised">
            <Icon name="admin_panel_settings" size={40} />
          </span>
          <p className="text-lg font-bold tracking-tight">Bedo Chat Admin</p>
        </div>
        <div className="bedo-pop-in rounded-md border border-line bg-surface p-6 shadow-raised sm:p-8">
          <AdminLogin />
        </div>
      </div>
    </main>
  );
}
