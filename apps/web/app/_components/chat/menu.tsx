'use client';

import { Icon, type IconName } from '@bedo/ui';
import { type ReactNode, useEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  icon: IconName;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** A small action menu opened from an icon button; closes on selection, Escape or a click outside. */
export function ActionMenu({ label, items, icon = 'more_vert', align = 'right' }: { label: string; items: MenuItem[]; icon?: IconName; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="grid size-9 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover"
      >
        <Icon name={icon} size={20} />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={label}
          className={`absolute top-full z-30 mt-1 min-w-48 rounded-md border border-line bg-surface py-1 shadow-sm ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface-hover disabled:opacity-50 ${item.danger ? 'text-danger' : 'text-ink'}`}
            >
              <Icon name={item.icon} size={20} className={item.danger ? 'text-danger' : 'text-ink-secondary'} />
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A centred dialog over the chat interface (forward, report, delete, folders). */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-ink/30 p-4" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className="flex max-h-[85vh] w-full max-w-[420px] flex-col rounded-md bg-surface">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 className="flex-1 text-[length:var(--bedo-font-size-lg)] font-medium">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="grid size-9 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover">
            <Icon name="close" size={20} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
