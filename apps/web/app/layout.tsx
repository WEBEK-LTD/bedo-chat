import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { SessionProvider } from './_lib/session';
import { THEME_COOKIE, themeFromCookie } from './_lib/theme';
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
      // D-54: the Bedo Chat brand icon.
      { url: '/favicon.ico', sizes: '16x16 32x32 48x48' },
      { url: '/icons/bedo-icon.svg', type: 'image/svg+xml' },
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
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#131c27' },
  ],
};

/**
 * D-31: pages are rendered per request so each response carries the nonce of its Content-Security-Policy
 * (proxy.ts); a page built ahead of time could not.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  // D-48: the theme the person chose (Settings -> Appearance), so the first paint is already right.
  const theme = themeFromCookie((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" dir="ltr" data-theme={theme}>
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
