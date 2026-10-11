import { BrandLogo } from '@bedo/ui';
import type { Metadata } from 'next';
import { LoginFlow } from '../_components/login-flow';

export const metadata: Metadata = { title: 'Sign in · Bedo Chat' };

/** Login screen (spec §1, §23): phone number, WhatsApp code, 2-Step password, then name for new accounts. */
export default function LoginPage() {
  return (
    <main className="bedo-wallpaper flex min-h-full items-start justify-center px-4 pb-10 pt-[10vh]">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex justify-center">
          {/* D-54: the Bedo Chat logo. */}
          <BrandLogo height={88} />
        </div>
        <div className="bedo-pop-in rounded-md border border-line bg-surface p-6 shadow-raised sm:p-8">
          <LoginFlow />
        </div>
      </div>
    </main>
  );
}
