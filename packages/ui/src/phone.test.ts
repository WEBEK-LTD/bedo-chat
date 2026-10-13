import { describe, expect, it } from 'vitest';
import { countryOfInternational, isPossiblePhone, phoneCountries, searchCountries, splitInternational, toInternational } from './phone.js';

describe('phone numbers with a country picker (Phase 15)', () => {
  it('adds the chosen country code and drops the national 0', () => {
    expect(toInternational('532 123 4567', 'TR')).toBe('+905321234567');
    expect(toInternational('0532 123 45 67', 'TR')).toBe('+905321234567');
    expect(toInternational('0412 345 678', 'AU')).toBe('+61412345678');
    expect(toInternational('412-345-678', 'AU')).toBe('+61412345678');
    expect(toInternational('010 1234 5678', 'EG')).toBe('+201012345678');
    expect(toInternational('1012345678', 'EG')).toBe('+201012345678');
  });

  it('keeps a number typed in full international form, whatever country is chosen', () => {
    expect(toInternational('+90 532 123 4567', 'AU')).toBe('+905321234567');
    expect(toInternational('0090 532 123 4567', 'AU')).toBe('+905321234567');
    expect(countryOfInternational('+90 532 123 4567')).toEqual({ country: 'TR', national: '5321234567' });
    expect(countryOfInternational('544')).toBeNull();
  });

  it('gives nothing for nothing and splits a full number back', () => {
    expect(toInternational('  ', 'AU')).toBe('');
    expect(toInternational('abc', 'AU')).toBe('');
    expect(splitInternational('+61412345678', 'TR')).toEqual({ country: 'AU', national: '412345678' });
    expect(splitInternational('', 'AU')).toEqual({ country: 'AU', national: '' });
    expect(isPossiblePhone('+905321234567')).toBe(true);
    expect(isPossiblePhone('+9054')).toBe(false);
  });

  it('finds countries by name, calling code or country code', () => {
    expect(phoneCountries().length).toBeGreaterThan(200);
    expect(searchCountries('tur')[0]!.code).toBe('TR');
    expect(searchCountries('90')[0]!.code).toBe('TR');
    expect(searchCountries('+61')[0]!.code).toBe('AU');
    expect(searchCountries('egy')[0]!.code).toBe('EG');
    expect(searchCountries('au')[0]!.code).toBe('AU');
    expect(searchCountries('kingdom').map((country) => country.code)).toContain('GB');
    expect(searchCountries('')).toHaveLength(phoneCountries().length);
  });
});
