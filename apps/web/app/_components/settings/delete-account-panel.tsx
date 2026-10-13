'use client';

import { requestAccountDeletion } from '@bedo/api-client';
import { useState } from 'react';
import { errorMessage } from '../../_lib/api';
import { useMe, useSession } from '../../_lib/session';
import { Button, FormError, Notice } from '../ui';

/** Account deletion request (D-14, P-10): an administrator reviews it; the user cannot withdraw it. */
export function DeleteAccountPanel() {
  const me = useMe();
  const { setMe } = useSession();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function request() {
    setBusy(true);
    setError(null);
    try {
      await requestAccountDeletion();
      setMe({ ...me, status: 'deletion_requested' });
      setConfirming(false);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  if (me.status === 'deletion_requested') {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Notice>
          Your request to delete your account has been sent. An administrator will review it, and you will be informed of
          the decision. Your account keeps working until then.
        </Notice>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <Notice tone="warning">
        <p>Deleting your account needs approval from an academy administrator.</p>
        <ul className="mt-2 list-disc pl-5">
          <li>Your account keeps working while the request is reviewed.</li>
          <li>A request cannot be withdrawn once sent.</li>
          <li>If it is approved, you are signed out everywhere and other users see &quot;Deleted account&quot;.</li>
          <li>The account&apos;s history is kept by the academy.</li>
        </ul>
      </Notice>
      <FormError message={error} />
      {confirming ? (
        <div className="flex flex-col gap-2 rounded-md bg-surface-subtle p-3">
          <p className="text-sm">Send the request to delete your account?</p>
          <div className="flex gap-2">
            <Button variant="danger" busy={busy} onClick={() => void request()}>
              Send request
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="danger" onClick={() => setConfirming(true)}>
          Request account deletion
        </Button>
      )}
    </div>
  );
}
