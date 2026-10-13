'use client';

import { confirmPhotoUpload, removePhoto as deletePhoto, startPhotoUpload, updateMe } from '@bedo/api-client';
import { PROFILE_RULES } from '@bedo/contracts';
import { Icon } from '@bedo/ui';
import { type ChangeEvent, type FormEvent, useRef, useState } from 'react';
import { errorMessage } from '../../_lib/api';
import { useMe, useSession } from '../../_lib/session';
import { Avatar, Button, FormError, TextField } from '../ui';

type PhotoType = (typeof PROFILE_RULES.photoContentTypes)[number];

/** Name, username, bio and profile picture (P-04 to P-07). Every change is kept in identity history. */
export function ProfilePanel({ onChangePhone }: { onChangePhone: () => void }) {
  const me = useMe();
  const { setMe } = useSession();
  const [name, setName] = useState(me.name ?? '');
  const [username, setUsername] = useState(me.username ?? '');
  const [bio, setBio] = useState(me.bio ?? '');
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const changes: Record<string, string | null> = {};
  if (name.trim() !== (me.name ?? '')) changes.name = name.trim();
  if (username.trim() !== (me.username ?? '')) changes.username = username.trim() === '' ? null : username.trim();
  if (bio.trim() !== (me.bio ?? '')) changes.bio = bio.trim() === '' ? null : bio.trim();
  const usernameValid = username.trim() === '' || PROFILE_RULES.usernamePattern.test(username.trim());
  const canSave = Object.keys(changes).length > 0 && name.trim().length > 0 && usernameValid;

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      setMe(await updateMe(changes));
      setSaved(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function uploadPhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError(null);
    if (!(PROFILE_RULES.photoContentTypes as readonly string[]).includes(file.type)) {
      setError('Choose a JPEG, PNG or WebP picture.');
      return;
    }
    if (file.size > PROFILE_RULES.photoMaxBytes) {
      setError('The picture must be 5 MB or smaller.');
      return;
    }
    setPhotoBusy(true);
    try {
      const upload = await startPhotoUpload({ contentType: file.type as PhotoType, size: file.size });
      // Straight to private storage with a one-time signed URL; no storage credentials in the browser.
      const stored = await fetch(upload.uploadUrl, { method: upload.method, headers: upload.headers, body: file });
      if (!stored.ok) {
        throw new Error('upload failed');
      }
      setMe(await confirmPhotoUpload({ uploadId: upload.uploadId }));
    } catch (caught) {
      setError(caught instanceof Error && caught.message === 'upload failed' ? 'The picture could not be uploaded. Try again.' : errorMessage(caught));
    } finally {
      setPhotoBusy(false);
    }
  }

  async function removePhoto() {
    setPhotoBusy(true);
    setError(null);
    try {
      setMe(await deletePhoto());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPhotoBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4">
      <div className="flex items-center gap-4">
        <Avatar name={me.name} photoUrl={me.photoUrl} size={72} />
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInput}
            type="file"
            accept={PROFILE_RULES.photoContentTypes.join(',')}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(event) => void uploadPhoto(event)}
          />
          <Button variant="secondary" busy={photoBusy} onClick={() => fileInput.current?.click()}>
            <span className="flex items-center gap-2">
              <Icon name="photo_camera" size={20} />
              {me.photoUrl ? 'Change picture' : 'Add picture'}
            </span>
          </Button>
          {me.photoUrl ? (
            <Button variant="danger" busy={photoBusy} onClick={() => void removePhoto()}>
              Remove
            </Button>
          ) : null}
        </div>
      </div>

      <form className="flex flex-col gap-4" onSubmit={save} noValidate>
        <TextField
          id="profile-name"
          label="Name"
          maxLength={PROFILE_RULES.nameMaxLength}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
          error={name.trim().length === 0 ? 'Name is required.' : null}
        />
        <TextField
          id="profile-username"
          label="Username (optional)"
          maxLength={32}
          value={username}
          onChange={(event) => {
            setUsername(event.target.value);
            setSaved(false);
          }}
          hint="5–32 letters, digits or underscores, starting with a letter."
          error={usernameValid ? null : '5–32 letters, digits or underscores, starting with a letter.'}
        />
        <TextField
          id="profile-bio"
          label="Bio (optional)"
          maxLength={PROFILE_RULES.bioMaxLength}
          value={bio}
          onChange={(event) => {
            setBio(event.target.value);
            setSaved(false);
          }}
          hint={`${bio.length}/${PROFILE_RULES.bioMaxLength}`}
        />
        <FormError message={error} />
        {saved ? <p className="text-sm text-ink-secondary">Saved.</p> : null}
        <Button type="submit" busy={busy} disabled={!canSave}>
          Save
        </Button>
      </form>

      <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">Phone number</p>
          <p className="truncate text-sm text-ink-secondary">{me.phone}</p>
        </div>
        <Button variant="secondary" onClick={onChangePhone}>
          Change
        </Button>
      </div>
    </div>
  );
}
