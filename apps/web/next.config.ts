import type { NextConfig } from 'next';
import { storageOrigin } from './csp.mjs';

// D-31: the Content-Security-Policy allows profile pictures only from this exact storage origin; a wrong value
// fails the build here instead of breaking pictures in production.
if (process.env.NEXT_PUBLIC_STORAGE_ORIGIN) {
  storageOrigin(process.env.NEXT_PUBLIC_STORAGE_ORIGIN);
}

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Camera, microphone and screen capture stay available to this origin for calls (spec §5, §16).
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), display-capture=(self), geolocation=()' },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
