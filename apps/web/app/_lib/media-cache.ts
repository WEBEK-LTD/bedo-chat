'use client';

import { useEffect, useState } from 'react';

/**
 * Phase 14.4: pictures (profile photos, stickers, photo previews) kept in this browser, so a chat opens without
 * downloading them again. Storage links are signed and change on every visit, so a picture is kept under its address
 * without the signature (the object's path, which never changes for a given picture). Erased on sign-out with the
 * rest of the local data.
 */
const CACHE_NAME = 'bedo-media-v1';
/** At most this many pictures are kept; the oldest go first. */
const MAX_ENTRIES = 3000;

function cacheKey(src: string): string | null {
  if (typeof window === 'undefined' || typeof caches === 'undefined' || !window.isSecureContext) return null;
  try {
    const url = new URL(src, window.location.href);
    // Only signed storage links: absolute, on another host, with a signature in the query.
    if (url.origin === window.location.origin || !/^https?:$/.test(url.protocol) || !url.search) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

/** Object URLs handed out for each key in this page, shared by every picture showing it. */
const live = new Map<string, Promise<string | null>>();
/** How many pictures on screen show each key. */
const shown = new Map<string, number>();
/**
 * Pictures kept in memory although none shows them now (scrolling back is instant). Beyond this, a picture that is
 * no longer shown is let go from memory (it stays kept in this browser and comes back from there when needed), so a
 * page left open for days does not keep every picture it ever showed in memory.
 */
const LIVE_KEEP = 400;

function show(key: string): void {
  shown.set(key, (shown.get(key) ?? 0) + 1);
}

function hide(key: string): void {
  const count = (shown.get(key) ?? 1) - 1;
  if (count > 0) {
    shown.set(key, count);
    return;
  }
  shown.delete(key);
  if (live.size <= LIVE_KEEP) return;
  const pending = live.get(key);
  live.delete(key);
  void pending?.then((url) => {
    if (url) URL.revokeObjectURL(url);
  });
}

async function load(key: string, src: string): Promise<string | null> {
  try {
    const cache = await caches.open(CACHE_NAME);
    let response = await cache.match(key);
    if (!response) {
      const fetched = await fetch(src, { credentials: 'omit' });
      const type = fetched.headers.get('content-type') ?? '';
      if (!fetched.ok || !type.startsWith('image/')) return null;
      await cache.put(key, fetched.clone());
      void prune(cache);
      response = fetched;
    }
    return URL.createObjectURL(await response.blob());
  } catch {
    return null;
  }
}

let pruning = false;
async function prune(cache: Cache): Promise<void> {
  if (pruning) return;
  pruning = true;
  try {
    const keys = await cache.keys();
    for (const request of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(request);
  } finally {
    pruning = false;
  }
}

/**
 * The address to show for a picture: the copy kept in this browser when there is one (fetched and kept on first
 * use), otherwise the link itself. Anything that is not a signed storage link is returned as it is.
 */
export function useCachedSrc(src: string | null | undefined): string | null | undefined {
  const key = src ? cacheKey(src) : null;
  const [resolved, setResolved] = useState<{ key: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!key || !src) return;
    let cancelled = false;
    show(key);
    let pending = live.get(key);
    if (!pending) {
      pending = load(key, src);
      live.set(key, pending);
    }
    const current = pending;
    void current.then((url) => {
      if (!url && live.get(key) === current) live.delete(key);
      if (!cancelled) setResolved({ key, url });
    });
    return () => {
      cancelled = true;
      hide(key);
    };
  }, [key, src]);
  if (!key) return src;
  if (resolved?.key === key) return resolved.url ?? src;
  // Still loading: nothing yet rather than downloading the same picture twice.
  return undefined;
}

/** Sign-out: the kept pictures belong to the account and go with it. */
export async function clearMediaCache(): Promise<void> {
  for (const url of await Promise.all(live.values())) if (url) URL.revokeObjectURL(url);
  live.clear();
  shown.clear();
  if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME).catch(() => false);
}
