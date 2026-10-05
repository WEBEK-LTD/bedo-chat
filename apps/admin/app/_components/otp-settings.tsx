'use client';

import { adminOtpSettings, adminReplaceWaabekKey, adminSendWaabekTest, type OtpSettingsResponse } from '@bedo/api-client';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { errorMessage, formatDateTime, testMessageResult } from '../_lib/api';
import { Button, FormError, Notice, TextField } from './ui';

/**
 * OTP / WhatsApp (Waabek) settings (D-32), Super Admin only. Shows whether a key is saved, never the key.
 * Replacing it needs a current authenticator code; the new key is encrypted on the server and every
 * change is recorded in the audit history without the key.
 */
export function OtpSettings({ onSessionError }: { onSessionError: (error: unknown) => void }) {
  const [settings, setSettings] = useState<OtpSettingsResponse | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    adminOtpSettings()
      .then(setSettings)
      .catch((caught: unknown) => {
        onSessionError(caught);
        setError(errorMessage(caught));
      });
  }, [onSessionError]);

  useEffect(load, [load]);

  async function replace(event: FormEvent) {
    event.preventDefault();
    setBusy('save');
    setError(null);
    setDone(null);
    setResult(null);
    try {
      await adminReplaceWaabekKey({ apiKey: apiKey.trim(), totpCode });
      setApiKey('');
      setDone('The new Waabek API key is saved. It is used from the next message on. Send a test message to check it.');
      load();
    } catch (caught) {
      onSessionError(caught);
      setError(errorMessage(caught));
    } finally {
      setTotpCode('');
      setBusy(null);
    }
  }

  async function test() {
    setBusy('test');
    setError(null);
    setResult(null);
    try {
      setResult(testMessageResult(await adminSendWaabekTest()));
    } catch (caught) {
      onSessionError(caught);
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <h1 className="text-[length:var(--bedo-font-size-xl)] font-semibold">OTP / WhatsApp (Waabek)</h1>

      <section aria-labelledby="otp-status-title" className="flex flex-col gap-3">
        <h2 id="otp-status-title" className="font-semibold">
          Current setting
        </h2>
        {settings ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-ink-secondary">Provider</dt>
            <dd>Waabek WhatsApp</dd>
            <dt className="text-ink-secondary">API key</dt>
            <dd data-testid="otp-key-status">{settings.apiKeyConfigured ? 'Saved (hidden)' : 'Not set'}</dd>
            <dt className="text-ink-secondary">Last changed</dt>
            <dd>
              {settings.updatedAt
                ? `${formatDateTime(settings.updatedAt)}${settings.updatedBy ? ` by ${settings.updatedBy.name}` : settings.updatedVia === 'initial_setup' ? ' during initial setup' : settings.updatedVia === 'owner_recovery' ? ' by owner recovery' : ''}`
                : '—'}
            </dd>
          </dl>
        ) : (
          <p className="text-sm text-ink-secondary">Loading…</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" busy={busy === 'test'} disabled={!settings?.apiKeyConfigured} onClick={() => void test()}>
            Send test message
          </Button>
          <span className="text-sm text-ink-secondary">Sent to your own admin phone number.</span>
        </div>
        {result ? (
          <p role="status" className={`text-sm ${result.ok ? 'text-ink-secondary' : 'text-danger'}`}>
            {result.text}
          </p>
        ) : null}
      </section>

      <section aria-labelledby="otp-replace-title" className="flex flex-col gap-3">
        <h2 id="otp-replace-title" className="font-semibold">
          Replace API key
        </h2>
        <Notice tone="warning">
          Every sign-in code is sent with this key. Replacing it takes effect at once for all codes. Confirm with your authenticator app.
        </Notice>
        <form className="flex flex-col gap-4" onSubmit={(event) => void replace(event)} noValidate>
          <TextField
            id="otp-new-key"
            label="New Waabek API key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            hint="Stored encrypted on the server. It is never shown again."
          />
          <TextField
            id="otp-totp"
            label="Authenticator code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={totpCode}
            onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          <FormError message={error} />
          {done ? (
            <p role="status" className="text-sm text-ink-secondary">
              {done}
            </p>
          ) : null}
          <Button type="submit" className="self-start" busy={busy === 'save'} disabled={apiKey.trim().length < 8 || totpCode.length !== 6}>
            Save new key
          </Button>
        </form>
      </section>
    </div>
  );
}
