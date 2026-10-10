'use client';

import { requestSignInCode, updateMe, verifySignInCode, verifyTwoStep } from '@bedo/api-client';
import { PROFILE_RULES } from '@bedo/contracts';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, browserDeviceName, errorMessage } from '../_lib/api';
import { useSession } from '../_lib/session';
import { Button, FormError, Notice, TextField } from './ui';

type Step =
  | { kind: 'phone' }
  | { kind: 'code'; phone: string; resendAt: number }
  | { kind: 'password'; phone: string; twoStepToken: string; hint: string | null }
  | { kind: 'name' };

const SIGNED_OUT_MESSAGES = {
  account_deleted: 'This account has been deleted.',
  account_blocked: 'This account is blocked. Contact the academy.',
  session_ended: 'You were signed out on this device.',
  signed_out: null,
} as const;

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * Sign-in (spec §1, D-06, D-11): phone number → WhatsApp code → 2-Step password if set → name for a new
 * account (P-03). The answer to a phone number is the same whether or not it is on the academy list.
 */
export function LoginFlow() {
  const router = useRouter();
  const session = useSession();
  const [step, setStep] = useState<Step>({ kind: 'phone' });
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(step.kind === 'code');

  const { state } = session;
  useEffect(() => {
    if (state.status === 'signedOut') {
      setStep((current) => (current.kind === 'name' ? { kind: 'phone' } : current));
      return;
    }
    if (state.status !== 'signedIn') return;
    if (state.me.profileComplete) {
      router.replace('/');
    } else {
      setStep({ kind: 'name' });
    }
  }, [state, router]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
      if (step.kind === 'password' && caught instanceof ApiError && caught.code === 'SESSION_INVALID') {
        // Five wrong 2-Step passwords end the attempt (P-09): a new code is needed.
        setStep({ kind: 'phone' });
        setError('Too many incorrect passwords. Request a new code to try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  const requestCode = (target: string) =>
    run(async () => {
      const response = await requestSignInCode({ phone: target });
      setCode('');
      setStep({ kind: 'code', phone: target, resendAt: Date.now() + response.resendAfterSeconds * 1000 });
    });

  function submitPhone(event: FormEvent) {
    event.preventDefault();
    void requestCode(phone.trim());
  }

  function submitCode(event: FormEvent) {
    event.preventDefault();
    if (step.kind !== 'code') return;
    void run(async () => {
      const response = await verifySignInCode({ phone: step.phone, code, deviceName: browserDeviceName() });
      if (response.status === 'two_step_required') {
        setPassword('');
        setStep({ kind: 'password', phone: step.phone, twoStepToken: response.twoStepToken, hint: response.hint });
      } else {
        session.signedIn(response);
      }
    });
  }

  function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (step.kind !== 'password') return;
    void run(async () => {
      session.signedIn(await verifyTwoStep({ twoStepToken: step.twoStepToken, password }));
    });
  }

  function submitName(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      session.setMe(await updateMe({ name: name.trim() }));
    });
  }

  if (state.status === 'loading') {
    return <p className="text-sm text-ink-secondary">Loading…</p>;
  }

  const signedOutMessage = state.status === 'signedOut' && state.reason ? SIGNED_OUT_MESSAGES[state.reason] : null;

  return (
    <div className="flex flex-col gap-6">
      {step.kind === 'phone' && (
        <>
          <header>
            <h1 className="text-[length:var(--bedo-font-size-xl)] font-semibold">Sign in to Bedo Chat</h1>
            <p className="mt-2 text-sm text-ink-secondary">
              Enter your phone number in international format. We will send a verification code to it by WhatsApp.
            </p>
          </header>
          {signedOutMessage && !error ? <Notice>{signedOutMessage}</Notice> : null}
          <form className="flex flex-col gap-4" onSubmit={submitPhone} noValidate>
            <TextField
              id="phone"
              label="Phone number"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+20 10 1234 5678"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
              autoFocus
            />
            <FormError message={error} />
            <Button type="submit" busy={busy} disabled={phone.trim().length < 5}>
              Continue
            </Button>
          </form>
        </>
      )}

      {step.kind === 'code' && (
        <>
          <header>
            <h1 className="text-[length:var(--bedo-font-size-xl)] font-semibold">Enter the code</h1>
            <p className="mt-2 text-sm text-ink-secondary">
              If <span className="font-medium text-ink">{step.phone}</span> can use Bedo Chat, a 6-digit code was sent to
              it by WhatsApp. The code is valid for 5 minutes.
            </p>
          </header>
          <form className="flex flex-col gap-4" onSubmit={submitCode} noValidate>
            <TextField
              id="code"
              label="Verification code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              autoFocus
            />
            <FormError message={error} />
            <Button type="submit" busy={busy} disabled={code.length !== 6}>
              Sign in
            </Button>
          </form>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <Button variant="ghost" className="px-2" onClick={() => setStep({ kind: 'phone' })}>
              Change number
            </Button>
            {now < step.resendAt ? (
              <span className="text-ink-secondary">Resend code in {Math.ceil((step.resendAt - now) / 1000)}s</span>
            ) : (
              <Button variant="ghost" className="px-2" busy={busy} onClick={() => void requestCode(step.phone)}>
                Resend code
              </Button>
            )}
          </div>
        </>
      )}

      {step.kind === 'password' && (
        <>
          <header>
            <h1 className="text-[length:var(--bedo-font-size-xl)] font-semibold">2-Step Verification</h1>
            <p className="mt-2 text-sm text-ink-secondary">This account is protected with an additional password.</p>
          </header>
          <form className="flex flex-col gap-4" onSubmit={submitPassword} noValidate>
            <TextField
              id="two-step-password"
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              hint={step.hint ? `Hint: ${step.hint}` : undefined}
              autoFocus
            />
            <FormError message={error} />
            <Button type="submit" busy={busy} disabled={password.length === 0}>
              Continue
            </Button>
          </form>
          <p className="text-sm text-ink-secondary">
            Forgot your password? An academy administrator can reset it after checking your identity.
          </p>
        </>
      )}

      {step.kind === 'name' && (
        <>
          <header>
            <h1 className="text-[length:var(--bedo-font-size-xl)] font-semibold">Your name</h1>
            <p className="mt-2 text-sm text-ink-secondary">Enter the name other people will see.</p>
          </header>
          <form className="flex flex-col gap-4" onSubmit={submitName} noValidate>
            <TextField
              id="name"
              label="Name"
              autoComplete="name"
              maxLength={PROFILE_RULES.nameMaxLength}
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
            <FormError message={error} />
            <Button type="submit" busy={busy} disabled={name.trim().length === 0}>
              Continue
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
