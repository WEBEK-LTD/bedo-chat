import type { Metadata } from 'next';
import { LoginFlow } from '../_components/login-flow';

export const metadata: Metadata = { title: 'Sign in · Bedo Chat' };

/** Login screen (spec §1, §23): phone number, WhatsApp code, 2-Step password, then name for new accounts. */
export default function LoginPage() {
  return (
    <main className="bedo-wallpaper flex min-h-full items-start justify-center px-4 pb-10 pt-[10vh]">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex flex-col items-center gap-3">
          {/* The app icon (the same one the device shows when Bedo Chat is installed). */}
          <img src="/icons/icon-192.png" alt="" width={72} height={72} className="size-[72px] rounded-[22px] shadow-raised" />
          <p className="text-lg font-bold tracking-tight">Bedo Chat</p>
        </div>
        <div className="bedo-pop-in rounded-md border border-line bg-surface p-6 shadow-raised sm:p-8">
          <LoginFlow />
        </div>
      </div>
    </main>
  );
}
