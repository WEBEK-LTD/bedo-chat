/* eslint-disable no-console -- a Netlify Function logs to the console (shown in the site's function logs). */
/**
 * Phase 6 (D-40): the scheduled Netlify function that sends scheduled messages and channel posts on time. Every
 * minute Netlify runs it; it asks the site's own API to send what is due (POST /api/v1/internal/dispatch). The API
 * does the work and the checks; this function only proves it is the scheduler, with an HMAC of a fixed purpose
 * made from the API's ACCESS_TOKEN_SECRET (a server variable the function shares; never sent anywhere else).
 *
 * Between runs, ordinary API requests also send due messages (at most every five seconds per server instance),
 * so a message is usually out within seconds of its time and at most about a minute late when the site is idle.
 * Netlify runs scheduled functions on the published production deploy only.
 */
import { createHmac } from 'node:crypto';

const DISPATCH_PURPOSE = 'bedo scheduled dispatch v1';

export default async function scheduler(): Promise<Response> {
  const secret = process.env.ACCESS_TOKEN_SECRET;
  const site = process.env.URL;
  if (!secret || !site) {
    console.error('Scheduled messages: ACCESS_TOKEN_SECRET or URL is not set for functions; nothing was sent.');
    return new Response(null, { status: 500 });
  }
  const token = createHmac('sha256', secret).update(DISPATCH_PURPOSE).digest('hex');
  const response = await fetch(new URL('/api/v1/internal/dispatch', site), {
    method: 'POST',
    headers: { 'x-bedo-dispatch': token },
    signal: AbortSignal.timeout(25_000),
  });
  const result = await response.text();
  if (!response.ok) {
    console.error(`Scheduled messages: the API answered HTTP ${response.status}.`);
  } else {
    console.log(`Scheduled messages: ${result}`);
  }
  return new Response(null, { status: response.ok ? 200 : 502 });
}

export const config = { schedule: '* * * * *' };
