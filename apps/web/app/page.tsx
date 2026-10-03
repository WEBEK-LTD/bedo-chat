import { Icon } from '@bedo/ui';

/**
 * Chat interface (spec §23). Phase 1 renders the layout only: the chat list column and the
 * conversation pane. Sign-in protection arrives in Phase 2 and chats in Phase 3.
 */
export default function ChatPage() {
  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[var(--bedo-chat-list-width)_1fr]">
      <aside className="flex min-h-0 flex-col border-line md:border-r" aria-label="Chats">
        <header className="flex h-[var(--bedo-header-height)] shrink-0 items-center gap-2 px-2">
          <button
            type="button"
            aria-label="Menu"
            disabled
            className="grid size-10 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent"
          >
            <Icon name="menu" />
          </button>
          <label className="flex h-9 flex-1 items-center gap-2 rounded-sm bg-surface-subtle px-3 text-ink-secondary">
            <Icon name="search" size={20} />
            <span className="sr-only">Search</span>
            <input
              type="search"
              placeholder="Search"
              disabled
              className="w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-secondary"
            />
          </label>
        </header>
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-ink-secondary">
          No chats yet.
        </div>
      </aside>

      <main className="hidden min-h-0 items-center justify-center bg-surface-subtle md:flex">
        <p className="text-sm text-ink-secondary">Select a chat to start messaging.</p>
      </main>
    </div>
  );
}
