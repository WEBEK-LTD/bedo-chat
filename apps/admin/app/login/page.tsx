import type { Metadata } from 'next';
import { BrandLogo, Icon } from '@bedo/ui';
import { AdminLogin } from '../_components/admin-login';

export const metadata: Metadata = { title: 'Sign in · Bedo Chat Admin' };

export default function AdminLoginPage() {
  return (
    <main className="flex min-h-full items-start justify-center bg-surface-subtle px-4 pb-10 pt-[10vh]">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex flex-col items-center gap-2">
          {/* D-54: the Bedo Chat logo. */}
          <BrandLogo height={88} />
          <p className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-[0.12em] text-ink-secondary">
            <Icon name="admin_panel_settings" size={18} />
            Admin Dashboard
          </p>
        </div>
        <div className="bedo-pop-in rounded-md border border-line bg-surface p-6 shadow-raised sm:p-8">
          <AdminLogin />
        </div>
      </div>
    </main>
  );
}
