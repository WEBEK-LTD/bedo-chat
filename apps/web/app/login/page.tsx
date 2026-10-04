import type { Metadata } from 'next';
import { LoginFlow } from '../_components/login-flow';

export const metadata: Metadata = { title: 'Sign in · Bedo Chat' };

/** Login screen (spec §1, §23): phone number, WhatsApp code, 2-Step password, then name for new accounts. */
export default function LoginPage() {
  return (
    <main className="flex min-h-full items-start justify-center px-4 pt-[12vh]">
      <div className="w-full max-w-[360px]">
        <LoginFlow />
      </div>
    </main>
  );
}
