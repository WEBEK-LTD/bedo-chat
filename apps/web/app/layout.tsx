import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { SessionProvider } from './_lib/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'Bedo Chat',
  // Private academy application: never indexed by search engines.
  robots: { index: false, follow: false },
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
