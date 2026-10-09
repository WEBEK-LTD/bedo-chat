// D-31: the Content-Security-Policy of the one Bedo Chat site (student web app and Admin Dashboard on one
// origin). It allows exactly what the current architecture needs and nothing else:
// - scripts and styles only from the site itself; the web app's pages are rendered per request with a fresh
//   nonce for Next.js's own inline scripts (proxy.ts), and the Admin Dashboard's static pages carry no inline
//   scripts at all (scripts/bundle-admin-into-web.mjs moves them into files);
// - the API, which is this same site (D-36: https://bedochat.com/api);
// - the Supabase project (NEXT_PUBLIC_STORAGE_ORIGIN, https://<project>.supabase.co), when set: profile
//   pictures from its private Storage through short-lived signed URLs (download, and the web app's direct
//   upload), and each device's realtime channel on its Realtime WebSocket (wss://<project>.supabase.co, D-36);
//   no other storage or realtime host;
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
 * @param {{ nonce: string, storage?: string, dev?: boolean, https?: boolean }} options
 * @returns {string}
 */
export function webCsp({ nonce, storage, dev = false, https = false }) {
  if (!/^[A-Za-z0-9+/=_-]{16,}$/.test(nonce)) {
    throw new Error('CSP nonce must be at least 16 base64 characters');
  }
  const storageSources = storage ? [storageOrigin(storage)] : [];
  // The project's Realtime WebSocket is on the same host as its Storage.
  const realtimeSources = storageSources.map((origin) => `wss://${new URL(origin).host}`);
  const connect = ["'self'", ...storageSources, ...realtimeSources];
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
