import { z } from 'zod';

/**
 * D-31: in browsers the apps run under a Content-Security-Policy without 'unsafe-eval'. Zod probes for eval
 * (new Function) when it creates an object schema unless it is told not to compile parsers, and the browser
 * reports that probe as a policy violation. This module is imported before every schema of this package, so
 * in a browser no schema ever probes; validation works the same. Servers keep Zod's compiled parsers.
 */
if (typeof (globalThis as { window?: unknown }).window !== 'undefined') {
  z.config({ jitless: true });
}
