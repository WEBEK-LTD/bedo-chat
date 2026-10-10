import { type NextRequest, NextResponse } from 'next/server';
import { webCsp } from './csp.mjs';

/**
 * D-31: a strict Content-Security-Policy on every page of the student web app, with a fresh nonce per
 * response. Next.js reads the nonce from the policy on the request and puts it on its own scripts, so the
 * pages render per request (app/layout.tsx). The Admin Dashboard (/admin, static files), the API (/api, its own
 * route, D-36) and static assets are not handled here.
 */
export function proxy(request: NextRequest) {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));
  const policy = webCsp({
    nonce,
    storage: process.env.NEXT_PUBLIC_STORAGE_ORIGIN || undefined,
    dev: process.env.NODE_ENV === 'development',
    https: request.nextUrl.protocol === 'https:',
  });
  const headers = new Headers(request.headers);
  headers.set('content-security-policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: [
    {
      source: '/((?!api/|api$|admin/|admin$|_next/static/|_next/image/|icons/|favicon\\.ico$|sw\\.js$|manifest\\.webmanifest$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
