import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Not found · Bedo Chat' };

/**
 * D-31: the "not found" page, styled from the app's stylesheet. Next.js's built-in page uses inline style
 * attributes, which the Content-Security-Policy blocks. Not a route of its own: the app still has only / and
 * /login (spec §23).
 */
export default function NotFound() {
  return (
    <main className="flex min-h-full flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-sm text-ink-secondary">This page does not exist.</p>
      <Link href="/" className="text-sm font-medium text-accent hover:underline">
        Go to Bedo Chat
      </Link>
    </main>
  );
}
