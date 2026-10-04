import { setTransport } from '@bedo/api-client';
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
    case 'OTP_INVALID':
      return 'The code is incorrect or has expired.';
    case 'OTP_LOCKED':
      return 'Too many incorrect codes. Request a new code.';
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
    case 'VALIDATION_FAILED':
      return error.fields?.[0]?.message ? `Please check the details: ${error.fields[0].message}.` : 'Please check the details and try again.';
    default:
      return 'Something went wrong. Try again.';
  }
}

export function formatDateTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}
