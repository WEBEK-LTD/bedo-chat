'use client';

import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

const QUIET_ZONE = 4;

/**
 * A QR code drawn as SVG in the page (no image service, no inline styles): dark modules on a light
 * background whatever the theme, as authenticator apps expect.
 */
export function QrCode({ value, label, size = 208 }: { value: string; label: string; size?: number }) {
  const { path, extent } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value, 'Byte');
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) {
          d += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
        }
      }
    }
    return { path: d, extent: count + QUIET_ZONE * 2 };
  }, [value]);

  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${extent} ${extent}`} shapeRendering="crispEdges" className="rounded-sm">
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
