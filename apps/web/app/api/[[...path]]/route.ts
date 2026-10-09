import { handleApiRequest } from '@bedo/api/serverless';
import { after } from 'next/server';

/**
 * D-36: the Bedo Chat API, served by this website at /api/* (https://bedochat.com/api/...). Every request is
 * answered by the API application in this same server function; there is no separate API host. Work the API
 * continues after the response (one-time codes, push, realtime signals, housekeeping) is kept alive with
 * after(), which Netlify backs with waitUntil.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function handle(request: Request): Promise<Response> {
  return handleApiRequest(request, { after: (work) => after(work) });
}

export { handle as DELETE, handle as GET, handle as HEAD, handle as OPTIONS, handle as PATCH, handle as POST, handle as PUT };
