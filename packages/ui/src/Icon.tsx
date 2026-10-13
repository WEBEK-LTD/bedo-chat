import { ICON_PATHS, ICON_VIEW_BOX, type IconName } from './icons.generated.js';

export interface IconProps {
  name: IconName;
  /** Rendered size in pixels (width and height). */
  size?: number;
  /**
   * Accessible label. Leave empty for decorative icons next to visible text;
   * set it for icon-only buttons only when the button itself has no aria-label.
   */
  title?: string;
  className?: string;
}

/** Material Symbols icon rendered as inline SVG in the current text colour. */
export function Icon({ name, size = 24, title, className }: IconProps) {
  const labelled = typeof title === 'string' && title.length > 0;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={ICON_VIEW_BOX}
      width={size}
      height={size}
      fill="currentColor"
      focusable="false"
      className={className}
      {...(labelled ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      {labelled ? <title>{title}</title> : null}
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
