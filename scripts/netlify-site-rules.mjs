// How the one Bedo Chat Netlify site (D-26) answers a request, as far as this repository decides it:
// - which static file Netlify serves for a URL (its static file matching, as in Netlify's own @netlify/static);
// - the custom headers from apps/web/netlify.toml for a path: a rule's path matches with or without a trailing
//   slash, and a path ending in "/*" matches everything below it.
// Netlify serves a matching static file before the Next.js server function (whose path is /* with
// preferStatic), so redirect rules are never reached on this site and none are used. Used by the unit tests
// and by the browser tests' local stand-in for the Netlify site (packages/e2e), so both test the real file.
//
// It reads only what that file uses: [[redirects]] (from, to, status, force) and [[headers]] (for, plus the
// [headers.values] table) with string, number and boolean values.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SITE_CONFIG = fileURLToPath(new URL('../apps/web/netlify.toml', import.meta.url));

function parseValue(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) return JSON.parse(value);
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  throw new Error(`Unsupported value in netlify.toml: ${value}`);
}

/** Returns the [[redirects]] and [[headers]] rules of a netlify.toml, in file order. */
export function parseSiteRules(toml) {
  const redirects = [];
  const headers = [];
  let current = null;
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      if (line === '[[redirects]]') {
        current = {};
        redirects.push(current);
      } else if (line === '[[headers]]') {
        current = { values: {} };
        headers.push(current);
      } else if (line === '[headers.values]' && headers.length > 0 && current === headers.at(-1)) {
        current = current.values;
      } else {
        current = null;
      }
      continue;
    }
    if (!current) continue;
    const match = /^("[^"]+"|[A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!match) throw new Error(`Unsupported line in netlify.toml: ${line}`);
    const key = match[1].startsWith('"') ? JSON.parse(match[1]) : match[1];
    current[key] = parseValue(match[2]);
  }
  return { redirects, headers };
}

export function readSiteRules(file = SITE_CONFIG) {
  return parseSiteRules(readFileSync(file, 'utf8'));
}

const trimSlash = (path) => (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path);

/** Whether a Netlify rule path ("/admin", "/admin/*") matches a request path. */
export function pathMatches(pattern, pathname) {
  if (pattern.endsWith('/*')) return pathname.startsWith(pattern.slice(0, -1));
  return trimSlash(pattern) === trimSlash(pathname);
}

const ASSET_EXTENSION = /\.(html?|png|jpg|js|css|svg|gif|ico|woff|woff2)$/;

/** The file paths Netlify tries, in order, for a URL path (Netlify's static file matching). */
export function staticCandidates(pathname) {
  const candidates = [];
  if (pathname.endsWith('/')) {
    const base = pathname.slice(0, -1);
    if (pathname !== '/') candidates.push(`${base}.html`, `${base}.htm`);
    candidates.push(`${pathname}index.html`, `${pathname}index.htm`);
  } else if (!ASSET_EXTENSION.test(pathname)) {
    candidates.push(`${pathname}.html`, `${pathname}.htm`, `${pathname}/index.html`, `${pathname}/index.htm`);
  }
  return candidates.includes(pathname) ? candidates : [pathname, ...candidates];
}

/** The file in `publicDir` that Netlify serves for a URL path, or null when the request goes to Next.js. */
export function resolveStatic(publicDir, pathname) {
  const root = path.resolve(publicDir);
  for (const candidate of staticCandidates(pathname)) {
    const file = path.resolve(root, ...candidate.split('/').filter(Boolean));
    if (!file.startsWith(`${root}${path.sep}`)) continue;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

/** The custom headers Netlify adds to a response for this request path. */
export function headersFor(rules, pathname) {
  const values = {};
  for (const rule of rules.headers) {
    if (pathMatches(rule.for, pathname)) Object.assign(values, rule.values);
  }
  return values;
}
