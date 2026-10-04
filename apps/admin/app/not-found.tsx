import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Not found · Bedo Chat Admin' };

/**
 * D-31: the "not found" page, styled from the dashboard's stylesheet. Next.js's built-in page uses inline
 * styles, which the Admin Dashboard's Content-Security-Policy blocks.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-sm text-ink-secondary">This page does not exist.</p>
      <Link href="/" className="text-sm font-medium text-accent hover:underline">
        Go to the Admin Dashboard
      </Link>
    </main>
  );
}
