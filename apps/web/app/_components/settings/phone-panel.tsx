'use client';

import { requestPhoneChange, verifyPhoneChange } from '@bedo/api-client';
import { type FormEvent, useState } from 'react';
import { errorMessage } from '../../_lib/api';
import { useMe, useSession } from '../../_lib/session';
import { Button, FormError, Notice, TextField } from '../ui';

/** Change phone number: a code is sent by WhatsApp to the new number, which must be on the academy list. */
export function PhonePanel({ onDone }: { onDone: () => void }) {
  const me = useMe();
  const { setMe } = useSession();
  const [newPhone, setNewPhone] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function requestCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await requestPhoneChange({ newPhone: newPhone.trim() });
      setCodeSent(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await verifyPhoneChange({ newPhone: newPhone.trim(), code, ...(me.twoStepEnabled ? { twoStepPassword: password } : {}) });
      setMe(updated);
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <Notice>
        Your current number is {me.phone}. The new number must be registered with the academy. Your previous number stays in
        your account history.
      </Notice>
      {!codeSent ? (
        <form className="flex flex-col gap-4" onSubmit={requestCode} noValidate>
          <TextField
            id="new-phone"
            label="New phone number"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+20 10 1234 5678"
            value={newPhone}
            onChange={(event) => setNewPhone(event.target.value)}
          />
          <FormError message={error} />
          <Button type="submit" busy={busy} disabled={newPhone.trim().length < 5}>
            Send code
          </Button>
        </form>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={verify} noValidate>
          <p className="text-sm text-ink-secondary">If {newPhone.trim()} is registered with the academy, a code was sent to it by WhatsApp.</p>
          <TextField
            id="new-phone-code"
            label="Verification code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
          />
          {me.twoStepEnabled ? (
            <TextField
              id="new-phone-password"
              label="2-Step Verification password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          ) : null}
          <FormError message={error} />
          <Button type="submit" busy={busy} disabled={code.length !== 6 || (me.twoStepEnabled && password.length === 0)}>
            Change number
          </Button>
          <Button variant="ghost" onClick={() => setCodeSent(false)}>
            Use a different number
          </Button>
        </form>
      )}
    </div>
  );
}
