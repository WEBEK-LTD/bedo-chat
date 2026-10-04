import type { Metadata, Viewport } from 'next';
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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
