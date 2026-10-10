'use client';

import { adminPasswordSetup } from '@bedo/api-client';
import { ADMIN_PASSWORD_RULES } from '@bedo/contracts';
import { Icon } from '@bedo/ui';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '../_lib/api';
import { Button, FormError, TextField } from './ui';

export const PASSWORD_HINT = `${ADMIN_PASSWORD_RULES.minLength}–${ADMIN_PASSWORD_RULES.maxLength} characters. Not your phone number and not a common password. A few unrelated words make a good password.`;

/** Password length as the server counts it (characters, not UTF-16 units). */
export function passwordLength(value: string): number {
  return [...value].length;
}

/**
 * Set Password with an owner-issued setup token (D-34). The owner runs
 * `select * from app.issue_admin_password_setup('<admin-phone>');` and gives the admin the one-time token.
 * Used for the first password and after an owner reset. It never signs anyone in.
 */
export function PasswordSetup({ initialPhone, onDone, onCancel }: { initialPhone: string; onDone: (phone: string) => void; onCancel: () => void }) {
  const [phone, setPhone] = useState(initialPhone);
  const [setupToken, setSetupToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const length = passwordLength(password);
  const lengthOk = length >= ADMIN_PASSWORD_RULES.minLength && length <= ADMIN_PASSWORD_RULES.maxLength;
  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!lengthOk || mismatch) return;
    setBusy(true);
    setError(null);
    adminPasswordSetup({ phone: phone.trim(), setupToken: setupToken.trim(), password })
      .then(() => {
        // Nothing secret stays in the page.
        setPassword('');
        setConfirm('');
        setSetupToken('');
        onDone(phone.trim());
      })
      .catch((caught: unknown) => setError(errorMessage(caught)))
      .finally(() => setBusy(false));
  };

  return (
    <section aria-labelledby="password-setup-title" className="flex flex-col gap-4 rounded-md border border-line bg-surface shadow-sm p-4">
      <header className="flex items-start gap-3">
        <Icon name="key" className="mt-0.5 shrink-0 text-accent" />
        <div>
          <h2 id="password-setup-title" className="font-semibold">
            Set password
          </h2>
          <p className="mt-1 text-sm text-ink-secondary">
            For a new admin account or after a password reset. Use the one-time setup token the owner created for your number. This does not sign you in.
          </p>
        </div>
      </header>
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <TextField id="password-setup-phone" label="Admin phone number" type="tel" autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />
        <TextField
          id="password-setup-token"
          label="Setup token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={setupToken}
          onChange={(event) => setSetupToken(event.target.value)}
        />
        <TextField
          id="password-setup-new"
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint={PASSWORD_HINT}
        />
        <TextField
          id="password-setup-confirm"
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          error={mismatch ? 'The passwords do not match.' : null}
        />
        <FormError message={error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={busy} disabled={phone.trim().length < 5 || setupToken.trim().length < 20 || !lengthOk || confirm !== password}>
            Set password
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Back to sign in
          </Button>
        </div>
      </form>
    </section>
  );
}
