import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { WorkerEnv } from '@bedo/config';
import { OTP_DELIVERY_ERRORS } from '@bedo/contracts';
import type { DbHandle } from '@bedo/db';
import * as crypto from '@bedo/server-crypto';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { OtpConfigurationError, WaabekKeyProvider } from '../src/otp/waabek-key.provider.js';

vi.mock('@bedo/server-crypto', async (importOriginal) => {
  const original = await importOriginal<typeof crypto>();
  return { ...original, decryptWaabekApiKey: vi.fn(original.decryptWaabekApiKey) };
});

const settingsKey = randomBytes(32);
// Fake keys only (D-32: real keys are set from the Admin Dashboard).
const KEY_1 = 'fake-waabek-key-provider-0001';
const KEY_2 = 'fake-waabek-key-provider-0002';

/** A settings row the test changes like the Admin Dashboard would; counts the queries. */
function fakeDatabase(initial: { version: string; waabek_api_key_enc: string | null } | undefined) {
  const state = { row: initial, queries: 0, fail: false };
  const db = {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirst: async () => {
            state.queries += 1;
            if (state.fail) throw new Error('connection refused');
            return state.row;
          },
        }),
      }),
    }),
  };
  return { state, handle: { db } as unknown as DbHandle };
}

const provider = (database: DbHandle) => new WaabekKeyProvider({ SETTINGS_ENCRYPTION_KEY: settingsKey.toString('base64') } as WorkerEnv, database);

describe('WaabekKeyProvider (D-32 refresh mechanism)', () => {
  it('checks the settings before every message but decrypts only when they change', async () => {
    const decrypt = vi.mocked(crypto.decryptWaabekApiKey);
    decrypt.mockClear();
    const { state, handle } = fakeDatabase({ version: '1', waabek_api_key_enc: crypto.encryptWaabekApiKey(settingsKey, KEY_1) });
    const keys = provider(handle);
    expect(await keys.currentKey()).toBe(KEY_1);
    expect(await keys.currentKey()).toBe(KEY_1);
    expect(await keys.currentKey()).toBe(KEY_1);
    expect(state.queries).toBe(3);
    expect(decrypt).toHaveBeenCalledTimes(1);

    state.row = { version: '2', waabek_api_key_enc: crypto.encryptWaabekApiKey(settingsKey, KEY_2) };
    expect(await keys.currentKey()).toBe(KEY_2);
    expect(decrypt).toHaveBeenCalledTimes(2);
    expect(keys.cachedVersion).toBe('2');
  });

  it('fails closed: no key, an unreadable key, or an unreachable database never sends with the cached key', async () => {
    const { state, handle } = fakeDatabase({ version: '1', waabek_api_key_enc: crypto.encryptWaabekApiKey(settingsKey, KEY_1) });
    const keys = provider(handle);
    expect(await keys.currentKey()).toBe(KEY_1);

    state.fail = true;
    await expect(keys.currentKey()).rejects.toThrow('connection refused');
    state.fail = false;

    state.row = { version: '2', waabek_api_key_enc: null };
    const missing = await keys.currentKey().catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(OtpConfigurationError);
    expect(missing).toBeInstanceOf(UnrecoverableError);
    expect((missing as Error).message).toBe(OTP_DELIVERY_ERRORS.notConfigured);
    expect(keys.cachedVersion).toBeNull();

    const wrongKeyValue = crypto.encryptWaabekApiKey(randomBytes(32), KEY_2);
    state.row = { version: '3', waabek_api_key_enc: wrongKeyValue };
    const unreadable = await keys.currentKey().catch((error: unknown) => error as Error);
    expect((unreadable as Error).message).toBe(OTP_DELIVERY_ERRORS.keyUnreadable);
    const text = `${(unreadable as Error).message} ${(unreadable as Error).stack ?? ''}`;
    expect(text).not.toContain(wrongKeyValue);
    expect(text).not.toContain(KEY_2);

    state.row = undefined;
    await expect(keys.currentKey()).rejects.toThrow(OTP_DELIVERY_ERRORS.notConfigured);
  });

  it('re-decrypts when the stored value changes even if the version were the same', async () => {
    const { state, handle } = fakeDatabase({ version: '5', waabek_api_key_enc: crypto.encryptWaabekApiKey(settingsKey, KEY_1) });
    const keys = provider(handle);
    expect(await keys.currentKey()).toBe(KEY_1);
    state.row = { version: '5', waabek_api_key_enc: crypto.encryptWaabekApiKey(settingsKey, KEY_2) };
    expect(await keys.currentKey()).toBe(KEY_2);
  });

  it('refuses to start without a valid 32-byte SETTINGS_ENCRYPTION_KEY', () => {
    const { handle } = fakeDatabase(undefined);
    expect(() => new WaabekKeyProvider({ SETTINGS_ENCRYPTION_KEY: randomBytes(16).toString('base64') } as WorkerEnv, handle)).toThrow(/32 bytes/);
  });
});
