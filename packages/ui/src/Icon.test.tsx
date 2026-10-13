import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Icon } from './Icon.js';
import { ICON_PATHS } from './icons.generated.js';

describe('Icon', () => {
  it('renders a decorative icon hidden from assistive technology', () => {
    const html = renderToStaticMarkup(<Icon name="search" />);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('viewBox="0 -960 960 960"');
    expect(html).toContain('fill="currentColor"');
    expect(html).not.toContain('<title>');
  });

  it('renders a labelled icon as an image with a title', () => {
    const html = renderToStaticMarkup(<Icon name="close" title="Close" size={20} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('<title>Close</title>');
    expect(html).toContain('width="20"');
  });

  it('has path data for every generated icon', () => {
    for (const paths of Object.values(ICON_PATHS)) {
      expect(paths.length).toBeGreaterThan(0);
    }
  });

  it('matches the official Material Symbols source', () => {
    const script = fileURLToPath(new URL('../scripts/generate-icons.mjs', import.meta.url));
    expect(() => execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});
