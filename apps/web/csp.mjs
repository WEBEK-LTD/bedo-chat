// D-31: the Content-Security-Policy of the one Bedo Chat site (student web app and Admin Dashboard on one
// origin). It allows exactly what the current architecture needs and nothing else:
// - scripts and styles only from the site itself; the web app's pages are rendered per request with a fresh
//   nonce for Next.js's own inline scripts (proxy.ts), and the Admin Dashboard's static pages carry no inline
//   scripts at all (scripts/bundle-admin-into-web.mjs moves them into files);
// - the API (https://bedochat.com/api, the same origin in production) over HTTPS and its WebSocket
//   (wss://bedochat.com/api/v1/realtime);
// - profile pictures from the project's private Supabase Storage through short-lived signed URLs (download,
//   and the web app's direct upload): exactly the origin in NEXT_PUBLIC_STORAGE_ORIGIN, the Supabase project URL
//   (https://<project>.supabase.co), when profile pictures are set up; no other storage host;
// - the push service worker (/sw.js);
// - no frames, plugins, other sites' scripts, fonts or forms, and the pages cannot be framed.
// Used by apps/web/proxy.ts and by the tests in scripts/csp.test.mjs; the Admin Dashboard's value is set in
// both netlify.toml files (D-28) and must equal ADMIN_CSP.

/**
 * Checks the storage origin for profile pictures (P-07, P-15): an https origin with no path and no wildcard,
 * e.g. https://abcdefghijklmnop.supabase.co. Returns it normalised, or throws.
 * @param {string} value
 * @returns {string}
 */
export function storageOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`NEXT_PUBLIC_STORAGE_ORIGIN must be an https origin such as https://<project>.supabase.co (got "${value}")`);
  }
  if (url.protocol !== 'https:' || url.origin !== value.replace(/\/$/, '') || value.includes('*') || url.username || url.password) {
    throw new Error(`NEXT_PUBLIC_STORAGE_ORIGIN must be an https origin with no path or wildcard, such as https://<project>.supabase.co (got "${value}")`);
  }
  return url.origin;
}

/** The Admin Dashboard's static pages (D-26): same-origin scripts, styles and API calls only. */
export const ADMIN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";

/**
 * The student web app's policy for one response.
 * @param {{ nonce: string, apiUrl?: string, storage?: string, dev?: boolean, https?: boolean }} options
 * @returns {string}
 */
export function webCsp({ nonce, apiUrl, storage, dev = false, https = false }) {
  if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(nonce)) {
    throw new Error('CSP nonce must be at least 16 base64 characters');
  }
  const connect = ["'self'"];
  if (apiUrl) {
    const api = new URL(apiUrl);
    connect.push(api.origin, `${api.protocol === 'https:' ? 'wss:' : 'ws:'}//${api.host}`);
  }
  const storageSources = storage ? [storageOrigin(storage)] : [];
  connect.push(...storageSources);
  const directives = [
    ['default-src', ["'none'"]],
    // 'strict-dynamic': scripts the nonce'd Next.js scripts load are allowed; nothing else is.
    // Development (next dev) only: React needs eval for its debugging aids, and the dev overlay's styles.
    ['script-src', ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])]],
    ['style-src', dev ? ["'self'", "'unsafe-inline'"] : ["'self'", `'nonce-${nonce}'`]],
    ['img-src', ["'self'", 'data:', 'blob:', ...storageSources]],
    ['font-src', ["'self'"]],
    ['connect-src', [...new Set(connect)]],
    ['worker-src', ["'self'"]],
    ['manifest-src', ["'self'"]],
    ['base-uri', ["'none'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['object-src', ["'none'"]],
  ];
  const policy = directives.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
  return https ? `${policy}; upgrade-insecure-requests` : policy;
}
