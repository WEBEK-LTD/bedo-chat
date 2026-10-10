'use client';

import { Icon, type IconName } from '@bedo/ui';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  icon: IconName;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** Space kept between an open menu and the edge of the screen. */
const SCREEN_MARGIN = 8;

/**
 * A small action menu opened from an icon button; closes on selection, Escape or a click outside. Phase 13: on a
 * small screen the open menu is moved back inside the screen, and opens upwards when there is no room below.
 */
export function ActionMenu({ label, items, icon = 'more_vert', align = 'right' }: { label: string; items: MenuItem[]; icon?: IconName; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ x: 0, up: false });
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Measured once per opening, in the menu's natural place (before anything is moved).
  useLayoutEffect(() => {
    if (!open || !menu.current) return;
    const rect = menu.current.getBoundingClientRect();
    let x = 0;
    if (rect.right > window.innerWidth - SCREEN_MARGIN) x = window.innerWidth - SCREEN_MARGIN - rect.right;
    if (rect.left + x < SCREEN_MARGIN) x = SCREEN_MARGIN - rect.left;
    const button = root.current?.getBoundingClientRect();
    const up = rect.bottom > window.innerHeight - SCREEN_MARGIN && button !== undefined && button.top - rect.height - SCREEN_MARGIN > 0;
    setPlace({ x, up });
  }, [open]);

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
        onClick={() => {
          setPlace({ x: 0, up: false });
          setOpen((value) => !value);
        }}
        className="grid size-9 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink"
      >
        <Icon name={icon} size={20} />
      </button>
      {open ? (
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          style={place.x ? { transform: `translateX(${Math.round(place.x)}px)` } : undefined}
          className={`bedo-fade-in absolute z-30 min-w-52 max-w-[calc(100vw-16px)] rounded-md border border-line bg-surface p-1.5 shadow-raised ${place.up ? 'bottom-full mb-1' : 'top-full mt-1'} ${align === 'right' ? 'right-0' : 'left-0'}`}
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
              className={`flex w-full items-center gap-3 rounded-sm px-3 py-2 text-left text-sm transition-colors hover:bg-surface-hover disabled:opacity-50 ${item.danger ? 'text-danger' : 'text-ink'}`}
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
    <div className="bedo-fade-in fixed inset-0 z-40 grid place-items-center bg-scrim/40 p-4 backdrop-blur-[2px]" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className="bedo-pop-in flex max-h-[85vh] w-full max-w-[420px] flex-col overflow-hidden rounded-md bg-surface shadow-raised">
        <header className="flex items-center gap-2 px-5 pb-2 pt-4">
          <h2 className="flex-1 text-[length:var(--bedo-font-size-lg)] font-semibold">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="grid size-9 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink">
            <Icon name="close" size={20} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-2">{children}</div>
      </div>
    </div>
  );
}
