import { readFileSync } from 'node:fs';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/**
 * Admin password rules beyond length (D-34): a password may not be the admin's own phone number in any common
 * spelling, and may not be on the built-in common-password list (assets/common-passwords.txt, loaded once from
 * disk; no network calls). Length (12–128 characters, no forced character mix) is checked by the contract.
 */

const LIST_URL = new URL('../../assets/common-passwords.txt', import.meta.url);

let commonPasswords: ReadonlySet<string> | null = null;

/** Loads the list once. Fails loudly (the API does not start) if the file is missing or empty. */
export function loadCommonPasswords(): ReadonlySet<string> {
  if (!commonPasswords) {
    const entries = readFileSync(LIST_URL, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (entries.length < 1000) {
      throw new Error('The common-password list is missing or incomplete');
    }
    commonPasswords = new Set(entries);
  }
  return commonPasswords;
}

const normalise = (value: string) => value.normalize('NFKC').toLowerCase();

export function isCommonPassword(password: string): boolean {
  const list = loadCommonPasswords();
  const value = normalise(password);
  return list.has(value) || list.has(value.trim());
}

/**
 * Whether the password is the admin's phone number: E.164 ("+905441234567"), without "+" ("905441234567"),
 * with "00" ("00905441234567"), the national form ("05441234567") or any of these with spaces, dots, dashes or
 * brackets.
 */
export function isPhoneNumberPassword(password: string, phoneE164: string): boolean {
  const compact = password.normalize('NFKC').trim().replace(/[\s().\-/]/g, '');
  const digits = phoneE164.replace(/^\+/, '');
  if (compact === phoneE164 || compact === digits || compact === `00${digits}`) {
    return true;
  }
  const phone = parsePhoneNumberFromString(phoneE164);
  if (!phone) {
    return false;
  }
  if (compact === phone.nationalNumber || compact === `0${phone.nationalNumber}`) {
    return true;
  }
  // Only a password that is nothing but a number is parsed: the parser would otherwise find the number inside
  // longer text, and a password that merely contains the number is allowed (the rule is "equal to").
  if (!/^\+?\d+$/.test(compact)) {
    return false;
  }
  const asNumber = phone.country ? parsePhoneNumberFromString(compact, phone.country) : undefined;
  return Boolean(asNumber?.isValid() && asNumber.number === phoneE164);
}
