/* global fetch, Headers, Response */
// Bedo Chat edge router (D-25): one public domain, https://bedochat.com, in front of three origins.
//
//   /api, /api/*      -> the API host, with the /api prefix removed (WebSocket upgrades pass through)
//   /admin, /admin/*  -> the Admin Dashboard's Netlify site (built under the /admin base path)
//   everything else   -> the student web app's Netlify site
//
// It only routes. Authentication, permissions, CSRF checks and sessions are all enforced by the API.
// Requests to the API carry the edge secret (EDGE_SECRET, a Worker secret), so the API can refuse
// anything that did not come through this Worker.

const API_PREFIX = '/api';
const ADMIN_PREFIX = '/admin';
const EDGE_SECRET_HEADER = 'x-bedo-edge-secret';

const isUnder = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

/** Which origin serves a public path, and the path to request there. */
export function route(pathname, env) {
  if (isUnder(pathname, API_PREFIX)) {
    return { origin: env.API_ORIGIN, path: pathname.slice(API_PREFIX.length) || '/' };
  }
  if (isUnder(pathname, ADMIN_PREFIX)) {
    return { origin: env.ADMIN_ORIGIN, path: pathname };
  }
  return { origin: env.WEB_ORIGIN, path: pathname };
}

/**
 * The URL to fetch: always on the configured origin, whatever the path looks like. A path such as
 * "//other.example/x" is kept as a path; it can never select another host. Returns null if it would.
 */
export function destinationUrl(origin, path, search) {
  const base = new URL(origin);
  const destination = new URL(base.origin);
  destination.pathname = path;
  destination.search = search;
  return destination.origin === base.origin ? destination : null;
}

/** An absolute redirect to the origin itself becomes the same place on the public domain; others are kept. */
export function publicLocation(location, origin, publicOrigin, publicPrefix) {
  let parsed;
  try {
    parsed = new URL(location, origin);
  } catch {
    return location;
  }
  if (parsed.origin !== new URL(origin).origin) {
    return location;
  }
  return `${publicOrigin}${publicPrefix}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export default {
  async fetch(request, env) {
    if (!env.WEB_ORIGIN || !env.ADMIN_ORIGIN || !env.API_ORIGIN || !env.EDGE_SECRET) {
      return new Response('Bedo Chat router is not configured.', { status: 500 });
    }
    const url = new URL(request.url);
    const target = route(url.pathname, env);
    const destination = destinationUrl(target.origin, target.path, url.search);
    if (!destination) {
      return new Response('Bad request.', { status: 400 });
    }
    const toApi = target.origin === env.API_ORIGIN;

    const headers = new Headers(request.headers);
    // The API limits sign-in codes per client IP. Pass only the address Cloudflare saw, never one the
    // client supplied (API_TRUST_PROXY_HOPS counts this router as one proxy).
    headers.delete('x-forwarded-for');
    const clientIp = request.headers.get('cf-connecting-ip');
    if (clientIp) {
      headers.set('x-forwarded-for', clientIp);
    }
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
    // Request ids are assigned by the API, not chosen by clients.
    headers.delete('x-request-id');
    // The edge secret goes to the API only, and only this Worker sets it.
    headers.delete(EDGE_SECRET_HEADER);
    if (toApi) {
      headers.set(EDGE_SECRET_HEADER, env.EDGE_SECRET);
    }

    // Upgrade requests (WebSockets, Phase 3) are passed through by fetch; the 101 response is returned as is.
    const response = await fetch(destination, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    });

    // Keep visitors on the public domain if an origin answers with an absolute redirect to itself.
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const rewritten = publicLocation(location, target.origin, url.origin, toApi ? API_PREFIX : '');
      if (rewritten !== location) {
        const answer = new Response(response.body, response);
        answer.headers.set('location', rewritten);
        return answer;
      }
    }
    return response;
  },
};
