import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { ThemeInit } from './_components/theme-init';
import './globals.css';

export const metadata: Metadata = {
  title: 'Bedo Chat Admin',
  robots: { index: false, follow: false },
  // Phase 13: the site's favicon (apps/web/public), served from the same site.
  icons: { icon: [{ url: '/favicon.ico', sizes: '32x32' }] },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#131c27' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" dir="ltr">
      <body>
        <ThemeInit />
        {children}
      </body>
    </html>
  );
}
