import { type CountryCode, getCountries, getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js/min';

export type { CountryCode };

/** Phase 15: the country shown first on the phone fields (the owner's choice: Australia). */
export const DEFAULT_PHONE_COUNTRY: CountryCode = 'AU';

export interface PhoneCountry {
  code: CountryCode;
  /** Calling code without "+", e.g. "61". */
  dial: string;
  name: string;
}

let cached: PhoneCountry[] | null = null;

/** Other names people search with. */
const ALSO_KNOWN_AS: Partial<Record<CountryCode, string>> = {
  TR: 'turkey',
  GB: 'uk united kingdom england britain',
  US: 'usa america united states',
  AE: 'uae emirates dubai',
  SA: 'ksa saudi',
  EG: 'misr',
  KR: 'korea south',
  KP: 'korea north',
  RU: 'russia',
  CZ: 'czech',
  NL: 'holland netherlands',
  CI: 'ivory coast',
  PS: 'palestine',
};

const plain = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

/** Every country with a calling code, by English name. */
export function phoneCountries(): PhoneCountry[] {
  if (cached) return cached;
  const names = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
  cached = getCountries()
    .map((code) => ({ code, dial: getCountryCallingCode(code), name: names?.of(code) ?? code }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return cached;
}

/** Countries matching what was typed: a name ("tur"), a calling code ("90", "+90") or a country code ("TR"). */
export function searchCountries(query: string): PhoneCountry[] {
  const all = phoneCountries();
  const text = plain(query.trim());
  if (!text) return all;
  const digits = text.replace(/^\+|^00/, '').replace(/\D/g, '');
  const startsWithDigit = /^[+0-9]/.test(text);
  const scored = all
    .map((country) => {
      const name = plain(`${country.name} ${ALSO_KNOWN_AS[country.code] ?? ''}`);
      let score = -1;
      if (startsWithDigit && digits) {
        if (country.dial === digits) score = 0;
        else if (country.dial.startsWith(digits)) score = 1;
      } else {
        if (country.code.toLowerCase() === text) score = 0;
        else if (name.startsWith(text)) score = 1;
        else if (name.split(/[\s(),-]+/).some((word) => word.startsWith(text))) score = 2;
        else if (name.includes(text)) score = 3;
      }
      return { country, score };
    })
    .filter((item) => item.score >= 0);
  scored.sort((a, b) => a.score - b.score || a.country.name.localeCompare(b.country.name, 'en'));
  return scored.map((item) => item.country);
}

/**
 * The full international number (E.164, "+905441234567") for what the person typed after choosing a country: the
 * country's calling code is added, spaces and dashes are dropped, and the national "0" in front (0544 in Turkey,
 * 0412 in Australia) is removed where that country uses it. A number typed with "+" or "00" in front is taken as
 * it is, whatever country is chosen. Empty when nothing usable was typed.
 */
export function toInternational(typed: string, country: CountryCode): string {
  const trimmed = typed.trim();
  if (!trimmed) return '';
  const international = trimmed.startsWith('+') ? trimmed : trimmed.startsWith('00') ? `+${trimmed.slice(2)}` : null;
  if (international) {
    const parsed = parsePhoneNumberFromString(international);
    if (parsed) return parsed.number;
    const digits = international.replace(/\D/g, '');
    return digits ? `+${digits}` : '';
  }
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  const parsed = parsePhoneNumberFromString(digits, country);
  if (parsed && parsed.countryCallingCode === getCountryCallingCode(country)) return parsed.number;
  return `+${getCountryCallingCode(country)}${digits.replace(/^0+/, '')}`;
}

/** The country and national part of a full number, for showing it in the field again. */
export function splitInternational(e164: string, fallback: CountryCode): { country: CountryCode; national: string } {
  const parsed = e164 ? parsePhoneNumberFromString(e164) : undefined;
  if (parsed?.country) return { country: parsed.country, national: parsed.nationalNumber };
  return { country: fallback, national: '' };
}

/** Whether the number could be a real one (right length for its country). */
export function isPossiblePhone(e164: string): boolean {
  return Boolean(e164 && parsePhoneNumberFromString(e164)?.isPossible());
}

/**
 * When a whole international number is typed or pasted into the national box ("+90 544 …"), the country it belongs
 * to, so the field can switch to it.
 */
export function countryOfInternational(typed: string): { country: CountryCode; national: string } | null {
  const trimmed = typed.trim();
  const international = trimmed.startsWith('+') ? trimmed : trimmed.startsWith('00') ? `+${trimmed.slice(2)}` : null;
  if (!international) return null;
  const parsed = parsePhoneNumberFromString(international);
  return parsed?.country ? { country: parsed.country, national: parsed.nationalNumber } : null;
}
