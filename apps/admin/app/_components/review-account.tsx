'use client';

import { adminReviewAccount, adminSetReviewAccount, type AdminReviewAccount } from '@bedo/api-client';
import { type FormEvent, useEffect, useState } from 'react';
import { errorMessage, formatDateTime } from '../_lib/api';
import { Button, FormError, Notice, TextField } from './ui';

/**
 * D-56: the store review account, Super Admin only. One phone number that signs in to the student app with a fixed
 * 6-digit code instead of a WhatsApp code, so Google Play and Apple reviewers can open the apps. Off by default.
 */
export function ReviewAccount({ onSessionError }: { onSessionError: (error: unknown) => void }) {
  const [settings, setSettings] = useState<AdminReviewAccount | null>(null);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    adminReviewAccount()
      .then((loaded) => {
        setSettings(loaded);
        setPhone(loaded.phone ?? '');
        setCode(loaded.code ?? '');
      })
      .catch((caught: unknown) => {
        onSessionError(caught);
        setError(errorMessage(caught));
      });
  }, [onSessionError]);

  async function save(enabled: boolean, event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const saved = await adminSetReviewAccount({ enabled, phone: phone.trim(), code });
      setSettings(saved);
      setPhone(saved.phone ?? '');
      setDone(
        enabled
          ? 'The review account is on: this number signs in with this code, no WhatsApp message.'
          : 'The review account is off: the number needs a WhatsApp code again, and its sessions were ended.',
      );
    } catch (caught) {
      onSessionError(caught);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  const valid = phone.trim().length >= 5 && /^\d{6}$/.test(code);

  return (
    <section aria-labelledby="review-account-title" className="flex flex-col gap-3">
      <h2 id="review-account-title" className="font-semibold">
        Store review account
      </h2>
      <p className="text-sm text-ink-secondary">
        Google Play and Apple review the apps with sign-in details that keep working; their reviewers cannot receive a WhatsApp code. While this is
        on, the number below signs in to the student app with the code below instead. Every other number still gets a WhatsApp code. Turn it off
        when the review is over.
      </p>
      {!settings ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : (
        <>
          <Notice tone={settings.enabled ? 'warning' : 'info'}>
            <span data-testid="review-account-status">
              {settings.enabled ? `On for ${settings.phone ?? ''}.` : 'Off.'}
              {settings.updatedAt ? ` Last changed ${formatDateTime(settings.updatedAt)} by ${settings.updatedBy ?? 'an admin'}.` : ''}
            </span>
          </Notice>
          <form className="flex flex-col gap-4" onSubmit={(event) => void save(true, event)} noValidate>
            <TextField
              id="review-phone"
              label="Phone number"
              inputMode="tel"
              autoComplete="off"
              placeholder="+61 400 000 000"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              hint="With the country code. Use a number nobody else signs in with: while this is on, that number gets no WhatsApp code."
            />
            <TextField
              id="review-code"
              label="Fixed sign-in code"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              hint="6 digits. Give the number and this code to Google Play and Apple in their sign-in details form."
            />
            <FormError message={error} />
            {done ? (
              <p role="status" className="text-sm text-ink-secondary">
                {done}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" busy={busy} disabled={!valid}>
                {settings.enabled ? 'Save' : 'Save and turn on'}
              </Button>
              {settings.enabled ? (
                <Button type="button" variant="secondary" busy={busy} disabled={!valid} onClick={() => void save(false)}>
                  Turn off
                </Button>
              ) : null}
            </div>
          </form>
        </>
      )}
    </section>
  );
}
