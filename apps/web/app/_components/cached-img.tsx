'use client';

import { type ImgHTMLAttributes, useEffect, useRef, useState } from 'react';
import { useCachedSrc } from '../_lib/media-cache';

/**
 * A picture kept in this browser after its first download (Phase 14.4, see media-cache.ts). With `lazy`, it is
 * fetched only when it comes near the screen (sticker grids hold hundreds).
 */
export function CachedImg({ src, lazy = false, alt, ...rest }: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'loading'> & { src: string | null | undefined; lazy?: boolean }) {
  const ref = useRef<HTMLImageElement>(null);
  const [near, setNear] = useState(!lazy);
  useEffect(() => {
    if (near) return;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNear(true);
        observer.disconnect();
      }
    }, { rootMargin: '200px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  const shown = useCachedSrc(near ? src : null);
  return <img ref={ref} src={near ? (shown ?? undefined) : undefined} alt={alt} {...rest} />;
}
