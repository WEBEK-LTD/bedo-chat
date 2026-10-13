'use client';

import { adminChangePassword } from '@bedo/api-client';
import { ADMIN_PASSWORD_RULES } from '@bedo/contracts';
import { type FormEvent, useState } from 'react';
import { ApiError, errorMessage } from '../_lib/api';
import { PASSWORD_HINT, passwordLength } from './password-setup';
import { Button, FormError, Notice, TextField } from './ui';

/**
 * Account → Change password (D-34). Any signed-in admin, with the current password and a current authenticator
 * code. Every other session of the account ends; this one stays signed in.
 */
export function AccountPassword({ onSessionError }: { onSessionError: (error: unknown) => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const length = passwordLength(newPassword);
  const lengthOk = length >= ADMIN_PASSWORD_RULES.minLength && length <= ADMIN_PASSWORD_RULES.maxLength;
  const mismatch = confirm.length > 0 && confirm !== newPassword;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!lengthOk || mismatch) return;
    setBusy(true);
    setError(null);
    setDone(null);
    adminChangePassword({ currentPassword, newPassword, totpCode })
      .then((result) => {
        setCurrentPassword('');
        setNewPassword('');
        setConfirm('');
        setDone(
          result.otherSessionsEnded > 0
            ? `Your password is changed. ${result.otherSessionsEnded} other ${result.otherSessionsEnded === 1 ? 'session was' : 'sessions were'} signed out.`
            : 'Your password is changed.',
        );
      })
      .catch((caught: unknown) => {
        onSessionError(caught);
        setError(
          caught instanceof ApiError && caught.code === 'CREDENTIALS_INVALID'
            ? 'The current password or the authenticator code is incorrect.'
            : errorMessage(caught),
        );
      })
      .finally(() => {
        // An authenticator code works once; a new attempt needs the next one.
        setTotpCode('');
        setBusy(false);
      });
  };

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h1 className="text-[length:var(--bedo-font-size-xl)] font-semibold">Account</h1>
      <h2 className="font-semibold">Change password</h2>
      <Notice>
        Changing your password signs out every other session of your admin account. This session stays signed in.
      </Notice>
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <TextField
          id="account-current-password"
          label="Current password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
        <TextField
          id="account-new-password"
          label="New password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          hint={PASSWORD_HINT}
        />
        <TextField
          id="account-confirm-password"
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          error={mismatch ? 'The passwords do not match.' : null}
        />
        <TextField
          id="account-totp"
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
        <Button
          type="submit"
          busy={busy}
          disabled={currentPassword.length === 0 || !lengthOk || confirm !== newPassword || totpCode.length !== 6}
          className="self-start"
        >
          Change password
        </Button>
      </form>
    </div>
  );
}
