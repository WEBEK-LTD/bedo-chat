'use client';

import { useEffect } from 'react';

/** The visible area is this much shorter than the page only when the on-screen keyboard is open. */
const KEYBOARD_MIN_PX = 120;

/**
 * On iPhone (Safari and the app's web view) the on-screen keyboard does not make the page smaller: iOS slides the
 * whole page up under the keyboard, so the chat's header (the chat or group name) went off the top of the screen.
 * The chat screen is therefore kept to the part of the page that is actually visible (the visual viewport): its
 * height and its top follow the keyboard as it opens and closes (CSS variables --bedo-vv-height and --bedo-vv-top,
 * used by .bedo-app-viewport in globals.css). Where the keyboard already shrinks the page (Android, computers) the
 * values are simply the full window, so nothing changes there.
 */
export function useVisualViewportFit(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let frame = 0;
    const apply = () => {
      frame = 0;
      // Phase 16.15: only while the keyboard covers part of the page. Otherwise the visible area moves only when iOS
      // bounces the page at the end of a drag (or when zoomed), and following it made the chat list move against the
      // finger: then the screen stays on the whole window, as on every other phone.
      const layoutHeight = root.clientHeight || window.innerHeight;
      const keyboard = viewport.scale <= 1.01 && layoutHeight - viewport.height > KEYBOARD_MIN_PX;
      root.style.setProperty('--bedo-vv-height', keyboard ? `${Math.round(viewport.height)}px` : '100%');
      root.style.setProperty('--bedo-vv-top', keyboard ? `${Math.max(0, Math.round(viewport.offsetTop))}px` : '0px');
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    apply();
    viewport.addEventListener('resize', schedule);
    viewport.addEventListener('scroll', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport.removeEventListener('resize', schedule);
      viewport.removeEventListener('scroll', schedule);
      root.style.removeProperty('--bedo-vv-height');
      root.style.removeProperty('--bedo-vv-top');
    };
  }, []);
}
