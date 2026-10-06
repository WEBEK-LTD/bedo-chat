'use client';

import { adminOtpRecoverySetWaabekKey, adminOtpRecoveryTestMessage } from '@bedo/api-client';
import { Icon } from '@bedo/ui';
import { type FormEvent, useState } from 'react';
import { errorMessage, testMessageResult } from '../_lib/api';
import { Button, FormError, Notice, TextField } from './ui';

/**
 * Waabek key recovery (D-33), shown on the sign-in page only while the database owner has opened a recovery
 * by SQL. With the one-time recovery token it can only save a new Waabek API key (encrypted on the server,
 * never shown again) and send a WhatsApp test message. It does not sign anyone in.
 */
export function OtpRecovery({ onClosed }: { onClosed: () => void }) {
  const [recoveryToken, setRecoveryToken] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(kind: 'save' | 'test', action: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    setResult(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  const save = (event: FormEvent) => {
    event.preventDefault();
    void run('save', async () => {
      await adminOtpRecoverySetWaabekKey({ recoveryToken: recoveryToken.trim(), apiKey: apiKey.trim() });
      // The key is not kept in the page once it is saved.
      setApiKey('');
      setSaved(true);
    });
  };

  const test = () =>
    void run('test', async () => {
      setResult(testMessageResult(await adminOtpRecoveryTestMessage({ recoveryToken: recoveryToken.trim() })));
    });

  return (
    <section aria-labelledby="otp-recovery-title" className="flex flex-col gap-4 rounded-md border border-line p-4">
      <header className="flex items-start gap-3">
        <Icon name="key" className="mt-0.5 shrink-0 text-accent" />
        <div>
          <h2 id="otp-recovery-title" className="font-semibold">
            WhatsApp settings recovery
          </h2>
          <p className="mt-1 text-sm text-ink-secondary">
            Replace the Waabek API key so students can receive WhatsApp sign-in codes again. Use the recovery token from the recovery SQL. This does not sign you in.
          </p>
        </div>
      </header>
      <form className="flex flex-col gap-4" onSubmit={save} noValidate>
        <TextField
          id="recovery-token"
          label="Recovery token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={recoveryToken}
          onChange={(event) => setRecoveryToken(event.target.value)}
        />
        <TextField
          id="recovery-waabek-key"
          label="New Waabek API key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          hint="Stored encrypted on the server. It is never shown again."
        />
        <FormError message={error} />
        {saved ? (
          <Notice>
            <p>The new Waabek API key is saved and used from the next message on.</p>
            <p className="mt-1 text-ink-secondary">This recovery token cannot save another key. To save a different one, run the recovery SQL again.</p>
          </Notice>
        ) : null}
        {result ? (
          <p role="status" className={`text-sm ${result.ok ? 'text-ink-secondary' : 'text-danger'}`}>
            {result.text}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={busy === 'save'} disabled={saved || recoveryToken.trim().length < 20 || apiKey.trim().length < 8}>
            Save key
          </Button>
          <Button variant="secondary" busy={busy === 'test'} disabled={recoveryToken.trim().length < 20} onClick={test}>
            Send test message
          </Button>
        </div>
      </form>
      {saved ? (
        <Button variant="ghost" className="self-start" onClick={onClosed}>
          Continue to sign in
        </Button>
      ) : null}
    </section>
  );
}
