import { refreshSession, setTransport } from '@bedo/api-client';
import { API_BASE_PATH, type AuthenticatedResponse, CSRF_HEADER, CSRF_HEADER_VALUE, type ErrorCode, type ErrorEnvelope } from '@bedo/contracts';

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

export type SignedOutReason = 'signed_out' | 'account_deleted' | 'account_blocked' | 'session_ended';

/** D-36: the API is served by this same site at /api (https://bedochat.com/api). */
const API_URL = API_BASE_PATH;

/** Path prefixes of requests that need the signed-in user's access token (Phase 3 added messaging, D-36 realtime). */
const USER_ROUTES = ['/v1/me', '/v1/chats', '/v1/messages', '/v1/users', '/v1/folders', '/v1/reports', '/v1/sync', '/v1/realtime'];
const isUserRoute = (path: string) => USER_ROUTES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`));

/**
 * The web app's transport for the generated API client (@bedo/api-client). The access token lives only in
 * memory (never in storage); the refresh token is an httpOnly cookie the browser sends to /v1/auth only.
 * Every request carries the CSRF header.
 */
class Session {
  private accessToken: string | null = null;
  private refreshing: Promise<AuthenticatedResponse> | null = null;
  private signedOutListener: ((reason: SignedOutReason) => void) | null = null;

  onSignedOut(listener: ((reason: SignedOutReason) => void) | null): void {
    this.signedOutListener = listener;
  }

  setSession(response: AuthenticatedResponse): void {
    this.accessToken = response.accessToken;
  }

  clear(): void {
    this.accessToken = null;
  }

  async send<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set(CSRF_HEADER, CSRF_HEADER_VALUE);
    if (this.accessToken && isUserRoute(path)) {
      headers.set('authorization', `Bearer ${this.accessToken}`);
    }
    let response: Response;
    try {
      response = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: 'include', cache: 'no-store' });
    } catch {
      throw new ApiError(0, 'NETWORK', 'Cannot reach Bedo Chat. Check your connection.');
    }
    if (response.ok) {
      return (await response.json()) as T;
    }
    const error = ((await response.json().catch(() => null)) as ErrorEnvelope | null)?.error;
    throw new ApiError(response.status, error?.code ?? 'INTERNAL', error?.message ?? 'Request failed', error?.retryAfterSeconds, error?.fields);
  }

  /** Exchanges the refresh cookie for a new access token. Concurrent callers share one request. */
  refresh(): Promise<AuthenticatedResponse> {
    this.refreshing ??= refreshSession()
      .then((response) => {
        this.setSession(response);
        return response;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private signedOut(error: ApiError): never {
    this.accessToken = null;
    const reason: SignedOutReason =
      error.code === 'ACCOUNT_DELETED' ? 'account_deleted' : error.code === 'ACCOUNT_BLOCKED' ? 'account_blocked' : 'session_ended';
    this.signedOutListener?.(reason);
    throw error;
  }

  /** Signed-in requests: on an expired access token, refresh once and retry; end the session if that fails. */
  async transport<T>(path: string, init: RequestInit): Promise<T> {
    if (!isUserRoute(path)) {
      return this.send<T>(path, init);
    }
    try {
      if (!this.accessToken) await this.refresh();
      return await this.send<T>(path, init);
    } catch (caught) {
      if (!(caught instanceof ApiError)) throw caught;
      if (caught.code === 'ACCOUNT_DELETED' || caught.code === 'ACCOUNT_BLOCKED' || caught.code === 'SESSION_INVALID') {
        this.signedOut(caught);
      }
      if (caught.code !== 'UNAUTHENTICATED') throw caught;
      try {
        await this.refresh();
      } catch (refreshError) {
        this.signedOut(refreshError instanceof ApiError ? refreshError : caught);
      }
      try {
        return await this.send<T>(path, init);
      } catch (retryError) {
        if (retryError instanceof ApiError && ['UNAUTHENTICATED', 'ACCOUNT_DELETED', 'ACCOUNT_BLOCKED'].includes(retryError.code)) {
          this.signedOut(retryError);
        }
        throw retryError;
      }
    }
  }
}

export const session = new Session();
setTransport((path, init) => session.transport(path, init));

function formatWait(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** A sentence for the user describing what went wrong. */
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
    case 'TWO_STEP_INVALID':
      return 'Incorrect password.';
    case 'TWO_STEP_REQUIRED':
      return 'Enter your 2-Step Verification password.';
    case 'ACCOUNT_DELETED':
      return 'This account has been deleted.';
    case 'ACCOUNT_BLOCKED':
      return 'This account is blocked. Contact the academy.';
    case 'USERNAME_TAKEN':
      return 'This username is already taken.';
    case 'SERVICE_UNAVAILABLE':
      return 'This is temporarily unavailable. Try again later.';
    case 'CONFLICT':
      return 'This has already been done.';
    case 'CANNOT_MESSAGE':
      return "You can't message this user";
    case 'USER_BLOCKED':
      return 'Unblock this user to send messages.';
    case 'LIMIT_REACHED':
      return 'You have reached the limit for this.';
    case 'NOT_FOUND':
      return 'This is no longer available.';
    case 'VALIDATION_FAILED':
      return error.fields?.[0]?.message ? `Please check the details: ${error.fields[0].message}.` : 'Please check the details and try again.';
    default:
      return 'Something went wrong. Try again.';
  }
}

/** A short, readable device name sent with sign-in, e.g. "Chrome on Windows". */
export function browserDeviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const system = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'unknown system';
  return `${browser} on ${system}`;
}
