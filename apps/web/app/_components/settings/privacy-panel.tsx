'use client';

import { getPrivacy, type Privacy, updatePrivacy } from '@bedo/api-client';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../_lib/api';
import { FormError } from '../ui';

const SETTINGS: Array<{ key: keyof Privacy; label: string }> = [
  { key: 'phoneVisibility', label: 'Who can see my phone number' },
  { key: 'lastSeenVisibility', label: 'Who can see my last seen' },
  { key: 'photoVisibility', label: 'Who can see my profile picture' },
  { key: 'messagesFrom', label: 'Who can message me' },
];

/** Privacy settings (P-08): Everyone or Nobody for each. */
export function PrivacyPanel() {
  const [privacy, setPrivacy] = useState<Privacy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPrivacy()
      .then(setPrivacy)
      .catch((caught: unknown) => setError(errorMessage(caught)));
  }, []);

  async function change(key: keyof Privacy, value: Privacy[keyof Privacy]) {
    setError(null);
    try {
      setPrivacy(await updatePrivacy({ [key]: value }));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  if (!privacy) {
    return <div className="p-4">{error ? <FormError message={error} /> : <p className="text-sm text-ink-secondary">Loading…</p>}</div>;
  }

  return (
    <div className="flex flex-col gap-1 p-2">
      {SETTINGS.map((setting) => (
        <label key={setting.key} className="flex min-h-12 items-center justify-between gap-4 rounded-sm px-2 hover:bg-surface-hover">
          <span className="text-sm">{setting.label}</span>
          <select
            value={privacy[setting.key]}
            onChange={(event) => void change(setting.key, event.target.value as Privacy[keyof Privacy])}
            className="h-9 rounded-sm border border-line bg-surface px-2 text-sm"
          >
            <option value="everyone">Everyone</option>
            <option value="nobody">Nobody</option>
          </select>
        </label>
      ))}
      <div className="px-2 pt-2">
        <FormError message={error} />
      </div>
    </div>
  );
}
