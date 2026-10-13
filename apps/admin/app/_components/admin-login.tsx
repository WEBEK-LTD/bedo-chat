'use client';

import {
  adminBootstrapStatus,
  adminOtpRecoveryStatus,
  adminPasswordLogin,
  adminSession,
  adminSetupTotp,
  type AdminTotpSetupResponse,
  adminVerifyTotp,
} from '@bedo/api-client';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { ApiError, errorMessage } from '../_lib/api';
import { InitialSetup } from './initial-setup';
import { OtpRecovery } from './otp-recovery';
import { PasswordSetup } from './password-setup';
import { QrCode } from './qr-code';
import { Button, FormError, TextField } from './ui';
import { PhoneField } from '@bedo/ui';

type Step =
  | { kind: 'checking' }
  | { kind: 'credentials' }
  | { kind: 'set-password' }
  | { kind: 'totp'; pendingToken: string }
  | { kind: 'setup'; pendingToken: string; setup: AdminTotpSetupResponse | null };

/** The setup key in groups of four, as authenticator apps show it. */
function groupKey(key: string): string {
  return key.replace(/(.{4})(?=.)/g, '$1 ');
}

/**
 * Admin sign-in (D-19 as amended by D-34, P-13): phone number and password, then the authenticator-app code,
 * which every admin sign-in needs. An account created by SQL sets up its authenticator app here at its first
 * sign-in (Phase 3.1). The Set Password panel takes the owner's one-time setup token (first password or after a
 * reset). While the owner has opened the initial setup or a Waabek key recovery, the page also offers those.
 */
export function AdminLogin() {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ kind: 'checking' });
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);

  useEffect(() => {
    adminSession()
      .then(() => router.replace('/'))
      .catch(() => {
        setStep({ kind: 'credentials' });
        adminBootstrapStatus()
          .then((status) => setSetupOpen(status.setupOpen))
          .catch(() => setSetupOpen(false));
        adminOtpRecoveryStatus()
          .then((status) => setRecoveryOpen(status.recoveryOpen))
          .catch(() => setRecoveryOpen(false));
      });
  }, [router]);

  const setupPending = step.kind === 'setup' && step.setup === null ? step.pendingToken : null;
  useEffect(() => {
    if (!setupPending) return;
    let cancelled = false;
    adminSetupTotp({ pendingToken: setupPending })
      .then((setup) => {
        if (!cancelled) setStep({ kind: 'setup', pendingToken: setupPending, setup });
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(errorMessage(caught));
        setStep({ kind: 'credentials' });
      });
    return () => {
      cancelled = true;
    };
  }, [setupPending]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
      if (caught instanceof ApiError && caught.code === 'SESSION_INVALID') {
        setStep({ kind: 'credentials' });
      }
    } finally {
      setBusy(false);
    }
  }

  const submitCredentials = (event: FormEvent) => {
    event.preventDefault();
    setNotice(null);
    void run(async () => {
      try {
        const response = await adminPasswordLogin({ phone: phone.trim(), password });
        setTotp('');
        setStep(
          response.status === 'totp_setup_required'
            ? { kind: 'setup', pendingToken: response.pendingToken, setup: null }
            : { kind: 'totp', pendingToken: response.pendingToken },
        );
      } finally {
        // The password is not kept in the page after it has been sent.
        setPassword('');
      }
    });
  };

  const submitTotp = (event: FormEvent) => {
    event.preventDefault();
    if (step.kind !== 'totp' && step.kind !== 'setup') return;
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
          {step.kind === 'credentials'
            ? 'Sign in with your admin phone number and password.'
            : step.kind === 'set-password'
              ? 'Set your admin password.'
              : step.kind === 'setup'
                ? 'Set up your authenticator app. It is required for every admin sign-in.'
                : 'Enter the 6-digit code from your authenticator app.'}
        </p>
      </header>

      {step.kind === 'credentials' && setupOpen && <InitialSetup onClosed={() => setSetupOpen(false)} />}

      {step.kind === 'credentials' && recoveryOpen && <OtpRecovery onClosed={() => setRecoveryOpen(false)} />}

      {step.kind === 'set-password' && (
        <PasswordSetup
          initialPhone={phone}
          onDone={(donePhone) => {
            setPhone(donePhone);
            setError(null);
            setNotice('Your password is set. Sign in with it.');
            setStep({ kind: 'credentials' });
          }}
          onCancel={() => setStep({ kind: 'credentials' })}
        />
      )}

      {step.kind === 'setup' && step.setup === null && <p className="text-sm text-ink-secondary">Preparing your authenticator setup…</p>}

      {step.kind === 'setup' && step.setup !== null && (
        <form className="flex flex-col gap-4" onSubmit={submitTotp} noValidate>
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
            <li>Open an authenticator app on your phone (for example Google Authenticator, Microsoft Authenticator or 1Password).</li>
            <li>Scan this QR code, or enter the setup key by hand.</li>
            <li>Enter the 6-digit code the app shows to confirm.</li>
          </ol>
          <div className="flex justify-center rounded-md bg-surface-subtle p-4">
            <QrCode value={step.setup.otpauthUri} label={`QR code for ${step.setup.issuer} (${step.setup.accountName})`} />
          </div>
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Setup key</span>
            <code data-testid="totp-setup-key" className="break-all rounded-sm bg-surface-subtle px-3 py-2 font-mono">
              {groupKey(step.setup.setupKey)}
            </code>
            <span className="text-ink-secondary">
              Account: {step.setup.issuer} · {step.setup.accountName}. Time-based, 6 digits. Keep this key private.
            </span>
          </div>
          <TextField
            id="admin-totp-setup"
            label="Code from the authenticator app"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={totp}
            onChange={(event) => setTotp(event.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          <FormError message={error} />
          <Button type="submit" busy={busy} disabled={totp.length !== 6}>
            Confirm and sign in
          </Button>
        </form>
      )}

      {step.kind === 'credentials' && (
        <form className="flex flex-col gap-4" onSubmit={submitCredentials} noValidate>
          <PhoneField id="admin-phone" label="Phone number" value={phone} onChange={setPhone} autoComplete="username" autoFocus />
          <TextField
            id="admin-password"
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {notice ? (
            <p role="status" className="text-sm text-ink-secondary">
              {notice}
            </p>
          ) : null}
          <FormError message={error} />
          <Button type="submit" busy={busy} disabled={phone.trim().length < 5 || password.length === 0}>
            Continue
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setError(null);
              setNotice(null);
              setStep({ kind: 'set-password' });
            }}
          >
            Set password with a setup token
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
