// Fails if the user web app exposes any route other than the two the spec allows (§23):
// "/login" and "/" (the chat interface). Everything else in the user experience lives inside
// the chat interface as panels, never as separate pages. D-36: the only other route is the API's
// route handler, /api/[[...path]] (a route.ts, never a page), which serves the API at /api/*.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ALLOWED_ROUTES = ['/', '/login'];
/** D-36: the API inside the website. Allowed only as a route handler (route.ts), never as a page. */
export const API_ROUTE = '/api/[[...path]]';
/** Framework-internal routes Next.js always generates; they are not application pages. */
const FRAMEWORK_ROUTES = ['/_not-found', '/_global-error'];
const ROUTE_FILE = /^(page|route)\.(tsx|ts|jsx|js|mdx)$/;
/** Next.js metadata files become URLs of their own (/sitemap.xml, /robots.txt, /icon, ...). */
const METADATA_FILE =
  /^(sitemap|robots|manifest|icon\d*|apple-icon\d*|opengraph-image\d*|twitter-image\d*|favicon)\.(tsx|ts|jsx|js|xml|txt|json|webmanifest|ico|png|jpg|jpeg|svg|gif)$/;

export function collectRoutes(appDir) {
  const routes = [];
  const walk = (dir, segments) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // Private folders (_x) never become routes; route groups ((x)) do not add a segment.
        if (entry.name.startsWith('_')) continue;
        const isGroup = entry.name.startsWith('(') && entry.name.endsWith(')');
        walk(path.join(dir, entry.name), isGroup ? segments : [...segments, entry.name]);
      } else if (ROUTE_FILE.test(entry.name)) {
        const route = `/${segments.join('/')}`;
        // The API route counts as allowed only when it is a route handler.
        routes.push(route === API_ROUTE && !entry.name.startsWith('route.') ? `${route} (page)` : route);
      } else if (METADATA_FILE.test(entry.name)) {
        routes.push(`/${[...segments, entry.name].join('/')} (metadata route)`);
      }
    }
  };
  walk(appDir, []);
  return routes.sort();
}

export function checkRoutes(routes) {
  const unexpected = routes.filter((route) => !ALLOWED_ROUTES.includes(route) && route !== API_ROUTE);
  const missing = [...ALLOWED_ROUTES, API_ROUTE].filter((route) => !routes.includes(route));
  return { unexpected, missing, ok: unexpected.length === 0 && missing.length === 0 };
}

/** Other places Next.js would also turn into routes. */
export function forbiddenRouteDirs(webRoot) {
  return ['pages', 'src/pages', 'src/app'].filter((dir) => existsSync(path.join(webRoot, dir)));
}

/** Routes actually produced by the last `next build`, or null when there is no build. */
export function builtRoutes(webRoot) {
  const manifest = path.join(webRoot, '.next', 'app-path-routes-manifest.json');
  if (!existsSync(manifest)) return null;
  return Object.values(JSON.parse(readFileSync(manifest, 'utf8')))
    .filter((route) => !FRAMEWORK_ROUTES.includes(route))
    .sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const webRoot = fileURLToPath(new URL('../apps/web', import.meta.url));
  const problems = [];

  const sourceRoutes = collectRoutes(path.join(webRoot, 'app'));
  const source = checkRoutes(sourceRoutes);
  if (source.unexpected.length) problems.push(`Routes not allowed by spec §23: ${source.unexpected.join(', ')}`);
  if (source.missing.length) problems.push(`Required routes missing: ${source.missing.join(', ')}`);

  for (const dir of forbiddenRouteDirs(webRoot)) problems.push(`apps/web/${dir} must not exist (it would add routes)`);

  const built = builtRoutes(webRoot);
  if (built) {
    const result = checkRoutes(built);
    if (!result.ok) problems.push(`The last build produced routes ${built.join(', ')}; only ${[...ALLOWED_ROUTES, API_ROUTE].join(', ')} are allowed`);
  }

  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`Web routes OK: ${sourceRoutes.join(', ')}${built ? ' (source and build)' : ' (source; no build to check)'}`);
}
