import 'reflect-metadata';
import { DELETED_ACCOUNT_NAME } from '@bedo/contracts';
import { describe, expect, it } from 'vitest';
import { AccountsService } from '../src/auth/accounts.service.js';
import type { DatabaseService } from '../src/database/database.service.js';
import type { ProfilePhotoStorage } from '../src/storage/profile-photo-storage.js';

const storage = {
  enabled: true,
  signedUrl: async (key: string) => `https://storage.test/${key}`,
} as unknown as ProfilePhotoStorage;
const accounts = new AccountsService({} as DatabaseService, storage);

describe('how other users see an account (D-14)', () => {
  it('shows a deleted account only as "Deleted account"', async () => {
    const view = await accounts.toPublicUser({
      id: 'u1',
      status: 'deleted',
      // Even if identity were somehow still present, none of it leaves the API.
      name: 'Old Name',
      username: 'old_name',
      bio: 'old bio',
      photo_key: 'u1/photo.png',
    });
    expect(view).toEqual({ id: 'u1', deleted: true, displayName: DELETED_ACCOUNT_NAME, username: null, bio: null, photoUrl: null });
    expect(DELETED_ACCOUNT_NAME).toBe('Deleted account');
  });

  it('shows an active account with its profile, including while deletion is requested (P-10)', async () => {
    for (const status of ['active', 'deletion_requested'] as const) {
      const view = await accounts.toPublicUser({ id: 'u2', status, name: 'Mona', username: 'mona_a', bio: 'Hi', photo_key: 'u2/p.png' });
      expect(view).toEqual({ id: 'u2', deleted: false, displayName: 'Mona', username: 'mona_a', bio: 'Hi', photoUrl: 'https://storage.test/u2/p.png' });
    }
  });
});
