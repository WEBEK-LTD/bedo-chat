import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Sign in · Bedo Chat' };

/**
 * Login screen (spec §1, §23). Phase 1 renders the layout only; phone submission, code entry and
 * 2-Step Verification are connected to the API in Phase 2.
 */
export default function LoginPage() {
  return (
    <main className="flex min-h-full items-start justify-center px-4 pt-[12vh]">
      <div className="w-full max-w-[360px]">
        <h1 className="text-[length:var(--bedo-font-size-xl)] font-semibold">Sign in to Bedo Chat</h1>
        <p className="mt-2 text-sm text-ink-secondary">Enter your phone number and we will send you a verification code.</p>

        <form className="mt-8 flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="phone" className="text-sm font-medium">
              Phone number
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              className="h-[var(--bedo-control-height)] rounded-sm border border-line bg-surface px-3 text-[length:var(--bedo-font-size-md)] outline-none focus:border-accent"
            />
          </div>
          <button
            type="submit"
            disabled
            className="h-[var(--bedo-control-height)] rounded-sm bg-accent text-sm font-medium text-on-accent transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Continue
          </button>
        </form>
      </div>
    </main>
  );
}
