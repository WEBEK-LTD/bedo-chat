import { setTransport, type WaabekTestResponse } from '@bedo/api-client';
import { CSRF_HEADER, CSRF_HEADER_VALUE, type ErrorCode, type ErrorEnvelope } from '@bedo/contracts';

/** An error answer from the API (or a network failure, code NETWORK). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK',
    message: string,
    readonly retryAfterSeconds?: number,
    readonly fields?: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/$/, '');

/**
 * The admin app's transport for the generated API client (@bedo/api-client). The admin session is an
 * httpOnly cookie scoped to /v1/admin; every request carries the CSRF header. Nothing about the session is
 * readable from JavaScript.
 */
async function adminTransport<T>(path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set(CSRF_HEADER, CSRF_HEADER_VALUE);
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: 'include', cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the Bedo Chat API. Check your connection.');
  }
  if (response.ok) {
    return (await response.json()) as T;
  }
  const error = ((await response.json().catch(() => null)) as ErrorEnvelope | null)?.error;
  throw new ApiError(response.status, error?.code ?? 'INTERNAL', error?.message ?? 'Request failed', error?.retryAfterSeconds, error?.fields);
}

setTransport(adminTransport);

function formatWait(seconds: number): string {
  return seconds < 60 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;
}

export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Something went wrong. Try again.';
  }
  switch (error.code) {
    case 'NETWORK':
      return error.message;
    case 'RATE_LIMITED':
      return error.retryAfterSeconds ? `Too many attempts. Try again in ${formatWait(error.retryAfterSeconds)}.` : 'Too many attempts. Try again later.';
    case 'CREDENTIALS_INVALID':
      return 'The phone number or password is incorrect.';
    case 'PASSWORD_SETUP_INVALID':
      return 'The phone number or setup token is not valid. The token may have expired, been used, or been locked after wrong attempts: ask the owner to run the password setup SQL again.';
    case 'PASSWORD_IS_PHONE':
      return 'The password cannot be your phone number. Choose a different password.';
    case 'PASSWORD_TOO_COMMON':
      return 'This password is too common and easy to guess. Choose a different password.';
    case 'TOTP_INVALID':
      return 'The authenticator code is incorrect. Wait for the next code and try again.';
    case 'SESSION_INVALID':
      return 'The sign-in attempt has expired. Start again.';
    case 'UNAUTHENTICATED':
      return 'Your admin session has ended. Sign in again.';
    case 'FORBIDDEN':
      return 'Your role does not allow this action.';
    case 'NOT_FOUND':
      return 'Not found.';
    case 'CONFLICT':
      return 'This has already been decided.';
    case 'SETUP_UNAVAILABLE':
      return 'Initial setup is not available. It may be complete, or the setup token expired or was locked after wrong attempts: run the setup SQL again for a new token.';
    case 'SETUP_TOKEN_INVALID':
      return 'The setup token is incorrect.';
    case 'RECOVERY_UNAVAILABLE':
      return 'No Waabek key recovery is open. It may have expired or been locked after wrong attempts: run the recovery SQL again for a new token.';
    case 'RECOVERY_TOKEN_INVALID':
      return 'The recovery token is incorrect.';
    case 'RECOVERY_TOKEN_USED':
      return 'This recovery token has already saved a key. To save a different key, run the recovery SQL again for a new token.';
    case 'VALIDATION_FAILED':
      return error.fields?.[0]?.message ? `Please check the details: ${error.fields[0].message}.` : 'Please check the details and try again.';
    default:
      return 'Something went wrong. Try again.';
  }
}

/** Plain-language result of a WhatsApp test message (Phase 3.1). */
export function testMessageResult(result: WaabekTestResponse): { ok: boolean; text: string } {
  if (result.delivered) {
    return { ok: true, text: `Waabek accepted the test message to ${result.sentTo}. Check WhatsApp on that phone.` };
  }
  switch (result.reason) {
    case 'not_configured':
      return { ok: false, text: 'No Waabek API key is saved yet.' };
    case 'key_unreadable':
      return {
        ok: false,
        text: "The saved key cannot be decrypted with the server's settings encryption key (it may have been changed). Save the Waabek API key again.",
      };
    case 'rejected':
      return { ok: false, text: `Waabek refused the message${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}. Check the API key and your Waabek account.` };
    case 'unreachable':
      return { ok: false, text: 'Waabek could not be reached. Try again in a moment.' };
    default:
      return { ok: false, text: 'The background worker did not answer in time. Check that the worker service is running.' };
  }
}

export function formatDateTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}
