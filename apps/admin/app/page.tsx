/**
 * Admin dashboard shell (spec §22). Admin sign-in (open decision O-17) and the Users, Groups,
 * Channels, Messages and System sections are built in Phase 10.
 */
export default function AdminHomePage() {
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex h-[var(--bedo-header-height)] items-center border-b border-line px-6">
        <span className="font-semibold">Bedo Chat Admin</span>
      </header>
      <main className="flex flex-1 items-center justify-center px-6 text-sm text-ink-secondary">
        No sections are available yet.
      </main>
    </div>
  );
}
