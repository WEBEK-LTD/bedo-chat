import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { SessionProvider } from './_lib/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'Bedo Chat',
  applicationName: 'Bedo Chat',
  // Private academy application: never indexed by search engines.
  robots: { index: false, follow: false },
  // Phase 13 (D-46): installable from the browser ("Add to Home Screen" / "Install app"). On iPhone and iPad, Web
  // Push works only for the site added to the Home Screen, which needs this manifest. Static files in public/.
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '32x32' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
  appleWebApp: { capable: true, title: 'Bedo Chat', statusBarStyle: 'default' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#ffffff',
};

/**
 * D-31: pages are rendered per request so each response carries the nonce of its Content-Security-Policy
 * (proxy.ts); a page built ahead of time could not.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  return (
    <html lang="en" dir="ltr">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
