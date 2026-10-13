// Generates src/icons.generated.ts from the official Material Symbols SVG package
// (@material-symbols/svg-400, Apache-2.0). Icons are never drawn by hand or generated (spec §26).
//
//   node scripts/generate-icons.mjs          write the file
//   node scripts/generate-icons.mjs --check  fail if the committed file is out of date
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const packageRoot = path.dirname(require.resolve('@material-symbols/svg-400/package.json'));
const { version } = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const { icons } = JSON.parse(readFileSync(path.join(here, 'icons.json'), 'utf8'));
const outFile = path.join(here, '..', 'src', 'icons.generated.ts');

const names = [...new Set(icons)].sort();
const entries = names.map((name) => {
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error(`Invalid icon name "${name}"`);
  }
  const svg = readFileSync(path.join(packageRoot, 'outlined', `${name}.svg`), 'utf8');
  if (!svg.includes('viewBox="0 -960 960 960"')) {
    throw new Error(`Unexpected viewBox in ${name}.svg`);
  }
  const paths = [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((match) => match[1]);
  if (paths.length === 0) {
    throw new Error(`No path data found in ${name}.svg`);
  }
  return `  ${name}: [${paths.map((d) => JSON.stringify(d)).join(', ')}],`;
});

const output = `// GENERATED FILE - do not edit. Run \`pnpm --filter @bedo/ui icons\` after changing scripts/icons.json.
// Source: Google Material Symbols, Outlined, weight 400 (@material-symbols/svg-400 ${version}).
// Licensed under the Apache License 2.0 - see packages/ui/THIRD_PARTY_NOTICES.md.

export const ICON_VIEW_BOX = '0 -960 960 960';

export const ICON_PATHS = {
${entries.join('\n')}
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICON_PATHS;
`;

if (process.argv.includes('--check')) {
  const current = readFileSync(outFile, 'utf8');
  if (current !== output) {
    console.error('src/icons.generated.ts is out of date. Run `pnpm --filter @bedo/ui icons`.');
    process.exit(1);
  }
  console.log(`icons.generated.ts is up to date (${names.length} icons).`);
} else {
  writeFileSync(outFile, output);
  console.log(`Wrote ${names.length} icons to src/icons.generated.ts`);
}
