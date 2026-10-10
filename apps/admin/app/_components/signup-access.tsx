'use client';

import { adminAccessSettings, adminSetAccessSettings, type AdminAccessSettings } from '@bedo/api-client';
import { useEffect, useState } from 'react';
import { errorMessage, formatDateTime } from '../_lib/api';
import { FormError } from './ui';

const MODES = [
  { id: 'open', label: 'Anyone with a WhatsApp number', hint: 'A new number gets a code and an account at its first sign-in. This list is not needed.' },
  { id: 'academy_list', label: 'Only numbers on this list', hint: 'Numbers must be added here (or imported) before they can sign in.' },
] as const;

/**
 * D-47: who can create an account. Every admin sees the setting; a Super Admin changes it. Numbers of accounts an
 * admin deleted can never sign up again, in either mode.
 */
export function SignupAccess({ canChange, onSessionError }: { canChange: boolean; onSessionError: (error: unknown) => void }) {
  const [settings, setSettings] = useState<AdminAccessSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    adminAccessSettings()
      .then(setSettings)
      .catch((caught: unknown) => {
        onSessionError(caught);
        setError(errorMessage(caught));
      });
  }, [onSessionError]);

  async function choose(mode: (typeof MODES)[number]['id']) {
    if (!settings || settings.signupMode === mode) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(await adminSetAccessSettings({ signupMode: mode }));
    } catch (caught) {
      onSessionError(caught);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-line p-4" aria-label="Who can create an account">
      <legend className="px-1 text-sm font-medium">Who can create an account</legend>
      {!settings ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : (
        <>
          {MODES.map((mode) => (
            <label key={mode.id} className="flex items-start gap-3 text-sm">
              <input
                type="radio"
                name="signup-mode"
                className="mt-1"
                checked={settings.signupMode === mode.id}
                disabled={!canChange || busy}
                onChange={() => void choose(mode.id)}
              />
              <span className="flex flex-col">
                <span className="font-medium">{mode.label}</span>
                <span className="text-ink-secondary">{mode.hint}</span>
              </span>
            </label>
          ))}
          <p className="text-xs text-ink-secondary">
            Numbers of accounts deleted by an admin can never sign up again.
            {settings.updatedAt ? ` Last changed ${formatDateTime(settings.updatedAt)} by ${settings.updatedBy ?? 'an admin'}.` : ''}
            {canChange ? '' : ' Changing this needs a Super Admin.'}
          </p>
        </>
      )}
      <FormError message={error} />
    </fieldset>
  );
}
