'use client';

import { type RefObject, useEffect, useRef } from 'react';

/** How far (in px) the finger moves before the gesture decides between "back" and scrolling. */
const DECIDE_PX = 10;
/** A release past this share of the screen's width, or a quick flick, goes back. */
const COMMIT_SHARE = 0.33;
const FLICK_PX_PER_MS = 0.45;
const ANIMATION_MS = 220;
/** Where the swipe is active: phones (on wider screens the chat list is beside the chat). */
const PHONE = '(max-width: 767px)';

/** Places where a sideways drag belongs to the element itself (typing, sliders, sideways scrolling, menus, dialogs). */
const OWN_GESTURE = 'input, textarea, select, [contenteditable="true"], [data-no-swipe], [data-context-menu], [role="slider"]';

function scrollsSideways(target: Element | null, stop: Element): boolean {
  for (let node = target; node && node !== stop; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') return true;
    }
  }
  return false;
}

export interface SwipeBackOptions {
  /** The page shown under the one being swiped away (it slides in from the left, Telegram-like). */
  under?: RefObject<HTMLElement | null>;
  /** Called with true when a swipe starts (to show the page underneath) and false when it ends. */
  onPeek?: (peeking: boolean) => void;
  /** Off while something else owns the screen (selection mode, a dialog). */
  enabled?: boolean;
}

/**
 * Phase 16.13: swipe right to go back, as in Telegram and other phone apps (the iPhone app's web view has no back
 * gesture of its own, and Android's comes only from the screen's edge). The page follows the finger from anywhere on
 * it; released past a third of the screen, or flicked, it slides away and `onBack` runs (the same as its back arrow);
 * otherwise it slides back. A drag that starts vertical stays a scroll. In a right-to-left layout the direction is
 * mirrored.
 */
export function useSwipeBack(ref: RefObject<HTMLElement | null>, onBack: (() => void) | null | undefined, options: SwipeBackOptions = {}): void {
  const latest = useRef({ onBack, options });
  latest.current = { onBack, options };
  const active = Boolean(onBack) && options.enabled !== false;

  useEffect(() => {
    const element = ref.current;
    if (!element || !active || typeof window === 'undefined' || !('ontouchstart' in window)) return;
    const phone = window.matchMedia(PHONE);
    element.dataset.swipeBack = '';

    let start: { x: number; y: number; time: number } | null = null;
    let dragging = false;
    let last = { x: 0, time: 0 };
    let velocity = 0;
    let width = 1;
    let sign = 1;
    let finishing = false;

    const paint = (dx: number, animate: boolean) => {
      const under = latest.current.options.under?.current;
      const progress = Math.min(1, Math.max(0, dx / width));
      const transition = animate ? `transform ${ANIMATION_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)` : 'none';
      element.style.transition = transition;
      element.style.transform = dx === 0 ? '' : `translate3d(${sign * dx}px, 0, 0)`;
      element.style.boxShadow = dx === 0 ? '' : '0 0 24px rgba(0, 0, 0, 0.18)';
      if (under) {
        under.style.transition = animate ? `transform ${ANIMATION_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1), filter ${ANIMATION_MS}ms` : 'none';
        under.style.transform = dx === 0 ? '' : `translate3d(${sign * -25 * (1 - progress)}%, 0, 0)`;
        under.style.filter = dx === 0 ? '' : `brightness(${0.9 + 0.1 * progress})`;
      }
    };

    const reset = () => {
      element.style.transition = '';
      element.style.transform = '';
      element.style.boxShadow = '';
      const under = latest.current.options.under?.current;
      if (under) {
        under.style.transition = '';
        under.style.transform = '';
        under.style.filter = '';
      }
    };

    const onStart = (event: TouchEvent) => {
      start = null;
      dragging = false;
      if (finishing || event.touches.length !== 1 || !phone.matches) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(OWN_GESTURE) || scrollsSideways(target, element)) return;
      // A dialog or panel open on this page (with its own swipe, or none) owns the touch.
      const owner = target?.closest('[data-swipe-back], [role="dialog"], [role="menu"]');
      if (owner && owner !== element && element.contains(owner)) return;
      const touch = event.touches[0]!;
      start = { x: touch.clientX, y: touch.clientY, time: event.timeStamp };
      last = { x: touch.clientX, time: event.timeStamp };
      velocity = 0;
      width = element.getBoundingClientRect().width || window.innerWidth;
      sign = getComputedStyle(element).direction === 'rtl' ? -1 : 1;
    };

    const onMove = (event: TouchEvent) => {
      if (!start || event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      const dx = (touch.clientX - start.x) * sign;
      const dy = touch.clientY - start.y;
      if (!dragging) {
        if (Math.abs(dx) < DECIDE_PX && Math.abs(dy) < DECIDE_PX) return;
        // Vertical, or towards the wrong side, or text being selected: not a back swipe.
        const selection = window.getSelection();
        if (dx <= 0 || Math.abs(dy) * 1.2 >= Math.abs(dx) || (selection && !selection.isCollapsed)) {
          start = null;
          return;
        }
        dragging = true;
        latest.current.options.onPeek?.(true);
      }
      if (event.cancelable) event.preventDefault();
      const elapsed = event.timeStamp - last.time;
      if (elapsed > 0) velocity = ((touch.clientX - last.x) * sign) / elapsed;
      last = { x: touch.clientX, time: event.timeStamp };
      paint(Math.max(0, dx), false);
    };

    const onEnd = (event: TouchEvent) => {
      if (!start) return;
      const wasDragging = dragging;
      const origin = start;
      start = null;
      dragging = false;
      if (!wasDragging) return;
      const touch = event.changedTouches[0];
      const dx = Math.max(0, ((touch?.clientX ?? last.x) - origin.x) * sign);
      const commit = event.type === 'touchend' && (dx > width * COMMIT_SHARE || (velocity > FLICK_PX_PER_MS && dx > DECIDE_PX * 3));
      finishing = true;
      paint(commit ? width : 0, true);
      window.setTimeout(() => {
        finishing = false;
        if (commit) latest.current.onBack?.();
        // After the page has changed, so the old page never flashes back in place.
        requestAnimationFrame(() => {
          reset();
          latest.current.options.onPeek?.(false);
        });
      }, ANIMATION_MS);
    };

    element.addEventListener('touchstart', onStart, { passive: true });
    element.addEventListener('touchmove', onMove, { passive: false });
    element.addEventListener('touchend', onEnd);
    element.addEventListener('touchcancel', onEnd);
    return () => {
      element.removeEventListener('touchstart', onStart);
      element.removeEventListener('touchmove', onMove);
      element.removeEventListener('touchend', onEnd);
      element.removeEventListener('touchcancel', onEnd);
      delete element.dataset.swipeBack;
      reset();
    };
  }, [ref, active]);
}
