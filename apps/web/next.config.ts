import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';
import { storageOrigin } from './csp.mjs';

const appDir = path.dirname(fileURLToPath(import.meta.url));

/** Loaded by NestJS, Fastify or pg only when a feature Bedo Chat does not use is turned on. */
const OPTIONAL_PACKAGES = [
  'class-validator',
  'class-transformer',
  '@nestjs/microservices',
  '@nestjs/microservices/microservices-module.js',
  '@nestjs/websockets',
  '@nestjs/websockets/socket-module.js',
  '@nestjs/platform-express',
  '@fastify/static',
  '@fastify/view',
  'pg-native',
];

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
  // D-36: the API (app/api/[[...path]]) is bundled into the web app's server function. Native password hashing
  // and the Postgres driver stay Node.js packages loaded at run time (in Next.js's default list of server
  // packages, and dependencies of this app so they resolve from here). The API reads no files at run time.
  serverExternalPackages: ['@node-rs/argon2', '@node-rs/bcrypt', 'pg'],
  outputFileTracingRoot: path.join(appDir, '../..'),
  turbopack: {
    // Optional packages NestJS, Fastify and pg load only for features Bedo Chat does not use.
    resolveAlias: Object.fromEntries(OPTIONAL_PACKAGES.map((name) => [name, './app/api/_optional/absent.js'])),
  },
  // Local development only (`next dev`): the Admin Dashboard's own dev server (port 3001, basePath /admin) is shown
  // under this site's /admin, so the dashboard, the web app and the API share one origin as in production
  // (D-36). Production builds have no rewrites: Netlify serves the admin's static export from public/admin.
  async rewrites() {
    if (process.env.NODE_ENV !== 'development') {
      return [];
    }
    const admin = 'http://localhost:3001';
    return {
      beforeFiles: [
        { source: '/admin', destination: `${admin}/admin` },
        { source: '/admin/:path*', destination: `${admin}/admin/:path*` },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default config;
