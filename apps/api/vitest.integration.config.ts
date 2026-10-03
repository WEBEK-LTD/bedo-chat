import { defineConfig } from 'vitest/config';

export default defineConfig({
  // NestJS uses TypeScript's legacy decorators with metadata, exactly as the tsc build emits them.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
