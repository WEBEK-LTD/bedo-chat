/**
 * Every generated API function sends its request through the transport the app installs at start-up.
 * The web app's transport adds the access token and refreshes it; the admin app's sends the admin cookie.
 * Both add the CSRF header. This package itself holds no credentials and no API address.
 */
export type Transport = <T>(url: string, init: RequestInit) => Promise<T>;

let transport: Transport | null = null;

export function setTransport(next: Transport): void {
  transport = next;
}

/** Called by the generated functions (orval mutator). */
export function apiFetch<T>(url: string, init: RequestInit): Promise<T> {
  if (!transport) {
    return Promise.reject(new Error('API transport not set: call setTransport() first'));
  }
  return transport<T>(url, init);
}
