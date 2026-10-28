'use client';

import { useEffect } from 'react';

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
      root.style.setProperty('--bedo-vv-height', `${Math.round(viewport.height)}px`);
      root.style.setProperty('--bedo-vv-top', `${Math.round(viewport.offsetTop)}px`);
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
