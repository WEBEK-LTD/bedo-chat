// Builds every app icon from the Bedo Chat brand icon (D-54): apps/web/public/icons/bedo-icon.svg, as delivered by the
// owner (originals in docs/brand). One drawing for the website (favicon, Home Screen, maskable and Apple touch icons,
// the notification badge), the Android app (launcher, adaptive and themed icons, notification icon, splash) and the
// iPhone app (App Store icon, launch image). The PNG files are committed; run this again only when the brand changes:
//   node scripts/build-app-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const SOURCE = readFileSync(root('apps/web/public/icons/bedo-icon.svg'), 'utf8');

/** The parts of the brand icon (512 × 512): the gradient, the speech bubble, the "B" and the red dot. */
function parts(svg) {
  const pick = (pattern, what) => {
    const found = svg.match(pattern);
    if (!found) throw new Error(`bedo-icon.svg: ${what} not found`);
    return found[0];
  };
  return {
    defs: pick(/<defs>[\s\S]*?<\/defs>/, 'gradient'),
    bubble: pick(/<path d="M256 92[^"]*"[^>]*\/>/, 'speech bubble'),
    letter: pick(/<path d="M323[^"]*"[^>]*\/>/, '"B"'),
    dot: pick(/<circle[^>]*\/>/, 'red dot'),
  };
}
const ART = parts(SOURCE);
const BOX = { x: 80, y: 67, size: 367 }; // the drawing's bounds, the dot's ring included

/**
 * The icon on a square canvas. `art` is the drawing's share of the canvas width, `radius` the corner rounding (as a
 * share of the canvas; 0 = full bleed), `background` false leaves only the drawing (for Android's adaptive icon), and
 * `mono` draws it as one white shape with the "B" and the dot's ring cut out (notification and themed icons).
 */
export function iconSvg({ art = BOX.size / 512, radius = 112 / 512, background = true, mono = false } = {}) {
  const size = 1024;
  const scale = (size * art) / BOX.size;
  const x = (size - BOX.size * scale) / 2 - BOX.x * scale;
  const y = (size - BOX.size * scale) / 2 - BOX.y * scale;
  const drawing = mono
    ? `<mask id="m"><rect x="-100" y="-100" width="712" height="712" fill="#000"/>${ART.bubble.replace(/fill="[^"]*"/, 'fill="#fff"')}<circle cx="392" cy="122" r="55" fill="#000"/><circle cx="392" cy="122" r="46" fill="#fff"/>${ART.letter.replace(/fill="[^"]*"/, 'fill="#000"')}</mask><rect x="-100" y="-100" width="712" height="712" fill="#fff" mask="url(#m)"/>`
    : `${ART.bubble}${ART.letter}${ART.dot}`;
  const rect = background && !mono ? `<rect width="${size}" height="${size}" rx="${size * radius}" fill="url(#g)"/>` : '';
  const gradient = ART.defs.replace('x2="1" y2="1"', 'x2="1" y2="1" gradientUnits="objectBoundingBox"');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${gradient}${rect}<g transform="translate(${x} ${y}) scale(${scale})">${drawing}</g></svg>`;
}

/** An .ico holding PNGs (supported by every current browser). */
export function icoFromPngs(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ png, size }, index) => {
    const at = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fromNext = createRequire(createRequire(new URL('../apps/web/package.json', import.meta.url)).resolve('next/package.json'));
  const sharp = fromNext('sharp');
  const write = (path, data) => {
    mkdirSync(dirname(root(path)), { recursive: true });
    writeFileSync(root(path), data);
  };
  const png = (svg, size, { flatten = false } = {}) => {
    let image = sharp(Buffer.from(svg), { density: 300 }).resize(size, size);
    if (flatten) image = image.flatten({ background: '#14324a' });
    return image.png({ compressionLevel: 9 }).toBuffer();
  };
  const brand = SOURCE; // rounded corners on transparency, exactly as delivered
  const fullBleed = iconSvg({ radius: 0 });
  const safe = iconSvg({ radius: 0, art: 0.56 }); // inside the 80 % safe circle of maskable icons
  const badge = iconSvg({ mono: true, art: 0.86 });

  // Website (apps/web/public).
  write('apps/web/public/icons/icon-192.png', await png(brand, 192));
  write('apps/web/public/icons/icon-512.png', await png(brand, 512));
  write('apps/web/public/icons/maskable-512.png', await png(safe, 512));
  write('apps/web/public/icons/apple-touch-icon.png', await png(fullBleed, 180, { flatten: true })); // iOS rounds it
  write('apps/web/public/icons/badge-96.png', await png(badge, 96)); // Android's status bar: one colour
  const favicons = await Promise.all([16, 32, 48].map(async (size) => ({ size, png: await png(brand, size) })));
  write('apps/web/public/icons/favicon-32.png', favicons[1].png);
  write('apps/web/public/favicon.ico', icoFromPngs(favicons));

  // Android (apps/android/app/src/main/res).
  const res = 'apps/android/app/src/main/res';
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  const roundSvg = iconSvg({ radius: 0.5, art: 0.62 });
  const foreground = iconSvg({ background: false, art: 0.42 }); // the 66 dp safe circle of a 108 dp adaptive icon
  const monochrome = iconSvg({ mono: true, art: 0.42 });
  const backgroundSvg = iconSvg({ radius: 0, art: 0.0001 }).replace(/<g transform[\s\S]*<\/g>/, '');
  for (const [name, factor] of Object.entries(densities)) {
    write(`${res}/mipmap-${name}/ic_launcher.png`, await png(brand, Math.round(48 * factor)));
    write(`${res}/mipmap-${name}/ic_launcher_round.png`, await png(roundSvg, Math.round(48 * factor)));
    write(`${res}/mipmap-${name}/ic_launcher_foreground.png`, await png(foreground, Math.round(108 * factor)));
    write(`${res}/mipmap-${name}/ic_launcher_background.png`, await png(backgroundSvg, Math.round(108 * factor)));
    write(`${res}/mipmap-${name}/ic_launcher_monochrome.png`, await png(monochrome, Math.round(108 * factor)));
    write(`${res}/drawable-${name}/ic_notification.png`, await png(iconSvg({ mono: true, art: 0.9 }), Math.round(24 * factor)));
  }
  write(`${res}/drawable/splash.png`, await png(brand, 512));

  // iPhone (apps/ios/BedoChat/Assets.xcassets): the App Store icon has no transparency; iOS rounds it.
  const assets = 'apps/ios/BedoChat/Assets.xcassets';
  write(`${assets}/AppIcon.appiconset/AppIcon-1024.png`, await sharp(await png(fullBleed, 1024, { flatten: true })).removeAlpha().png().toBuffer());
  for (const scale of [1, 2, 3]) write(`${assets}/LaunchIcon.imageset/LaunchIcon@${scale}x.png`, await png(brand, 120 * scale));

  console.log('Icons written for the website, the Android app and the iPhone app.');
}
