'use client';

import { adminBootstrapSetWaabekKey, adminBootstrapTestMessage } from '@bedo/api-client';
import { Icon } from '@bedo/ui';
import { type FormEvent, useState } from 'react';
import { errorMessage, testMessageResult } from '../_lib/api';
import { Button, FormError, Notice, TextField } from './ui';

/**
 * Initial setup (Phase 3.1), shown on the sign-in page only while the owner has opened it by SQL. With the
 * one-time setup token it stores the first Waabek API key (encrypted on the server, never shown again) and
 * can send a WhatsApp test message to the Super Admin. It does not sign anyone in.
 */
export function InitialSetup({ onClosed }: { onClosed: () => void }) {
  const [setupToken, setSetupToken] = useState('');
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
      await adminBootstrapSetWaabekKey({ setupToken: setupToken.trim(), apiKey: apiKey.trim() });
      // The key is not kept in the page once it is saved.
      setApiKey('');
      setSaved(true);
    });
  };

  const test = () =>
    void run('test', async () => {
      setResult(testMessageResult(await adminBootstrapTestMessage({ setupToken: setupToken.trim() })));
    });

  return (
    <section aria-labelledby="initial-setup-title" className="flex flex-col gap-4 rounded-md border border-line bg-surface shadow-sm p-4">
      <header className="flex items-start gap-3">
        <Icon name="key" className="mt-0.5 shrink-0 text-accent" />
        <div>
          <h2 id="initial-setup-title" className="font-semibold">
            Initial setup
          </h2>
          <p className="mt-1 text-sm text-ink-secondary">
            Save the Waabek API key that sends WhatsApp sign-in codes to students. Use the setup token from the setup SQL. This does not sign you in.
          </p>
        </div>
      </header>
      <form className="flex flex-col gap-4" onSubmit={save} noValidate>
        <TextField
          id="setup-token"
          label="Setup token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={setupToken}
          onChange={(event) => setSetupToken(event.target.value)}
        />
        <TextField
          id="setup-waabek-key"
          label={saved ? 'Waabek API key (saved — enter a new one to replace it)' : 'Waabek API key'}
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
            <p>The Waabek API key is saved.</p>
          </Notice>
        ) : null}
        {result ? (
          <p role="status" className={`text-sm ${result.ok ? 'text-ink-secondary' : 'text-danger'}`}>
            {result.text}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={busy === 'save'} disabled={setupToken.trim().length < 20 || apiKey.trim().length < 8}>
            Save key
          </Button>
          <Button variant="secondary" busy={busy === 'test'} disabled={setupToken.trim().length < 20} onClick={test}>
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
