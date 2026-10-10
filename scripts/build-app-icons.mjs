// Builds the website's app icons (Phase 13, D-46): the Home Screen icon, the maskable icon, the Apple touch icon
// and the favicon, from one drawing: the Material Symbols "chat" glyph (filled) in white on the Bedo Chat accent.
// The PNG files are committed under apps/web/public/icons; run this again only to change the drawing:
//   node scripts/build-app-icons.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ACCENT = '#2f5bd3';
// Material Symbols Rounded 400, "chat" filled (Apache 2.0, @material-symbols/svg-400).
const GLYPH =
  'M240-240 131-131q-14 14-32.5 6.34Q80-132.31 80-152v-668q0-24 18-42t42-18h680q24 0 42 18t18 42v520q0 24-18 42t-42 18H240Zm30-159h253q12.75 0 21.38-8.68 8.62-8.67 8.62-21.5 0-12.82-8.62-21.32-8.63-8.5-21.38-8.5H270q-12.75 0-21.37 8.68-8.63 8.67-8.63 21.5 0 12.82 8.63 21.32 8.62 8.5 21.37 8.5Zm0-130h420q12.75 0 21.38-8.68 8.62-8.67 8.62-21.5 0-12.82-8.62-21.32-8.63-8.5-21.38-8.5H270q-12.75 0-21.37 8.68-8.63 8.67-8.63 21.5 0 12.82 8.63 21.32 8.62 8.5 21.37 8.5Zm0-130h420q12.75 0 21.38-8.68 8.62-8.67 8.62-21.5 0-12.82-8.62-21.32-8.63-8.5-21.38-8.5H270q-12.75 0-21.37 8.68-8.63 8.67-8.63 21.5 0 12.82 8.63 21.32 8.62 8.5 21.37 8.5Z';

/** The drawing on a 1024 canvas: `glyph` is the glyph's share of the canvas, `radius` the corner rounding. */
export function iconSvg({ glyph, radius }) {
  const size = 1024 * glyph;
  const offset = (1024 - size) / 2;
  const scale = size / 960;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<rect width="1024" height="1024" rx="${radius}" fill="${ACCENT}"/>
<g transform="translate(${offset} ${offset + size}) scale(${scale})"><path fill="#ffffff" d="${GLYPH}"/></g>
</svg>`;
}

/** An .ico holding one PNG (supported by every current browser). */
export function icoFromPng(png, size) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(size >= 256 ? 0 : size, 6);
  header.writeUInt8(size >= 256 ? 0 : size, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fromNext = createRequire(createRequire(new URL('../apps/web/package.json', import.meta.url)).resolve('next/package.json'));
  const sharp = fromNext('sharp');
  const out = (name) => fileURLToPath(new URL(`../apps/web/public/icons/${name}`, import.meta.url));
  const render = (svg, size) => sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
  // "any": rounded corners on transparency. "maskable": full bleed, the glyph inside the safe zone (80%).
  const rounded = iconSvg({ glyph: 0.56, radius: 224 });
  const fullBleed = iconSvg({ glyph: 0.5, radius: 0 });
  writeFileSync(out('icon-192.png'), await render(rounded, 192));
  writeFileSync(out('icon-512.png'), await render(rounded, 512));
  writeFileSync(out('maskable-512.png'), await render(fullBleed, 512));
  // iOS rounds the corners itself and shows transparency as black.
  writeFileSync(out('apple-touch-icon.png'), await render(fullBleed, 180));
  const favicon = await render(iconSvg({ glyph: 0.66, radius: 224 }), 32);
  writeFileSync(out('favicon-32.png'), favicon);
  writeFileSync(fileURLToPath(new URL('../apps/web/public/favicon.ico', import.meta.url)), icoFromPng(favicon, 32));
  console.log('App icons written to apps/web/public/icons and apps/web/public/favicon.ico');
}
