import { defineConfig } from 'vitest/config';

/** Opt-in live checks against real external services. Never part of `test` or `test:integration`. */
export default defineConfig({
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    include: ['test/**/*.live.test.ts'],
    testTimeout: 30_000,
  },
});
