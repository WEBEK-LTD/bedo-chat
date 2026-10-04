import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

/**
 * Normalises a phone number typed in international format ("+20 123 456 7890", "0020 1234567890")
 * to E.164 ("+201234567890"). Returns null when the number is not a valid phone number.
 */
export function normalizePhone(input: string): string | null {
  let value = input.trim().replace(/[\s().-]/g, '');
  if (value.startsWith('00')) {
    value = `+${value.slice(2)}`;
  }
  if (!value.startsWith('+')) {
    return null;
  }
  const parsed = parsePhoneNumberFromString(value);
  if (!parsed || !parsed.isValid()) {
    return null;
  }
  return parsed.number;
}

/** "+201234567890" -> "+20*******890" for logs; full numbers never go to logs. */
export function maskPhone(phone: string): string {
  if (phone.length <= 6) {
    return '***';
  }
  return `${phone.slice(0, 3)}${'*'.repeat(phone.length - 6)}${phone.slice(-3)}`;
}
