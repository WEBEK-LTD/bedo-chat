import { describe, expect, it } from 'vitest';
import { isCommonPassword, isPhoneNumberPassword, loadCommonPasswords } from '../src/admin/password-policy.js';

describe('admin password rules (D-34)', () => {
  it('loads the built-in common-password list from disk', () => {
    const list = loadCommonPasswords();
    expect(list.size).toBeGreaterThan(40_000);
    for (const entry of list) {
      expect(entry.length).toBeGreaterThanOrEqual(12);
      expect(entry).toBe(entry.toLowerCase());
    }
  });

  it('matches common passwords regardless of case, width and surrounding spaces', () => {
    for (const password of ['123456789012', 'qwertyuiopasdfghjkl', 'PASSWORD1234', 'Password1234', 'ｐａｓｓｗｏｒｄ１２３４', ' password1234 ']) {
      expect(isCommonPassword(password), password).toBe(true);
    }
    for (const password of ['tidal-quartz-lantern-0471', 'my long and unusual passphrase', '🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒🔒']) {
      expect(isCommonPassword(password), password).toBe(false);
    }
  });

  it('recognises the admin phone number in every common spelling', () => {
    const phone = '+201097800006';
    for (const password of [
      '+201097800006',
      '201097800006',
      '00201097800006',
      '01097800006',
      '1097800006',
      '+20 109 780 0006',
      '+20-109-780-0006',
      '(010) 9780 0006',
      '010.9780.0006',
      ' +201097800006 ',
      '＋２０１０９７８００００６',
    ]) {
      expect(isPhoneNumberPassword(password, phone), password).toBe(true);
    }
    for (const password of ['+201097800007', 'my 01097800006 lantern', '201097800006x', '+905441234567']) {
      expect(isPhoneNumberPassword(password, phone), password).toBe(false);
    }
    expect(isPhoneNumberPassword('05441234567', '+905441234567')).toBe(true);
  });
});
