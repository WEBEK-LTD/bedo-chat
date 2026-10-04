'use client';

import { disableTwoStep, setTwoStep, type TwoStepStatus } from '@bedo/api-client';
import { type Me, TWO_STEP_RULES } from '@bedo/contracts';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '../../_lib/api';
import { useMe, useSession } from '../../_lib/session';
import { Button, FormError, Notice, TextField } from '../ui';

/** 2-Step Verification (D-12, P-09): turn on, change or turn off. Only an administrator can reset it. */
export function TwoStepPanel() {
  const me = useMe();
  const { setMe } = useSession();
  const [mode, setMode] = useState<'view' | 'set' | 'disable'>('view');
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function reset(next: 'view' | 'set' | 'disable') {
    setMode(next);
    setCurrent('');
    setPassword('');
    setConfirm('');
    setHint('');
    setError(null);
  }

  async function apply(status: TwoStepStatus, text: string) {
    setMe({ ...me, twoStepEnabled: status.enabled } satisfies Me);
    setMessage(text);
    reset('view');
  }

  const tooShort = password.length > 0 && password.length < TWO_STEP_RULES.passwordMin;
  const mismatch = confirm.length > 0 && confirm !== password;
  const hintHasPassword = hint.trim().length > 0 && password.length > 0 && hint.toLowerCase().includes(password.toLowerCase());

  async function submitSet(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const status = await setTwoStep({
        newPassword: password,
        ...(hint.trim() ? { hint: hint.trim() } : {}),
        ...(me.twoStepEnabled ? { currentPassword: current } : {}),
      });
      await apply(status, me.twoStepEnabled ? 'Password changed.' : '2-Step Verification is on.');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function submitDisable(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const status = await disableTwoStep({ currentPassword: current });
      await apply(status, '2-Step Verification is off.');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <Notice>
        With 2-Step Verification on, signing in on a new device needs this password after the WhatsApp code. If you forget
        it, an academy administrator can reset it after checking your identity.
      </Notice>

      {mode === 'view' && (
        <>
          <p className="text-sm">
            Status: <span className="font-medium">{me.twoStepEnabled ? 'On' : 'Off'}</span>
          </p>
          {message ? <p className="text-sm text-ink-secondary">{message}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => reset('set')}>{me.twoStepEnabled ? 'Change password' : 'Set password'}</Button>
            {me.twoStepEnabled ? (
              <Button variant="danger" onClick={() => reset('disable')}>
                Turn off
              </Button>
            ) : null}
          </div>
        </>
      )}

      {mode === 'set' && (
        <form className="flex flex-col gap-4" onSubmit={submitSet} noValidate>
          {me.twoStepEnabled ? (
            <TextField
              id="two-step-current"
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
          ) : null}
          <TextField
            id="two-step-new"
            label="New password"
            type="password"
            autoComplete="new-password"
            maxLength={TWO_STEP_RULES.passwordMax}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            hint={`At least ${TWO_STEP_RULES.passwordMin} characters.`}
            error={tooShort ? `At least ${TWO_STEP_RULES.passwordMin} characters.` : null}
          />
          <TextField
            id="two-step-confirm"
            label="Repeat new password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            error={mismatch ? 'The passwords do not match.' : null}
          />
          <TextField
            id="two-step-hint"
            label="Hint (optional)"
            maxLength={TWO_STEP_RULES.hintMax}
            value={hint}
            onChange={(event) => setHint(event.target.value)}
            error={hintHasPassword ? 'The hint must not contain the password.' : null}
          />
          <FormError message={error} />
          <div className="flex gap-2">
            <Button
              type="submit"
              busy={busy}
              disabled={
                password.length < TWO_STEP_RULES.passwordMin ||
                confirm !== password ||
                hintHasPassword ||
                (me.twoStepEnabled && current.length === 0)
              }
            >
              Save
            </Button>
            <Button variant="secondary" onClick={() => reset('view')}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {mode === 'disable' && (
        <form className="flex flex-col gap-4" onSubmit={submitDisable} noValidate>
          <TextField
            id="two-step-disable"
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
          <FormError message={error} />
          <div className="flex gap-2">
            <Button type="submit" variant="danger" busy={busy} disabled={current.length === 0}>
              Turn off
            </Button>
            <Button variant="secondary" onClick={() => reset('view')}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
