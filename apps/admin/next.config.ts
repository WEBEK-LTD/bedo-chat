import type { NextConfig } from 'next';

const config: NextConfig = {
  // D-25: the Admin Dashboard is served at https://bedochat.com/admin (pages and assets under /admin).
  basePath: '/admin',
  // D-26: one Netlify site serves both apps. The Admin Dashboard is a static export (apps/admin/out) that the
  // web app's build places under /admin (scripts/bundle-admin-into-web.mjs). Static files get no headers from
  // Next.js, so the admin's security headers (X-Frame-Options DENY, nosniff, Referrer-Policy, and a
  // Permissions-Policy turning off camera, microphone, screen capture and location) are set for /admin in
  // apps/web/netlify.toml.
  output: 'export',
  reactStrictMode: true,
  poweredByHeader: false,
};

export default config;
