'use client';

import { adminAddTestNumberRange, adminRemoveTestNumberRange, adminSetTestAccounts, adminTestAccounts, type AdminTestAccounts } from '@bedo/api-client';
import { TEST_ACCOUNT_RULES } from '@bedo/contracts';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, formatDateTime } from '../_lib/api';
import { Button, FormError, Notice, TextField } from './ui';

/** "+20 100 000 0000" → "+201000000000" (spaces, dashes and brackets dropped). */
function compact(value: string): string {
  return value.replace(/[\s\-()]/g, '');
}

/** What is wrong with a range typed in, or null when it can be added (the API checks the same again). */
function rangeProblem(first: string, last: string): string | null {
  if (!/^\+[1-9]\d{6,14}$/.test(first) || !/^\+[1-9]\d{6,14}$/.test(last)) return 'Type both numbers with the country code, for example +201000000000.';
  if (first.length !== last.length) return 'Both numbers must have the same number of digits.';
  if (first > last) return 'The last number must come after the first.';
  if (BigInt(last.slice(1)) - BigInt(first.slice(1)) + 1n > BigInt(TEST_ACCOUNT_RULES.maxRangeSize)) {
    return `A range holds at most ${TEST_ACCOUNT_RULES.maxRangeSize} numbers. For more, add another range after this one.`;
  }
  return null;
}

/**
 * D-59: test accounts, Super Admin only. Ranges of numbers that sign in to the student app with one fixed code, each
 * its own account, for trying the apps as students. Separate from the store review account above. Off by default.
 */
export function TestAccounts({ onSessionError }: { onSessionError: (error: unknown) => void }) {
  const [settings, setSettings] = useState<AdminTestAccounts | null>(null);
  const [code, setCode] = useState('');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    adminTestAccounts()
      .then((loaded) => {
        setSettings(loaded);
        setCode(loaded.code ?? '');
      })
      .catch((caught: unknown) => {
        onSessionError(caught);
        setError(errorMessage(caught));
      });
  }, [onSessionError]);

  useEffect(load, [load]);

  async function save(enabled: boolean, event?: FormEvent) {
    event?.preventDefault();
    setBusy(enabled ? 'save' : 'off');
    setError(null);
    setDone(null);
    try {
      const saved = await adminSetTestAccounts({ enabled, code });
      setSettings(saved);
      setDone(
        enabled
          ? 'Test accounts are on: every number in the ranges signs in with this code, no WhatsApp message.'
          : 'Test accounts are off: their numbers can no longer sign in, and their sessions were ended.',
      );
    } catch (caught) {
      onSessionError(caught);
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function addRange(event: FormEvent) {
    event.preventDefault();
    const firstPhone = compact(first);
    const lastPhone = compact(last);
    const problem = rangeProblem(firstPhone, lastPhone);
    setRangeError(problem);
    setDone(null);
    if (problem) return;
    setBusy('add');
    try {
      const saved = await adminAddTestNumberRange({ firstPhone, lastPhone });
      setSettings(saved);
      setFirst('');
      setLast('');
      setDone(`Range added: ${firstPhone} to ${lastPhone}.`);
    } catch (caught) {
      onSessionError(caught);
      const code = caught instanceof ApiError ? caught.code : null;
      setRangeError(
        code === 'CONFLICT'
          ? 'This range overlaps a range already added.'
          : code === 'LIMIT_REACHED'
            ? `At most ${TEST_ACCOUNT_RULES.maxRanges} ranges. Remove one first.`
            : code === 'VALIDATION_FAILED'
              ? 'These are not valid phone numbers for a range (same number of digits, the last after the first, at most 1000 numbers).'
              : errorMessage(caught),
      );
    } finally {
      setBusy(null);
    }
  }

  async function removeRange(id: string) {
    if (confirming !== id) {
      setConfirming(id);
      return;
    }
    setConfirming(null);
    setBusy(`remove-${id}`);
    setError(null);
    setDone(null);
    try {
      setSettings(await adminRemoveTestNumberRange(id));
      setDone('Range removed: its numbers can no longer sign in, and their sessions were ended.');
    } catch (caught) {
      onSessionError(caught);
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  const total = settings?.ranges.reduce((sum, range) => sum + range.size, 0) ?? 0;

  return (
    <section aria-labelledby="test-accounts-title" className="flex flex-col gap-3">
      <h2 id="test-accounts-title" className="font-semibold">
        Test accounts
      </h2>
      <p className="text-sm text-ink-secondary">
        For trying the apps as students. While this is on, every number in the ranges below signs in to the student app with one fixed code
        instead of a WhatsApp code; each number is its own account, like any student&apos;s (its own name, chats, groups and devices). Numbers on
        the academy phone list and existing students&apos; accounts are never test accounts, and the store review account above is not affected.
        Turn it off when testing is over: the test accounts then cannot sign in and their sessions end.
      </p>
      {!settings && error ? (
        <div className="flex flex-col items-start gap-2">
          <FormError message={`Could not load the test accounts: ${error}`} />
          <Button variant="secondary" onClick={load}>
            Try again
          </Button>
        </div>
      ) : !settings ? (
        <p className="text-sm text-ink-secondary">Loading…</p>
      ) : (
        <>
          <Notice tone={settings.enabled ? 'warning' : 'info'}>
            <span data-testid="test-accounts-status">
              {settings.enabled ? `On: ${total} ${total === 1 ? 'number' : 'numbers'} in ${settings.ranges.length} ${settings.ranges.length === 1 ? 'range' : 'ranges'}.` : 'Off.'}
              {settings.updatedAt ? ` Last changed ${formatDateTime(settings.updatedAt)} by ${settings.updatedBy ?? 'an admin'}.` : ''}
            </span>
          </Notice>
          <form className="flex flex-col gap-4" onSubmit={(event) => void save(true, event)} noValidate>
            <TextField
              id="test-accounts-code"
              label="Test accounts sign-in code"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              hint="6 digits, the same for every test number. Keep it to the people testing."
            />
            <FormError message={error} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" busy={busy === 'save'} disabled={!/^\d{6}$/.test(code)}>
                {settings.enabled ? 'Save code' : 'Save and turn on'}
              </Button>
              {settings.enabled ? (
                <Button type="button" variant="secondary" busy={busy === 'off'} disabled={!/^\d{6}$/.test(code)} onClick={() => void save(false)}>
                  Turn off
                </Button>
              ) : null}
            </div>
          </form>

          <h3 className="mt-2 text-sm font-semibold">Number ranges</h3>
          {settings.ranges.length === 0 ? (
            <p className="text-sm text-ink-secondary">No ranges yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line rounded-sm border border-line" aria-label="Test number ranges">
              {settings.ranges.map((range) => (
                <li key={range.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
                  <span className="font-medium tabular-nums">
                    {range.firstPhone} – {range.lastPhone}
                  </span>
                  <span className="text-ink-secondary">
                    {range.size} {range.size === 1 ? 'number' : 'numbers'} · {range.accounts} signed in
                  </span>
                  <Button
                    variant={confirming === range.id ? 'danger' : 'secondary'}
                    className="ml-auto h-8 px-3"
                    busy={busy === `remove-${range.id}`}
                    aria-label={confirming === range.id ? `Confirm removing ${range.firstPhone} to ${range.lastPhone}` : `Remove ${range.firstPhone} to ${range.lastPhone}`}
                    onClick={() => void removeRange(range.id)}
                  >
                    {confirming === range.id ? 'Confirm remove' : 'Remove'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form className="flex flex-col gap-3" onSubmit={(event) => void addRange(event)} noValidate aria-label="Add a range">
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField
                id="test-range-first"
                label="First number"
                inputMode="tel"
                autoComplete="off"
                placeholder="+201000000000"
                value={first}
                onChange={(event) => setFirst(event.target.value)}
              />
              <TextField
                id="test-range-last"
                label="Last number"
                inputMode="tel"
                autoComplete="off"
                placeholder="+201000000099"
                value={last}
                onChange={(event) => setLast(event.target.value)}
              />
            </div>
            <p className="text-xs text-ink-secondary">
              Every number from the first to the last, at most {TEST_ACCOUNT_RULES.maxRangeSize} in one range. To have more later, add the next range (for
              example +201000000100 to +201000000199).
            </p>
            <FormError message={rangeError} />
            <Button type="submit" className="self-start" busy={busy === 'add'} disabled={!first.trim() || !last.trim()}>
              Add range
            </Button>
          </form>
          {done ? (
            <p role="status" className="text-sm text-ink-secondary">
              {done}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
