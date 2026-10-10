'use client';

import { adminResetTwoStep } from '@bedo/api-client';
import { type FormEvent, useState } from 'react';
import { ApiError, errorMessage } from '../_lib/api';
import { Button, FormError, Notice, TextArea } from './ui';
import { PhoneField } from '@bedo/ui';

/** 2-Step Verification reset (D-12): only after checking the person's identity; the check is recorded. */
export function TwoStepReset({ onSessionError }: { onSessionError: (error: unknown) => void }) {
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function review(event: FormEvent) {
    event.preventDefault();
    setDone(null);
    setError(null);
    setConfirming(true);
  }

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      await adminResetTwoStep({ phone: phone.trim(), reason: reason.trim() });
      setDone(`2-Step Verification was reset for ${phone.trim()}. The user has been informed.`);
      setPhone('');
      setReason('');
    } catch (caught) {
      onSessionError(caught);
      setError(
        caught instanceof ApiError && caught.code === 'NOT_FOUND'
          ? 'No account with this number has 2-Step Verification turned on.'
          : errorMessage(caught),
      );
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h1 className="text-[length:var(--bedo-font-size-xl)] font-semibold">2-Step Verification reset</h1>
      <Notice tone="warning">
        Reset a password only after confirming the person&apos;s identity (for example in person with their academy ID). Describe
        how you checked it: this is kept in the account&apos;s security history.
      </Notice>
      <form className="flex flex-col gap-4" onSubmit={review} noValidate>
        <PhoneField id="reset-phone" label="Account phone number" value={phone} onChange={setPhone} autoComplete="off" />
        <TextArea
          id="reset-reason"
          label="How was the identity checked?"
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <FormError message={error} />
        {done ? <p className="text-sm text-ink-secondary">{done}</p> : null}
        {confirming ? (
          <Notice tone="warning">
            <p>Remove the 2-Step Verification password of {phone.trim()}?</p>
            <div className="mt-3 flex gap-2">
              <Button variant="danger" busy={busy} onClick={() => void reset()}>
                Reset
              </Button>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </Notice>
        ) : (
          <Button type="submit" disabled={phone.trim().length < 5 || reason.trim().length < 3} className="self-start">
            Continue
          </Button>
        )}
      </form>
    </div>
  );
}
