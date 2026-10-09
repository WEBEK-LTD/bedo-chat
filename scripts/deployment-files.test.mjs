// D-37: checks the deployment files Render and Cloudflare deploy from, without any account or network:
// render.yaml (Render Blueprint), the Supabase CA certificate the images carry, the two Dockerfiles, and the
// Cloudflare Worker's wrangler.toml and pinned Wrangler. The Blueprint's settings are run through the API's and the
// worker's own start-up validation (@bedo/config), exactly as the containers will see them.
import assert from 'node:assert/strict';
import { randomBytes, X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { apiEnvSchema, workerEnvSchema } from '../packages/config/src/index.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const blueprint = parse(read('render.yaml'));

// Values Render accepts (render.com/docs/blueprint-spec).
const REGIONS = new Set(['oregon', 'ohio', 'virginia', 'frankfurt', 'singapore']);
const SERVICE_PLANS = new Set(['0.5c-512mb', '1c-2g', '2c-4g', '2c-8g', '2c-16g', '4c-8g', '4c-16g', '4c-32g', '8c-16g', '8c-32g', '8c-64g']);
const KEY_VALUE_PLANS = new Set(['free', '256mb', '1g', '3g', '5g', '10g', '20g', '40g', '50g']);

const API = 'bedochat-api';
const WORKER = 'bedochat-worker';
const REDIS = 'bedochat-redis';
const CERT_IN_REPO = 'deploy/supabase/prod-ca-2021.crt';
const CERT_IN_IMAGE = '/app/certs/supabase-ca.crt';
const SUPABASE_CA_SHA256 = '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA';
const SUPABASE_POOLER_HOST = 'aws-0-ap-southeast-2.pooler.supabase.com';
const SUPABASE_PROJECT_REF = 'cspnnzoyuyxjiyhwzgqj';

const service = (name) => {
  const found = blueprint.services.find((item) => item.name === name);
  assert.ok(found, `render.yaml has no service ${name}`);
  return found;
};
const group = (name) => {
  const found = (blueprint.envVarGroups ?? []).find((item) => item.name === name);
  assert.ok(found, `render.yaml has no environment group ${name}`);
  return found;
};

/** How Render fills each kind of entry, for one Blueprint sync. */
function resolve(entries, { generated, prompted }) {
  const env = {};
  for (const entry of entries) {
    if (entry.fromGroup) {
      Object.assign(env, resolve(group(entry.fromGroup).envVars, { generated, prompted }));
      continue;
    }
    if (entry.generateValue) {
      // Render: "a randomized, base64-encoded, 256-bit value", generated once per variable.
      env[entry.key] = generated(entry);
    } else if (entry.sync === false) {
      env[entry.key] = prompted(entry.key);
    } else if (entry.fromService) {
      assert.equal(entry.fromService.type, 'keyvalue');
      assert.equal(entry.fromService.name, REDIS);
      assert.equal(entry.fromService.property, 'connectionString');
      env[entry.key] = 'redis://red-d3abcdefghijklmnopqr:6379';
    } else {
      env[entry.key] = entry.value;
    }
  }
  return env;
}

function renderEnvironments() {
  const values = new Map();
  const generated = (entry) => {
    if (!values.has(entry)) values.set(entry, randomBytes(32).toString('base64'));
    return values.get(entry);
  };
  const prompted = (key) => (key === 'PGPASSWORD' ? 'the bedo_api password' : assert.fail(`unexpected prompt for ${key}`));
  // NODE_ENV=production is set by both images (Dockerfile ENV).
  const api = { NODE_ENV: 'production', ...resolve(service(API).envVars, { generated, prompted }) };
  const worker = { NODE_ENV: 'production', ...resolve(service(WORKER).envVars, { generated, prompted }) };
  return { api, worker };
}

test('the Blueprint defines exactly Redis, the API and the worker, in Singapore', () => {
  assert.deepEqual(Object.keys(blueprint).sort(), ['envVarGroups', 'services']);
  assert.deepEqual(
    blueprint.services.map((item) => `${item.type}:${item.name}`),
    [`keyvalue:${REDIS}`, `web:${API}`, `worker:${WORKER}`],
  );
  for (const item of blueprint.services) {
    assert.equal(item.region, 'singapore', `${item.name} region`);
    assert.ok(REGIONS.has(item.region));
  }
});

test('Redis keeps queued jobs: noeviction, persistence on, no internet access', () => {
  const redis = service(REDIS);
  assert.ok(KEY_VALUE_PLANS.has(redis.plan));
  assert.notEqual(redis.plan, 'free', 'the free plan has no persistence');
  assert.equal(redis.maxmemoryPolicy, 'noeviction');
  assert.equal(redis.persistenceMode, 'journal-snapshot');
  assert.deepEqual(redis.ipAllowList, []);
});

test('the API and the worker are built from the existing Dockerfiles, never deployed automatically', () => {
  for (const name of [API, WORKER]) {
    const item = service(name);
    assert.equal(item.runtime, 'docker');
    assert.ok(SERVICE_PLANS.has(item.plan), `${name} plan`);
    assert.equal(item.dockerContext, '.');
    assert.ok(existsSync(path.join(root, item.dockerfilePath)), `${name}: ${item.dockerfilePath} exists`);
    assert.equal(item.autoDeployTrigger, 'off');
    assert.equal(item.repo, undefined, 'the repository is the one holding this Blueprint');
    assert.ok(item.maxShutdownDelaySeconds >= 30);
  }
  assert.equal(service(API).dockerfilePath, './apps/api/Dockerfile');
  assert.equal(service(WORKER).dockerfilePath, './apps/worker/Dockerfile');
  assert.equal(service(API).healthCheckPath, '/health/ready');
  assert.equal(service(WORKER).healthCheckPath, undefined, 'health checks are for web services only');
});

test('every environment entry is one well-formed kind; the only value asked for is the database password', () => {
  const entries = [...blueprint.envVarGroups.flatMap((item) => item.envVars), ...[API, WORKER].flatMap((name) => service(name).envVars)];
  const asked = [];
  for (const entry of entries) {
    const kinds = ['value', 'generateValue', 'sync', 'fromService', 'fromGroup'].filter((kind) => entry[kind] !== undefined);
    assert.equal(kinds.length, 1, `one kind per entry: ${JSON.stringify(entry)}`);
    if (entry.value !== undefined) assert.equal(typeof entry.value, 'string', `${entry.key} is a string`);
    if (entry.generateValue !== undefined) assert.equal(entry.generateValue, true);
    if (entry.sync !== undefined) {
      assert.equal(entry.sync, false);
      asked.push(entry.key);
    }
  }
  assert.deepEqual(asked, ['PGPASSWORD', 'PGPASSWORD'], 'Render asks only for the bedo_api password (API and worker)');
  for (const item of blueprint.envVarGroups) {
    assert.ok(item.envVars.every((entry) => entry.sync === undefined), 'Render ignores sync:false in groups');
  }
});

test('no secret and no switched-off setting is written in the Blueprint', () => {
  const text = read('render.yaml');
  const { api, worker } = renderEnvironments();
  for (const forbidden of ['WAABEK_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) {
    assert.ok(!(forbidden in api) && !(forbidden in worker), `${forbidden} is not set`);
  }
  for (const secret of ['ACCESS_TOKEN_SECRET', 'OTP_HMAC_SECRET', 'ADMIN_TOTP_KEY', 'SETTINGS_ENCRYPTION_KEY', 'EDGE_SECRET']) {
    const entry = [...blueprint.envVarGroups.flatMap((item) => item.envVars), ...service(API).envVars].find((item) => item.key === secret);
    assert.equal(entry?.generateValue, true, `${secret} is generated by Render`);
  }
  assert.equal(new URL(api.DATABASE_URL).password, '', 'DATABASE_URL holds no password');
  assert.doesNotMatch(text, /:\/\/[^/\s@]+:[^/\s@]+@/, 'no URL with a password');
});

test('the Blueprint settings pass the API and worker start-up validation (production)', () => {
  const { api, worker } = renderEnvironments();
  const apiResult = apiEnvSchema.safeParse(api);
  assert.ok(apiResult.success, `API environment: ${JSON.stringify(apiResult.error?.issues)}`);
  const workerResult = workerEnvSchema.safeParse(worker);
  assert.ok(workerResult.success, `worker environment: ${JSON.stringify(workerResult.error?.issues)}`);

  // No misspelled variable that the apps would silently ignore.
  const apiKnown = new Set([...Object.keys(apiEnvSchema.shape), 'PORT', 'PGPASSWORD']);
  const workerKnown = new Set([...Object.keys(workerEnvSchema.shape), 'PGPASSWORD']);
  assert.deepEqual(Object.keys(api).filter((key) => !apiKnown.has(key)), []);
  assert.deepEqual(Object.keys(worker).filter((key) => !workerKnown.has(key)), []);

  // The API and the worker share one settings key (the worker decrypts what the API encrypts).
  assert.equal(api.SETTINGS_ENCRYPTION_KEY, worker.SETTINGS_ENCRYPTION_KEY);
  assert.equal(api.DATABASE_URL, worker.DATABASE_URL);
  assert.equal(api.REDIS_URL, worker.REDIS_URL);
  assert.equal(api.QUEUE_PREFIX, worker.QUEUE_PREFIX);
  // Render routes to the port the API listens on (API_PORT 4000 in the image).
  assert.equal(api.PORT, '4000');
  assert.match(read('apps/api/Dockerfile'), /API_PORT=4000/);
  assert.equal(apiResult.data.API_TRUST_PROXY_HOPS, 2);
  assert.deepEqual(apiResult.data.CORS_ALLOWED_ORIGINS, ['https://bedochat.com']);
  assert.equal(apiResult.data.API_PUBLIC_PATH, '/api');
  // Supabase session pooler: API 5 + worker 3, and 5 more while a new API version starts, within the pool of 15.
  assert.ok(apiResult.data.DATABASE_POOL_MAX * 2 + workerResult.data.DATABASE_POOL_MAX <= 15);
});

test('the database is the Sydney project, as bedo_api, over the session pooler with full certificate checking', () => {
  const { api } = renderEnvironments();
  const url = new URL(api.DATABASE_URL);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, SUPABASE_POOLER_HOST);
  assert.equal(url.port, '5432', 'session pooler, never the transaction pooler (6543)');
  assert.equal(decodeURIComponent(url.username), `bedo_api.${SUPABASE_PROJECT_REF}`);
  assert.equal(url.pathname, '/postgres');
  assert.equal(url.searchParams.get('sslmode'), 'verify-full');
  assert.equal(url.searchParams.get('sslrootcert'), CERT_IN_IMAGE);
});

test('both images carry the Supabase CA certificate at the path DATABASE_URL names, or fail to build', () => {
  for (const file of ['apps/api/Dockerfile', 'apps/worker/Dockerfile']) {
    const dockerfile = read(file);
    assert.match(dockerfile, /^WORKDIR \/app$/m, `${file}: the image's folder is /app`);
    assert.match(dockerfile, /^COPY --from=build --chown=node:node \/out \.\/$/m, `${file}: /out becomes /app`);
    assert.ok(
      dockerfile.includes(`RUN grep -q -- '-----BEGIN CERTIFICATE-----' ${CERT_IN_REPO} \\\n && mkdir -p /out/certs && cp ${CERT_IN_REPO} /out/certs/supabase-ca.crt`),
      `${file}: copies ${CERT_IN_REPO} to ${CERT_IN_IMAGE} and stops without it`,
    );
  }
  assert.doesNotMatch(read('.dockerignore'), /^deploy\b/m, 'the certificate is part of the build context');
});

test('the Supabase CA certificate is a valid, self-signed Supabase root certificate', () => {
  assert.ok(existsSync(path.join(root, CERT_IN_REPO)), `${CERT_IN_REPO} is missing: download it from Supabase (Project Settings -> Database -> SSL Configuration)`);
  const pem = read(CERT_IN_REPO);
  assert.equal((pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length, 1, 'exactly one certificate');
  assert.doesNotMatch(pem, /PRIVATE KEY/);
  const cert = new X509Certificate(pem);
  assert.equal(cert.ca, true, 'a CA certificate');
  assert.equal(cert.subject, cert.issuer, 'self-signed root');
  assert.ok(cert.verify(cert.publicKey), 'its signature is valid');
  assert.match(cert.subject, /^CN=Supabase Root 2021 CA$/m);
  assert.match(cert.subject, /^O=Supabase Inc$/m);
  // The certificate downloaded from the Bedo Chat project's dashboard (Project Settings -> Database -> SSL
  // Configuration) on 2026-10-08. A different file fails here until this value is updated on purpose.
  assert.equal(cert.fingerprint256, SUPABASE_CA_SHA256, 'the Supabase CA certificate from the project dashboard');
  const now = Date.now();
  assert.ok(Date.parse(cert.validFrom) <= now && now < Date.parse(cert.validTo), `valid now (until ${cert.validTo})`);
});

test('the Cloudflare Worker deploys from GitHub with fixed origins and a pinned Wrangler', () => {
  const toml = read('deploy/cloudflare/wrangler.toml');
  const value = (key) => toml.match(new RegExp(`^${key} = "([^"]*)"$`, 'm'))?.[1];
  assert.equal(value('name'), 'bedochat-router');
  assert.equal(value('main'), 'worker.js');
  assert.ok(existsSync(path.join(root, 'deploy/cloudflare/worker.js')));
  assert.match(toml, /^ {2}\{ pattern = "bedochat\.com", custom_domain = true \},$/m);
  assert.equal(value('WEB_ORIGIN'), 'https://bedochat.netlify.app');
  assert.equal(value('ADMIN_ORIGIN'), 'https://bedochat.netlify.app');
  assert.equal(value('API_ORIGIN'), `https://${API}.onrender.com`, 'the Render API service in render.yaml');
  assert.doesNotMatch(toml, /REPLACE|example/i, 'no placeholder left');
  assert.doesNotMatch(toml, /^EDGE_SECRET\s*=/m, 'EDGE_SECRET is a Worker secret, never in the file');

  const pkg = JSON.parse(read('deploy/cloudflare/package.json'));
  const lock = JSON.parse(read('deploy/cloudflare/package-lock.json'));
  assert.match(pkg.devDependencies.wrangler, /^\d+\.\d+\.\d+$/, 'an exact Wrangler version');
  assert.equal(lock.packages['node_modules/wrangler'].version, pkg.devDependencies.wrangler);
  assert.equal(lock.packages[''].devDependencies.wrangler, pkg.devDependencies.wrangler);
  assert.ok(!('dependencies' in pkg), 'the Worker itself has no dependencies');
});
