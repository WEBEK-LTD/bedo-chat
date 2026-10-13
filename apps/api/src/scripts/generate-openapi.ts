/* eslint-disable no-console -- build script */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from '@bedo/contracts/openapi';

// dist/scripts/generate-openapi.js -> apps/api
const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const { version } = JSON.parse(readFileSync(`${appRoot}package.json`, 'utf8')) as { version: string };
const document = buildOpenApiDocument({ version });

mkdirSync(`${appRoot}openapi`, { recursive: true });
writeFileSync(`${appRoot}openapi/openapi.json`, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote openapi/openapi.json (${Object.keys(document.paths ?? {}).length} paths)`);
