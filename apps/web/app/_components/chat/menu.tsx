'use client';

import { Icon, type IconName } from '@bedo/ui';
import { type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

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

/** How long a finger stays on a message or a chat before its menu opens, and how far it may move meanwhile. */
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP = 10;

/**
 * The same actions as an item's menu button, opened where the item is held (Telegram-like): a long press on a touch
 * screen, or a right click with a mouse. Closes on a choice, Escape, or a tap outside.
 */
export function ContextMenu({ label, items, at, onClose }: { label: string; items: MenuItem[]; at: { x: number; y: number }; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!menu.current) return;
    const rect = menu.current.getBoundingClientRect();
    const width = window.innerWidth;
    const height = window.visualViewport?.height ?? window.innerHeight;
    const left = Math.min(Math.max(SCREEN_MARGIN, at.x), width - rect.width - SCREEN_MARGIN);
    // Below the finger when it fits, else above it, always inside the visible screen.
    const below = at.y + 8;
    const top = below + rect.height <= height - SCREEN_MARGIN ? below : Math.max(SCREEN_MARGIN, at.y - rect.height - 8);
    setPlace({ left: Math.max(SCREEN_MARGIN, left), top });
  }, [at]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div data-context-menu className="fixed inset-0 z-50" onPointerDown={(event) => event.target === event.currentTarget && onClose()} onContextMenu={(event) => event.preventDefault()}>
      <div
        ref={menu}
        role="menu"
        aria-label={label}
        style={{ left: place?.left ?? at.x, top: place?.top ?? at.y, visibility: place ? 'visible' : 'hidden' }}
        className="bedo-fade-in fixed min-w-52 max-w-[calc(100vw-16px)] rounded-md border border-line bg-surface p-1.5 shadow-raised"
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            className={`flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-left text-sm transition-colors hover:bg-surface-hover disabled:opacity-50 ${item.danger ? 'text-danger' : 'text-ink'}`}
          >
            <Icon name={item.icon} size={20} className={item.danger ? 'text-danger' : 'text-ink-secondary'} />
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** What an item spreads on its element to open its menu by a long press or a right click. */
export interface PressHandlers {
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
  onClickCapture: (event: ReactMouseEvent) => void;
}

/**
 * Long press (touch) or right click (mouse) on an item opens its menu at that point. The tap that ends a long press
 * does not also open the item; scrolling cancels the press.
 */
export function useContextMenu(label: string, items: MenuItem[], enabled = true): { bind: PressHandlers; menu: ReactNode } {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const opened = useRef(false);
  const active = enabled && items.length > 0;

  // Events from the open menu itself (it is inside the item in React's tree) are not presses on the item.
  const inMenu = (event: { target: EventTarget }) => event.target instanceof Element && event.target.closest('[data-context-menu]') !== null;
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  useEffect(() => cancel, []);

  const bind: PressHandlers = {
    onPointerDown(event) {
      if (inMenu(event)) return;
      opened.current = false;
      if (!active || event.pointerType === 'mouse' || event.button !== 0) return;
      const point = { x: event.clientX, y: event.clientY };
      start.current = point;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        opened.current = true;
        (navigator as Navigator & { vibrate?: (ms: number) => boolean }).vibrate?.(10);
        setAt(point);
      }, LONG_PRESS_MS);
    },
    onPointerMove(event) {
      const from = start.current;
      if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > LONG_PRESS_SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu(event) {
      if (!active || inMenu(event)) return;
      event.preventDefault();
      // Android also reports a long press as a context menu: open once.
      if (opened.current || at) return;
      cancel();
      opened.current = event.nativeEvent instanceof PointerEvent ? event.nativeEvent.pointerType !== 'mouse' : false;
      setAt({ x: event.clientX, y: event.clientY });
    },
    onClickCapture(event) {
      if (!opened.current || inMenu(event)) return;
      opened.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
  const menu = at ? <ContextMenu label={label} items={items} at={at} onClose={() => setAt(null)} /> : null;
  return { bind, menu };
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
