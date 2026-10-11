/**
 * The Bedo Chat brand (D-54), from the owner's files in apps/web/public/icons (originals in docs/brand). Served by the
 * one site, so the student app and the Admin Dashboard (under /admin) both load them from /icons.
 */

const LOGO_RATIO = 1244 / 512;

/** The logo with the name and "Australian Dental Academy": navy on light screens, white on dark ones. */
export function BrandLogo({ height, className }: { height: number; className?: string }) {
  const width = Math.round(height * LOGO_RATIO);
  return (
    <span role="img" aria-label="Bedo Chat, Australian Dental Academy" className={className}>
      <img src="/icons/bedo-chat-logo.svg" alt="" width={width} height={height} className="bedo-brand-light" />
      <img src="/icons/bedo-chat-logo-white.svg" alt="" width={width} height={height} className="bedo-brand-dark" />
    </span>
  );
}

/** The app icon alone (the speech bubble with the "B"). */
export function BrandIcon({ size, className }: { size: number; className?: string }) {
  return <img src="/icons/bedo-icon.svg" alt="" width={size} height={size} className={className} />;
}
