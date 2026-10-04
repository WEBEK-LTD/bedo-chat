'use client';

import { adminRequestCode, adminSession, adminVerifyCode, adminVerifyTotp } from '@bedo/api-client';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, errorMessage } from '../_lib/api';
import { Button, FormError, TextField } from './ui';

type Step = { kind: 'checking' } | { kind: 'phone' } | { kind: 'code'; phone: string } | { kind: 'totp'; pendingToken: string };

/** Admin sign-in (D-19, P-13): phone code by WhatsApp, then the authenticator-app code. */
export function AdminLogin() {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'checking' });
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminSession()
      .then(() => router.replace('/'))
      .catch(() => setStep({ kind: 'phone' }));
  }, [router]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
      if (caught instanceof ApiError && caught.code === 'SESSION_INVALID') {
        setStep({ kind: 'phone' });
      }
    } finally {
      setBusy(false);
    }
  }

  const submitPhone = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await adminRequestCode({ phone: phone.trim() });
      setCode('');
      setStep({ kind: 'code', phone: phone.trim() });
    });
  };

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    if (step.kind !== 'code') return;
    void run(async () => {
      const response = await adminVerifyCode({ phone: step.phone, code });
      setTotp('');
      setStep({ kind: 'totp', pendingToken: response.pendingToken });
    });
  };

  const submitTotp = (event: FormEvent) => {
    event.preventDefault();
    if (step.kind !== 'totp') return;
    void run(async () => {
      await adminVerifyTotp({ pendingToken: step.pendingToken, code: totp });
      router.replace('/');
    });
  };

  if (step.kind === 'checking') {
    return <p className="text-sm text-ink-secondary">Loading…</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-[length:var(--bedo-font-size-xl)] font-semibold">Bedo Chat Admin</h1>
        <p className="mt-2 text-sm text-ink-secondary">
          {step.kind === 'phone'
            ? 'Sign in with your admin phone number.'
            : step.kind === 'code'
              ? `If ${step.phone} belongs to an admin account, a code was sent to it by WhatsApp.`
              : 'Enter the 6-digit code from your authenticator app.'}
        </p>
      </header>

      {step.kind === 'phone' && (
        <form className="flex flex-col gap-4" onSubmit={submitPhone} noValidate>
          <TextField id="admin-phone" label="Phone number" type="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} autoFocus />
          <FormError message={error} />
          <Button type="submit" busy={busy} disabled={phone.trim().length < 5}>
            Continue
          </Button>
        </form>
      )}

      {step.kind === 'code' && (
        <form className="flex flex-col gap-4" onSubmit={submitCode} noValidate>
          <TextField
            id="admin-code"
            label="WhatsApp code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
            autoFocus
          />
          <FormError message={error} />
          <Button type="submit" busy={busy} disabled={code.length !== 6}>
            Continue
          </Button>
          <Button variant="ghost" onClick={() => setStep({ kind: 'phone' })}>
            Change number
          </Button>
        </form>
      )}

      {step.kind === 'totp' && (
        <form className="flex flex-col gap-4" onSubmit={submitTotp} noValidate>
          <TextField
            id="admin-totp"
            label="Authenticator code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={totp}
            onChange={(event) => setTotp(event.target.value.replace(/\D/g, '').slice(0, 6))}
            autoFocus
          />
          <FormError message={error} />
          <Button type="submit" busy={busy} disabled={totp.length !== 6}>
            Sign in
          </Button>
        </form>
      )}
    </div>
  );
}
