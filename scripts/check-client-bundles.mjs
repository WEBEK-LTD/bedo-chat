// Fails the build if anything server-only reaches files served to browsers (spec §1, D-05).
// It scans every file in the web and admin apps' client output (static chunks, prerendered pages,
// and public/) for:
//   - the names of server-only environment variables (DATABASE_URL, REDIS_URL, WAABEK_API_KEY, ...)
//   - the values of those variables, taken from the environment running this check and from the
//     server .env files (apps/api/.env, apps/worker/.env, packages/db/.env) when present
//   - the Waabek API host, which only the backend may call
// Run it after `pnpm build`. Limits: pages rendered per request are not in the build output, and
// encoded or split values are not detected; server code must still never read secrets in components
// that run in the browser.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MIN_SECRET_VALUE_LENGTH = 8;
const SERVER_ENV_FILES = ['apps/api/.env', 'apps/worker/.env', 'packages/db/.env'];

/** Minimal KEY=VALUE reader for .env files (comments and blank lines ignored, optional quotes). */
export function parseEnvFile(content) {
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1));
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }
  return values;
}

export function buildNeedles(serverOnlyNames, ...envSources) {
  const sources = envSources.length > 0 ? envSources : [process.env];
  const needles = [...serverOnlyNames.map((name) => ({ label: `variable name ${name}`, text: name }))];
  const seen = new Set();
  for (const env of sources) {
    for (const name of serverOnlyNames) {
      const value = env[name];
      if (typeof value === 'string' && value.length >= MIN_SECRET_VALUE_LENGTH && !seen.has(value)) {
        seen.add(value);
        needles.push({ label: `value of ${name}`, text: value });
      }
    }
  }
  needles.push({ label: 'Waabek API host', text: 'waabek.com' });
  return needles;
}

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

/** Returns every (file, needle) match found under the given directories. */
export function scan(directories, needles) {
  const findings = [];
  let filesScanned = 0;
  for (const dir of directories) {
    for (const file of walkFiles(dir)) {
      filesScanned += 1;
      // latin1 keeps every byte, so ASCII secrets are found in any file type, binary or text.
      const content = readFileSync(file, 'latin1');
      for (const needle of needles) {
        if (content.includes(needle.text)) findings.push({ file, label: needle.label });
      }
    }
  }
  return { findings, filesScanned };
}

/** Directories whose files are sent to browsers: static chunks, prerendered pages and public assets. */
export function clientOutputDirs(appRoot) {
  const nextDir = path.join(appRoot, '.next');
  return [path.join(nextDir, 'static'), path.join(nextDir, 'server', 'app'), path.join(appRoot, 'public')].filter(
    (dir) => existsSync(dir) && statSync(dir).isDirectory(),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const { SERVER_ONLY_ENV_NAMES } = await import(pathToFileURL(path.join(repoRoot, 'packages/config/dist/index.js')).href);
  const envFiles = SERVER_ENV_FILES.map((file) => path.join(repoRoot, file))
    .filter((file) => existsSync(file))
    .map((file) => parseEnvFile(readFileSync(file, 'utf8')));
  const needles = buildNeedles(SERVER_ONLY_ENV_NAMES, process.env, ...envFiles);
  let failed = false;

  for (const app of ['web', 'admin']) {
    const appRoot = path.join(repoRoot, 'apps', app);
    if (!existsSync(path.join(appRoot, '.next', 'static'))) {
      console.error(`apps/${app} has no build output. Run \`pnpm build\` first.`);
      failed = true;
      continue;
    }
    const { findings, filesScanned } = scan(clientOutputDirs(appRoot), needles);
    if (findings.length > 0) {
      failed = true;
      for (const finding of findings) {
        console.error(`apps/${app}: ${finding.label} found in ${path.relative(repoRoot, finding.file)}`);
      }
    } else {
      console.log(`apps/${app}: ${filesScanned} client files scanned, no server-only data found.`);
    }
  }
  process.exit(failed ? 1 : 0);
}
