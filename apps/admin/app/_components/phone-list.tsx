'use client';

import { adminAddPhone, adminImportPhones, adminListPhones, type PhoneListImportResponse as ImportResult, type PhoneListResponseItemsItem as PhoneItem } from '@bedo/api-client';
import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { errorMessage, formatDateTime } from '../_lib/api';
import { Button, FormError, Notice, TextArea, TextField } from './ui';


const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  deletion_requested: 'Deletion requested',
  suspended: 'Suspended',
  banned: 'Banned',
  deleted: 'Deleted',
};

/** Academy phone list (D-06, P-11): view and search; Super Admins add one number or import a CSV. */
export function PhoneList({ canChange, onSessionError }: { canChange: boolean; onSessionError: (error: unknown) => void }) {
  const [items, setItems] = useState<PhoneItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [addBusy, setAddBusy] = useState(false);
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const [csv, setCsv] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const load = useCallback(
    async (append: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const response = await adminListPhones({ ...(query ? { search: query } : {}), ...(append ? { cursor: append } : {}) });
        setItems((current) => (append ? [...current, ...response.items] : response.items));
        setCursor(response.nextCursor);
      } catch (caught) {
        onSessionError(caught);
        setError(errorMessage(caught));
      } finally {
        setLoading(false);
      }
    },
    [query, onSessionError],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  async function add(event: FormEvent) {
    event.preventDefault();
    setAddBusy(true);
    setAddError(null);
    setAddMessage(null);
    try {
      const result = await adminAddPhone({ phone: phone.trim(), ...(note.trim() ? { note: note.trim() } : {}) });
      setAddMessage(result.added ? `${result.phone} was added.` : `${result.phone} is already on the list.`);
      setPhone('');
      setNote('');
      await load(null);
    } catch (caught) {
      onSessionError(caught);
      setAddError(errorMessage(caught));
    } finally {
      setAddBusy(false);
    }
  }

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) {
      setCsv(await file.text());
    }
  }

  async function runImport() {
    setImportBusy(true);
    setImportError(null);
    setImportResult(null);
    try {
      setImportResult(await adminImportPhones({ csv }));
      setCsv('');
      await load(null);
    } catch (caught) {
      onSessionError(caught);
      setImportError(errorMessage(caught));
    } finally {
      setImportBusy(false);
    }
  }

  return (
    <div className="flex max-w-4xl flex-col gap-8">
      <section className="flex flex-col gap-4">
        <h1 className="text-[length:var(--bedo-font-size-xl)] font-semibold">Academy phone list</h1>
        <p className="text-sm text-ink-secondary">Only numbers on this list can sign in to Bedo Chat.</p>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(search.trim());
          }}
        >
          <input
            type="search"
            aria-label="Search numbers"
            placeholder="Search numbers"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-[var(--bedo-control-height)] flex-1 rounded-sm border border-line bg-surface px-3 text-sm outline-none focus:border-accent"
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        <FormError message={error} />
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-subtle text-ink-secondary">
              <tr>
                <th className="px-3 py-2 font-medium">Phone number</th>
                <th className="px-3 py-2 font-medium">Note</th>
                <th className="px-3 py-2 font-medium">Added</th>
                <th className="px-3 py-2 font-medium">Account</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {items.map((item) => (
                <tr key={item.phone}>
                  <td className="px-3 py-2 font-medium whitespace-nowrap">{item.phone}</td>
                  <td className="px-3 py-2">{item.note ?? '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(item.addedAt)}</td>
                  <td className="px-3 py-2">{item.accountStatus ? STATUS_LABELS[item.accountStatus] : 'Not signed in yet'}</td>
                </tr>
              ))}
              {!loading && items.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-ink-secondary">
                    No numbers found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {cursor ? (
          <Button variant="secondary" busy={loading} onClick={() => void load(cursor)} className="self-start">
            Load more
          </Button>
        ) : null}
      </section>

      {canChange ? (
        <>
          <section className="flex flex-col gap-4 border-t border-line pt-6">
            <h2 className="font-semibold">Add a number</h2>
            <form className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end" onSubmit={add} noValidate>
              <TextField id="add-phone" label="Phone number" type="tel" placeholder="+20 10 1234 5678" value={phone} onChange={(event) => setPhone(event.target.value)} />
              <TextField id="add-note" label="Note (optional)" maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} />
              <Button type="submit" busy={addBusy} disabled={phone.trim().length < 5}>
                Add
              </Button>
            </form>
            <FormError message={addError} />
            {addMessage ? <p className="text-sm text-ink-secondary">{addMessage}</p> : null}
          </section>

          <section className="flex flex-col gap-4 border-t border-line pt-6">
            <h2 className="font-semibold">Import from CSV</h2>
            <p className="text-sm text-ink-secondary">
              One number per line in international format, with an optional note in the second column. A header line is
              ignored. Numbers already on the list are skipped and reported.
            </p>
            <input type="file" accept=".csv,text/csv,text/plain" onChange={(event) => void readFile(event)} className="text-sm" aria-label="Choose a CSV file" />
            <TextArea id="import-csv" label="Or paste the numbers" value={csv} onChange={(event) => setCsv(event.target.value)} placeholder={'phone,note\n+201012345678,Group A'} />
            <FormError message={importError} />
            <Button busy={importBusy} disabled={csv.trim().length === 0} onClick={() => void runImport()} className="self-start">
              Import
            </Button>
            {importResult ? (
              <Notice tone={importResult.invalid.length > 0 ? 'warning' : 'info'}>
                <p>
                  {importResult.added} added, {importResult.duplicates.length} already on the list, {importResult.invalid.length} not valid.
                </p>
                {importResult.invalid.length > 0 ? (
                  <ul className="mt-2 list-disc pl-5">
                    {importResult.invalid.slice(0, 50).map((entry) => (
                      <li key={entry.line}>
                        Line {entry.line}: &quot;{entry.value}&quot; — {entry.reason}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Notice>
            ) : null}
          </section>
        </>
      ) : (
        <Notice>Your Moderator role can view the list. Adding and importing numbers needs a Super Admin.</Notice>
      )}
    </div>
  );
}
