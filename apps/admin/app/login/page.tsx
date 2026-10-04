import type { Metadata } from 'next';
import { AdminLogin } from '../_components/admin-login';

export const metadata: Metadata = { title: 'Sign in · Bedo Chat Admin' };

export default function AdminLoginPage() {
  return (
    <main className="flex min-h-full items-start justify-center px-4 pt-[12vh]">
      <div className="w-full max-w-[360px]">
        <AdminLogin />
      </div>
    </main>
  );
}
